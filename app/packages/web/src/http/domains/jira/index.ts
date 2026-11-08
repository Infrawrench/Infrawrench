/**
 * Jira issue tracking, the handlers.
 *
 * Every call into `server-core/jira` here is user-initiated, so those helpers
 * throw rather than swallow; {@link jiraCall} maps a thrown `JiraApiError`
 * onto a status the client can branch on and a message it can render
 * verbatim, and anything else onto the route's own logged 500.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  JiraApiError,
  createJiraIssue,
  deleteJiraIntegration,
  getJiraIntegration,
  listJiraIssueLinks,
  listJiraIssueTypes,
  listJiraProjects,
  recordJiraIssueLink,
  removeJiraWebhook,
  setJiraIntegration,
  setupJiraWebhook,
  verifyJiraCredentials,
  verifyStoredJiraCredentials,
} from "@infrawrench/server-core/jira";
import { refreshOrgIssueStatuses } from "@infrawrench/server-core/issue-status/sync";
import {
  BadGateway,
  BadRequest,
  CreateJiraIssueResult,
  IssueStatusRefreshResult,
  IssueWebhookSetupResult,
  JiraApi,
  JiraIntegration,
  JiraIntegrationResponse,
  JiraIssueLinks,
  JiraIssueTypes,
  JiraProjects,
  JiraVerifyInput,
  JiraVerifyResult,
  JiraWebhookInput,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { decodeAsPayload, readJsonOr } from "../../request-body";
import { unexpectedAs } from "../../refusals";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/**
 * 400 means "fix your input and try again" (bad site URL, missing token, a
 * project that rejected the fields); 502 means "Jira itself is unhappy" (a
 * revoked token, a permission the account lacks, an outage). Both carry
 * Jira's wording, the only thing that tells the user what to do next. No
 * status means Jira was never reached: a local check or an unreachable host,
 * both the caller's to fix.
 */
const jiraRefusal = (error: unknown) => {
  if (!(error instanceof JiraApiError)) return undefined;
  return error.status === null || error.status === 400 || error.status === 422
    ? new BadRequest({ error: error.message })
    : new BadGateway({ error: error.message });
};

/** A call the route wrapped in `try`: refusals mapped, anything else a logged 500. */
const jiraCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, jiraRefusal).pipe(
    unexpectedAs({ logPrefix: "[jira]", failure: "Jira request failed" }),
  );

const JiraHandlers = HttpApiBuilder.group(JiraApi, "jira", (handlers) =>
  handlers
    // `jira:read`: members need to know whether filing is available at all,
    // and the response deliberately holds nothing secret.
    .handle("get", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const integration = yield* legacy(() => getJiraIntegration(organizationId));
        return yield* respond(JiraIntegrationResponse)({ integration });
      }),
    )
    .handle("configure", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const integration = yield* jiraCall(() =>
          setJiraIntegration({
            organizationId,
            userId: session.userId,
            siteUrl: payload.siteUrl,
            accountEmail: payload.accountEmail,
            apiToken: payload.apiToken,
            defaultProjectKey: payload.defaultProjectKey,
            defaultIssueTypeId: payload.defaultIssueTypeId,
            acknowledgeOnDone: payload.acknowledgeOnDone,
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "jira.configure",
            entityType: "jira_integration",
            entityId: organizationId,
            // Site and account only. The token must not reach the audit log,
            // which every holder of `audit:read` can read.
            metadata: {
              siteUrl: integration.siteUrl,
              accountEmail: integration.accountEmail,
              tokenChanged: payload.apiToken !== undefined,
              defaultProjectKey: integration.defaultProjectKey,
              acknowledgeOnDone: integration.acknowledgeOnDone,
            },
          }),
        );
        return yield* respond(JiraIntegration)(integration);
      }),
    )
    // Existing issue links are kept.
    .handle("disconnect", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const existed = yield* legacy(() => deleteJiraIntegration(organizationId));
        if (!existed) return yield* notFound("Jira is not connected");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "jira.delete",
            entityType: "jira_integration",
            entityId: organizationId,
          }),
        );
        return ok;
      }),
    )
    // A full triple tests credentials typed but not saved yet, so Save can say
    // the token is wrong at once; an empty body re-tests the stored ones.
    .handleRaw("verify", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const raw = yield* readJsonOr(request, {});
        const { siteUrl, accountEmail, apiToken } = yield* decodeAsPayload(
          JiraVerifyInput,
          raw ?? {},
        );
        const account = yield* jiraCall(() =>
          siteUrl && accountEmail && apiToken
            ? verifyJiraCredentials({ siteUrl, accountEmail, apiToken })
            : verifyStoredJiraCredentials(organizationId),
        );
        return yield* respond(JiraVerifyResult)({ ok: true, ...account });
      }),
    )
    // `jira:read`: this also backs showing a project key as a name in a list view.
    .handle("projects", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const projects = yield* jiraCall(() => listJiraProjects(organizationId));
        return yield* respond(JiraProjects)(projects);
      }),
    )
    .handle("issueTypes", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const types = yield* jiraCall(() => listJiraIssueTypes(organizationId, params.key));
        return yield* respond(JiraIssueTypes)(types);
      }),
    )
    // The issue first, then the link: the reverse would leave a link claiming
    // an issue that does not exist if the create failed. The worst case as it
    // stands is an offer to file again, which is visible and recoverable.
    .handle("fileIssue", ({ payload: body }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { issue, link } = yield* jiraCall(async () => {
          const issue = await createJiraIssue({
            organizationId,
            projectKey: body.projectKey,
            issueTypeId: body.issueTypeId,
            summary: body.summary,
            description: body.description,
            labels: body.labels ? [...body.labels] : undefined,
          });
          const link = await recordJiraIssueLink({
            organizationId,
            userId: session.userId,
            sourceKind: body.sourceKind,
            sourceId: body.sourceId,
            issueKey: issue.key,
            issueUrl: issue.url,
            issueId: issue.id,
          });
          return { issue, link };
        });
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "jira.issue.create",
            entityType: "jira_issue_link",
            entityId: link.id,
            metadata: {
              sourceKind: body.sourceKind,
              sourceId: body.sourceId,
              issueKey: issue.key,
              projectKey: body.projectKey,
            },
          }),
        );
        return yield* respond(CreateJiraIssueResult)({ issue, link });
      }),
    )
    // The batch lookup a list view makes once: a repeated `sourceId` narrows
    // to those findings, none returns every link of the kind.
    .handle("links", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const links = yield* legacy(() =>
          listJiraIssueLinks(organizationId, {
            sourceKind: query.sourceKind,
            sourceIds: query.sourceId ? [...query.sourceId] : undefined,
          }),
        );
        return yield* respond(JiraIssueLinks)(links);
      }),
    )
    // `auto` registers it through the stored account (Jira admins only); a
    // refusal falls back to manual with the URL and a one-time secret, which
    // is never returned again.
    .handleRaw("setupWebhook", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { mode } = yield* decodeAsPayload(JiraWebhookInput, yield* readJsonOr(request, {}));
        const result = yield* jiraCall(() => setupJiraWebhook(organizationId, mode));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "jira.webhook.configure",
            entityType: "jira_integration",
            entityId: organizationId,
            // Never the secret.
            metadata: { mode: result.integration.webhook.mode, requested: mode },
          }),
        );
        return yield* respond(IssueWebhookSetupResult)({
          webhook: result.integration.webhook,
          ...(result.secret ? { secret: result.secret } : {}),
          ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
        });
      }),
    )
    // Live status stops; the poll carries on.
    .handle("removeWebhook", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* jiraCall(() => removeJiraWebhook(organizationId));
        if (!removed) return yield* notFound("No status webhook is set up");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "jira.webhook.delete",
            entityType: "jira_integration",
            entityId: organizationId,
          }),
        );
        return ok;
      }),
    )
    // `jira:read`: it changes nothing but our copy of what Jira already shows
    // anyone who can open the issues.
    .handle("refreshLinks", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* jiraCall(() => refreshOrgIssueStatuses(organizationId, "jira"));
        return yield* respond(IssueStatusRefreshResult)(result);
      }),
    ),
);

export const jiraDomain = makeDomain("jira", JiraApi, JiraHandlers);
