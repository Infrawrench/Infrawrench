/**
 * GitHub issue filing routes (`/api/org/:orgId/github-issues/*`).
 *
 * The third tracker beside Jira and Linear, running on the org's existing
 * GitHub App installation (`routes/github.ts` connects it) rather than a
 * stored credential: every call mints an installation token server-side.
 * What it adds over the other two is dedupe by finding fingerprint, issue
 * resolution when a finding goes away, and IaC pull requests.
 *
 * Permissions: reads take `github-issues:read`; filing and pull requests take
 * `github-issues:write`; changing the settings document takes
 * `org:settings:write`, because the pull-request switch decides whether every
 * holder of `write` may propose infrastructure changes.
 *
 * An installation that has not approved the app's newer `issues` /
 * `contents` / `pull_requests` permissions answers the structured 409
 * `github_permission_required`, which both clients turn into a "grant the
 * permission" prompt instead of an error string.
 */
import { Hono, type Context } from "hono";
import type {
  GithubIssueSettingsInput as GithubIssueSettingsInputType,
  GithubPermissionRequiredPayload,
} from "@infrawrench/client-core";
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
  type GithubFinding,
  listGithubIssueLinks,
  resolveFindingRoute,
} from "@infrawrench/server-core/github-issues/filing";
import {
  IacPullRequestRefused,
  openIacPullRequest,
  previewIacPullRequest,
} from "@infrawrench/server-core/github-issues/pull-request";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import {
  FileGithubIssueInput,
  GithubIssueSettingsInput,
  GithubPullRequestInput,
  LinksQuery,
  RepoQuery,
} from "../openapi/paths/github-issues";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** Map a failure onto a status the client can branch on. */
async function failure(c: Context, err: unknown) {
  if (err instanceof GithubApiError && err.missingPermission) {
    const access = await getInstallationAccess(err.installationId).catch(() => null);
    const payload: GithubPermissionRequiredPayload = {
      error: err.message,
      code: "github_permission_required",
      permissions: [err.missingPermission],
      installationId: err.installationId,
      accountLogin: access?.accountLogin ?? null,
      manageUrl: access?.htmlUrl ?? null,
    };
    return c.json(payload, 409);
  }
  if (err instanceof GithubApiError) {
    const status = err.status !== null && [400, 404, 410, 422].includes(err.status) ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
  if (err instanceof GithubFilingError) return c.json({ error: err.message }, err.status);
  if (err instanceof GithubIssueSettingsError || err instanceof IacPullRequestRefused) {
    return c.json({ error: err.message }, 400);
  }
  console.error("[github-issues] unexpected route failure:", err);
  return c.json({ error: "GitHub request failed" }, 500);
}

/** GET /: settings plus what each installation has accepted. */
app.get("/", async (c) => {
  requirePermission(c, "github-issues:read");
  const organizationId = c.get("organizationId");
  const [settings, installations] = await Promise.all([
    getGithubIssueSettings(organizationId),
    listInstallationAccess(organizationId),
  ]);
  return c.json({ appConfigured: isGithubAppConfigured(), installations, settings });
});

/** PUT /settings: replace the whole document. */
app.put("/settings", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = GithubIssueSettingsInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid GitHub issue settings", issues: parsed.error.issues }, 400);
  }
  try {
    const saved = await setGithubIssueSettings(
      organizationId,
      parsed.data as GithubIssueSettingsInputType,
      session.userId,
    );
    void logAudit({
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
      },
    });
    return c.json(saved);
  } catch (err) {
    return failure(c, err);
  }
});

async function repoFromQuery(c: Context) {
  const parsed = RepoQuery.safeParse({
    installationId: c.req.query("installationId"),
    repo: c.req.query("repo"),
  });
  if (!parsed.success || !isRepoFullName(parsed.data.repo)) return null;
  const installs = await orgInstallationIds(c.get("organizationId"));
  if (!installs.has(parsed.data.installationId)) return null;
  return parsed.data;
}

/** GET /labels?installationId=&repo=: the label picker. */
app.get("/labels", async (c) => {
  requirePermission(c, "github-issues:read");
  const repo = await repoFromQuery(c);
  if (!repo) return c.json({ error: "Unknown repository" }, 400);
  try {
    return c.json(await listLabels(repo.installationId, repo.repo));
  } catch (err) {
    return failure(c, err);
  }
});

/** GET /assignees?installationId=&repo=: the assignee picker. */
app.get("/assignees", async (c) => {
  requirePermission(c, "github-issues:read");
  const repo = await repoFromQuery(c);
  if (!repo) return c.json({ error: "Unknown repository" }, 400);
  try {
    return c.json(await listAssignees(repo.installationId, repo.repo));
  } catch (err) {
    return failure(c, err);
  }
});

/** GET /branches?installationId=&repo=: the base-branch picker for Terraform sources. */
app.get("/branches", async (c) => {
  requirePermission(c, "github-issues:read");
  const repo = await repoFromQuery(c);
  if (!repo) return c.json({ error: "Unknown repository" }, 400);
  try {
    return c.json(await listBranches(repo.installationId, repo.repo));
  } catch (err) {
    return failure(c, err);
  }
});

/** GET /route?resourceId=: where a finding about this resource would go. */
app.get("/route", async (c) => {
  requirePermission(c, "github-issues:read");
  const resourceId = c.req.query("resourceId") || undefined;
  return c.json(await resolveFindingRoute(c.get("organizationId"), resourceId));
});

/** POST /issues: file a finding, or comment on its open issue. */
app.post("/issues", async (c) => {
  requirePermission(c, "github-issues:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = FileGithubIssueInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid issue", issues: parsed.error.issues }, 400);
  }
  const { repo, labels, assignees, ...finding } = parsed.data;
  try {
    const result = await fileFindingToGithub(organizationId, finding as GithubFinding, {
      userId: session.userId,
      autoFiled: false,
      repo,
      labels,
      assignees,
    });
    void logAudit({
      organizationId,
      userId: session.userId,
      action:
        result.action === "created" ? "github_issues.issue.create" : "github_issues.issue.comment",
      entityType: "github_issue_link",
      entityId: result.link.id,
      metadata: {
        sourceKind: finding.sourceKind,
        sourceId: finding.sourceId,
        repo: result.link.repo,
        issueNumber: result.link.issueNumber,
      },
    });
    return c.json(result);
  } catch (err) {
    return failure(c, err);
  }
});

/** GET /links?sourceKind=&state=&sourceId=…: the batch lookup a list makes once. */
app.get("/links", async (c) => {
  requirePermission(c, "github-issues:read");
  const parsed = LinksQuery.safeParse({
    sourceKind: c.req.query("sourceKind"),
    state: c.req.query("state"),
    sourceId: c.req.queries("sourceId"),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid link filter", issues: parsed.error.issues }, 400);
  }
  return c.json(
    await listGithubIssueLinks(c.get("organizationId"), {
      sourceKind: parsed.data.sourceKind,
      state: parsed.data.state,
      sourceIds: parsed.data.sourceId,
    }),
  );
});

/** POST /pull-requests/preview: what the PR would change, or why not. */
app.post("/pull-requests/preview", async (c) => {
  requirePermission(c, "github-issues:write");
  const parsed = GithubPullRequestInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid pull request", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(await previewIacPullRequest(c.get("organizationId"), parsed.data));
  } catch (err) {
    return failure(c, err);
  }
});

/** POST /pull-requests: open it. Never merged by us. */
app.post("/pull-requests", async (c) => {
  requirePermission(c, "github-issues:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = GithubPullRequestInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid pull request", issues: parsed.error.issues }, 400);
  }
  try {
    const result = await openIacPullRequest(organizationId, parsed.data);
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "github_issues.pull_request.open",
      entityType: "resource",
      entityId: parsed.data.resourceId,
      metadata: {
        sourceKind: parsed.data.sourceKind,
        change: parsed.data.change.kind,
        pullRequestUrl: result.pullRequest.url,
      },
    });
    return c.json(result);
  } catch (err) {
    return failure(c, err);
  }
});

export { app as githubIssuesRoutes };
