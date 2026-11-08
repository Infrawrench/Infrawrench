/**
 * GitHub issue filing, the handlers. Every GitHub call mints an installation
 * token server-side (`server-core/github-issues/*`).
 */
import { Data, Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getInstallationAccess, isGithubAppConfigured } from "@infrawrench/server-core/github/app";
import {
  GithubApiError,
  isRepoFullName,
  listAssignees,
  listBranches,
  listLabels,
} from "@infrawrench/server-core/github/issues-api";
import {
  GithubIssueSettingsError,
  getGithubIssueSettings,
  listInstallationAccess,
  orgInstallationIds,
  setGithubIssueSettings,
} from "@infrawrench/server-core/github-issues/settings";
import {
  GithubFilingError,
  fileFindingToGithub,
  listGithubIssueLinks,
  resolveFindingRoute,
} from "@infrawrench/server-core/github-issues/filing";
import {
  IacPullRequestRefused,
  openIacPullRequest,
  previewIacPullRequest,
} from "@infrawrench/server-core/github-issues/pull-request";
import { appPath } from "@infrawrench/server-core/app-url";
import { refreshOrgIssueStatuses } from "@infrawrench/server-core/issue-status/sync";
import {
  BadGateway,
  BadRequest,
  badRequest,
  FileGithubIssueResult,
  GithubAssignees,
  GithubBranches,
  GithubIssueLinks,
  GithubIssuesApi,
  GithubIssueSettings,
  GithubIssuesStatus,
  GithubLabels,
  GithubPermissionRequired,
  GithubPullRequestPreview,
  GithubPullRequestResult,
  IssueStatusRefreshResult,
  RouteResolution,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { unexpectedAs } from "../../refusals";

/** An installation lacking a permission: answered once its manage URL is looked up. */
class NeedsPermission extends Data.TaggedError("NeedsPermission")<{
  readonly cause: GithubApiError;
  readonly permission: string;
}> {}

/** A filing refusal whose status no declared error carries: sent as `{ error }` with it. */
class PlainRefusal extends Data.TaggedError("PlainRefusal")<{
  readonly status: number;
  readonly message: string;
}> {}

/** A failure as the status the client branches on. */
function githubRefusal(
  error: unknown,
): NeedsPermission | PlainRefusal | BadRequest | BadGateway | undefined {
  if (error instanceof GithubApiError) {
    if (error.missingPermission) {
      return new NeedsPermission({ cause: error, permission: error.missingPermission });
    }
    const status = error.status !== null && [400, 404, 410, 422].includes(error.status) ? 400 : 502;
    return status === 400
      ? new BadRequest({ error: error.message })
      : new BadGateway({ error: error.message });
  }
  if (error instanceof GithubFilingError) {
    if (error.status === 400) return new BadRequest({ error: error.message });
    if (error.status === 502) return new BadGateway({ error: error.message });
    // 404 and 409 (filing turned off) keep the `{ error }` body they always had.
    return new PlainRefusal({ status: error.status, message: error.message });
  }
  if (error instanceof GithubIssueSettingsError || error instanceof IacPullRequestRefused) {
    return new BadRequest({ error: error.message });
  }
  return undefined;
}

/**
 * A call the route wrapped in `try`: refusals mapped as above, a missing
 * permission answered with the structured 409, anything else a logged 500.
 */
const githubCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, githubRefusal).pipe(
    Effect.catchTag("NeedsPermission", ({ cause, permission }) =>
      Effect.gen(function* () {
        const access = yield* legacy(() =>
          getInstallationAccess(cause.installationId).catch(() => null),
        );
        return yield* new GithubPermissionRequired({
          error: cause.message,
          code: "github_permission_required",
          permissions: [permission],
          installationId: cause.installationId,
          accountLogin: access?.accountLogin ?? null,
          manageUrl: access?.htmlUrl ?? null,
        });
      }),
    ),
    unexpectedAs({ logPrefix: "[github-issues]", failure: "GitHub request failed" }),
    Effect.catchTag("PlainRefusal", ({ status, message }) =>
      Effect.die(new HttpFailure(status, { error: message })),
    ),
  );

/**
 * The repository a picker names, or null when it is unreadable, not
 * `owner/name`, or under an installation this org has not connected. The
 * zod checks it replaces: a positive integer id (coerced) and a 3 to 201
 * character name.
 */
const repoFromQuery = (query: { readonly installationId?: unknown; readonly repo?: unknown }) =>
  Effect.gen(function* () {
    const { organizationId } = yield* OrgPrincipal;
    const installationId = Number(query.installationId);
    const repo = query.repo;
    if (!Number.isInteger(installationId) || installationId <= 0) return null;
    if (!Predicate.isString(repo) || repo.length < 3 || repo.length > 201) return null;
    if (!isRepoFullName(repo)) return null;
    const installs = yield* legacy(() => orgInstallationIds(organizationId));
    if (!installs.has(installationId)) return null;
    return { installationId, repo };
  });

const GithubIssuesHandlers = HttpApiBuilder.group(GithubIssuesApi, "githubIssues", (handlers) =>
  handlers
    // Settings plus what each installation has accepted.
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const [settings, installations] = yield* legacy(() =>
          Promise.all([
            getGithubIssueSettings(organizationId),
            listInstallationAccess(organizationId),
          ]),
        );
        return yield* respond(GithubIssuesStatus)({
          appConfigured: isGithubAppConfigured(),
          installations,
          settings,
          // Live status comes from the App's `issues` webhook when the server
          // can verify it; the poll keeps statuses current either way.
          webhookConfigured: Boolean(process.env["GITHUB_APP_WEBHOOK_SECRET"]),
          webhookUrl: appPath("/api/issue-webhooks/github"),
        });
      }),
    )
    // Replace the whole document.
    .handle("updateSettings", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const saved = yield* githubCall(() =>
          setGithubIssueSettings(organizationId, payload, session.userId),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "github_issues.configure",
            entityType: "github_issue_settings",
            entityId: organizationId,
            metadata: {
              enabled: saved.enabled,
              defaultRepo: saved.defaultRepo?.fullName ?? null,
              routes: saved.routes.length,
              pullRequestsEnabled: saved.pullRequestsEnabled,
              iacSources: saved.iacSources.length,
              acknowledgeOnDone: saved.acknowledgeOnDone ?? false,
            },
          }),
        );
        return yield* respond(GithubIssueSettings)(saved);
      }),
    )
    .handle("labels", ({ query }) =>
      Effect.gen(function* () {
        const repo = yield* repoFromQuery(query);
        if (!repo) return yield* badRequest("Unknown repository");
        const labels = yield* githubCall(() => listLabels(repo.installationId, repo.repo));
        return yield* respond(GithubLabels)(labels);
      }),
    )
    .handle("assignees", ({ query }) =>
      Effect.gen(function* () {
        const repo = yield* repoFromQuery(query);
        if (!repo) return yield* badRequest("Unknown repository");
        const assignees = yield* githubCall(() => listAssignees(repo.installationId, repo.repo));
        return yield* respond(GithubAssignees)(assignees);
      }),
    )
    // The base-branch picker for Terraform sources.
    .handle("branches", ({ query }) =>
      Effect.gen(function* () {
        const repo = yield* repoFromQuery(query);
        if (!repo) return yield* badRequest("Unknown repository");
        const branches = yield* githubCall(() => listBranches(repo.installationId, repo.repo));
        return yield* respond(GithubBranches)(branches);
      }),
    )
    // Where a finding about this resource would go.
    .handle("route", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const resourceId = query.resourceId || undefined;
        const route = yield* legacy(() => resolveFindingRoute(organizationId, resourceId));
        return yield* respond(RouteResolution)(route);
      }),
    )
    // File a finding, or comment on its open issue.
    .handle("fileIssue", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const { repo, labels, assignees, details, ...rest } = payload;
        // The finding's evidence rows always carry a `value` key, present or not.
        const finding = {
          ...rest,
          ...(details ? { details: details.map((d) => ({ label: d.label, value: d.value })) } : {}),
        };
        const result = yield* githubCall(() =>
          fileFindingToGithub(organizationId, finding, {
            userId: session.userId,
            autoFiled: false,
            repo,
            labels,
            assignees,
          }),
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action:
              result.action === "created"
                ? "github_issues.issue.create"
                : "github_issues.issue.comment",
            entityType: "github_issue_link",
            entityId: result.link.id,
            metadata: {
              sourceKind: finding.sourceKind,
              sourceId: finding.sourceId,
              repo: result.link.repo,
              issueNumber: result.link.issueNumber,
            },
          }),
        );
        return yield* respond(FileGithubIssueResult)(result);
      }),
    )
    // The batch lookup a list makes once.
    .handle("links", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const links = yield* legacy(() =>
          listGithubIssueLinks(organizationId, {
            sourceKind: query.sourceKind,
            state: query.state,
            sourceIds: query.sourceId ? [...query.sourceId] : undefined,
          }),
        );
        return yield* respond(GithubIssueLinks)(links);
      }),
    )
    // Read the org's issue statuses from GitHub now, rather than waiting.
    .handle("refreshLinks", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* githubCall(() => refreshOrgIssueStatuses(organizationId, "github"));
        return yield* respond(IssueStatusRefreshResult)(result);
      }),
    )
    // What the PR would change, or why not.
    .handle("previewPullRequest", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const preview = yield* githubCall(() => previewIacPullRequest(organizationId, payload));
        return yield* respond(GithubPullRequestPreview)(preview);
      }),
    )
    // Open it. Never merged by us.
    .handle("openPullRequest", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* githubCall(() => openIacPullRequest(organizationId, payload));
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "github_issues.pull_request.open",
            entityType: "resource",
            entityId: payload.resourceId,
            metadata: {
              sourceKind: payload.sourceKind,
              change: payload.change.kind,
              pullRequestUrl: result.pullRequest.url,
            },
          }),
        );
        return yield* respond(GithubPullRequestResult)(result);
      }),
    ),
);

export const githubIssuesDomain = makeDomain(
  "github-issues",
  GithubIssuesApi,
  GithubIssuesHandlers,
);
