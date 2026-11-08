/**
 * Linear issue tracking, the handlers.
 *
 * Every call into `server-core/linear` here is user-initiated, so those
 * helpers throw rather than swallow; {@link linearCall} maps a thrown
 * `LinearApiError` onto a status and message the client can use, and anything
 * else onto the route's own logged 500.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  LinearApiError,
  createLinearIssue,
  deleteLinearIntegration,
  getLinearIntegration,
  listLinearIssueLinks,
  listLinearTeams,
  recordLinearIssueLink,
  removeLinearWebhook,
  reserveLinearWebhookUrl,
  setLinearIntegration,
  setupLinearWebhook,
  verifyLinearCredentials,
  verifyStoredLinearCredentials,
} from "@infrawrench/server-core/linear";
import { refreshOrgIssueStatuses } from "@infrawrench/server-core/issue-status/sync";
import {
  BadGateway,
  BadRequest,
  CreateLinearIssueResult,
  IssueStatusRefreshResult,
  IssueWebhookSetupResult,
  LinearApi,
  LinearIntegration,
  LinearIntegrationResponse,
  LinearIssueLinks,
  LinearTeams,
  LinearVerifyInput,
  LinearVerifyResult,
  LinearWebhookInput,
  LinearWebhookUrl,
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
 * The Jira split: 400 is "fix your input" (a missing key, a team the
 * workspace rejected), 502 is "Linear itself is unhappy" (a revoked key, an
 * outage). Linear reports rate limiting and validation as GraphQL errors on
 * an HTTP 400, so a 400 *from Linear* still lands on 400, in Linear's words.
 * No status means Linear was never reached.
 */
const linearRefusal = (error: unknown) => {
  if (!(error instanceof LinearApiError)) return undefined;
  return error.status === null || error.status === 400 || error.status === 422
    ? new BadRequest({ error: error.message })
    : new BadGateway({ error: error.message });
};

/** A call the route wrapped in `try`: refusals mapped, anything else a logged 500. */
const linearCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, linearRefusal).pipe(
    unexpectedAs({ logPrefix: "[linear]", failure: "Linear request failed" }),
  );

const LinearHandlers = HttpApiBuilder.group(LinearApi, "linear", (handlers) =>
  handlers
    // `linear:read`: members need to know whether filing is available at
    // all, and the response deliberately holds nothing secret.
    .handle("get", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const integration = yield* legacy(() => getLinearIntegration(organizationId));
        return yield* respond(LinearIntegrationResponse)({ integration });
      }),
    )
    .handle("configure", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const integration = yield* linearCall(() =>
          setLinearIntegration({
            organizationId,
            userId: session.userId,
            apiKey: payload.apiKey,
            defaultTeamId: payload.defaultTeamId,
            acknowledgeOnDone: payload.acknowledgeOnDone,
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "linear.configure",
            entityType: "linear_integration",
            entityId: organizationId,
            // Never the key (the audit log is readable by every holder of
            // `audit:read`): only whether it changed, and the default team.
            metadata: {
              keyChanged: payload.apiKey !== undefined,
              defaultTeamId: integration.defaultTeamId,
              acknowledgeOnDone: integration.acknowledgeOnDone,
            },
          }),
        );
        return yield* respond(LinearIntegration)(integration);
      }),
    )
    // Existing issue links are kept.
    .handle("disconnect", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const existed = yield* legacy(() => deleteLinearIntegration(organizationId));
        if (!existed) return yield* notFound("Linear is not connected");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "linear.delete",
            entityType: "linear_integration",
            entityId: organizationId,
          }),
        );
        return ok;
      }),
    )
    // A key in the body tests one typed but not saved yet, so Save can say
    // it is wrong at once; an empty body re-tests the stored one.
    .handleRaw("verify", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const raw = yield* readJsonOr(request, {});
        const { apiKey } = yield* decodeAsPayload(LinearVerifyInput, raw ?? {});
        const user = yield* linearCall(() =>
          apiKey ? verifyLinearCredentials(apiKey) : verifyStoredLinearCredentials(organizationId),
        );
        return yield* respond(LinearVerifyResult)({ ok: true, ...user });
      }),
    )
    // `linear:read`: this also backs showing a team id as a name in settings.
    .handle("teams", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const teams = yield* linearCall(() => listLinearTeams(organizationId));
        return yield* respond(LinearTeams)(teams);
      }),
    )
    // The issue first, then the link, as on Jira: a failed create leaves no
    // link claiming an issue that does not exist.
    .handle("fileIssue", ({ payload: body }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { issue, link } = yield* linearCall(async () => {
          const issue = await createLinearIssue({
            organizationId,
            teamId: body.teamId,
            title: body.title,
            description: body.description,
            labelIds: body.labelIds ? [...body.labelIds] : undefined,
            projectId: body.projectId,
          });
          const link = await recordLinearIssueLink({
            organizationId,
            userId: session.userId,
            sourceKind: body.sourceKind,
            sourceId: body.sourceId,
            issueIdentifier: issue.identifier,
            issueUrl: issue.url,
            issueId: issue.id,
          });
          return { issue, link };
        });
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "linear.issue.create",
            entityType: "linear_issue_link",
            entityId: link.id,
            metadata: {
              sourceKind: body.sourceKind,
              sourceId: body.sourceId,
              issueIdentifier: issue.identifier,
              teamId: body.teamId,
            },
          }),
        );
        return yield* respond(CreateLinearIssueResult)({ issue, link });
      }),
    )
    // The batch lookup a list view makes once before rendering.
    .handle("links", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const links = yield* legacy(() =>
          listLinearIssueLinks(organizationId, {
            sourceKind: query.sourceKind,
            sourceIds: query.sourceId ? [...query.sourceId] : undefined,
          }),
        );
        return yield* respond(LinearIssueLinks)(links);
      }),
    )
    // `auto` creates it in Linear with our own signing secret (workspace
    // admins only); `manual` records one somebody made at the URL from
    // `POST /webhook/url`, with the secret Linear showed them.
    .handleRaw("setupWebhook", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const input = yield* decodeAsPayload(LinearWebhookInput, yield* readJsonOr(request, {}));
        const result = yield* linearCall(() => setupLinearWebhook(organizationId, input));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "linear.webhook.configure",
            entityType: "linear_integration",
            entityId: organizationId,
            metadata: { mode: result.integration.webhook.mode },
          }),
        );
        return yield* respond(IssueWebhookSetupResult)({ webhook: result.integration.webhook });
      }),
    )
    // Linear shows the signing secret only once the webhook exists, so the
    // URL to paste comes first.
    .handle("webhookUrl", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const url = yield* linearCall(() => reserveLinearWebhookUrl(organizationId));
        return yield* respond(LinearWebhookUrl)({ url });
      }),
    )
    // Live status stops; the poll carries on.
    .handle("removeWebhook", () =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* linearCall(() => removeLinearWebhook(organizationId));
        if (!removed) return yield* notFound("No status webhook is set up");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "linear.webhook.delete",
            entityType: "linear_integration",
            entityId: organizationId,
          }),
        );
        return ok;
      }),
    )
    .handle("refreshLinks", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* linearCall(() => refreshOrgIssueStatuses(organizationId, "linear"));
        return yield* respond(IssueStatusRefreshResult)(result);
      }),
    ),
);

export const linearDomain = makeDomain("linear", LinearApi, LinearHandlers);
