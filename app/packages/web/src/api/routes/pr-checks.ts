/**
 * Pull request check routes (`/api/org/:orgId/pr-checks/*`).
 *
 * The checks themselves are posted by the github-watcher through the org's
 * existing GitHub App installation (`routes/github.ts` connects it); these
 * routes configure which repositories get them, list what was posted, and
 * preview the analysis without posting (the CLI's `pr-check`).
 *
 * Permissions: reads and the preview take `iac:read`, the same permission
 * the IaC page and its Terraform state need, because the check reads that
 * state; writes take `org:settings:write`, because a repository's threshold
 * can fail pull requests where branch protection requires the check.
 *
 * The preview runs plugin estimators and reads GitHub, so it is listed in
 * `edge/gateway-routes.ts`; the CRUD is plain Postgres and stays on the edge.
 */
import { Hono, type Context } from "hono";
import type { PrCheckRepositoryInput as PrCheckRepositoryInputType } from "@infrawrench/client-core";
import { isGithubAppConfigured } from "@infrawrench/server-core/github/app";
import { GithubApiError, isRepoFullName } from "@infrawrench/server-core/github/issues-api";
import {
  PrCheckSettingsError,
  createPrCheckRepository,
  deletePrCheckRepository,
  getPrCheckRepository,
  listPrCheckInstallationAccess,
  listPrCheckRepositories,
  updatePrCheckRepository,
} from "@infrawrench/server-core/pr-checks/settings";
import { listPrCheckRuns } from "@infrawrench/server-core/pr-checks/runs";
import {
  previewFilesCheck,
  previewPullRequestCheck,
} from "@infrawrench/server-core/pr-checks/pass";
import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import {
  PrCheckPreviewInput,
  PrCheckRepositoryInput,
  PrCheckRunsQuery,
} from "../openapi/paths/pr-checks";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function failure(c: Context, err: unknown) {
  if (err instanceof PrCheckSettingsError) return c.json({ error: err.message }, err.status);
  if (err instanceof GithubApiError) {
    const status = err.status !== null && [400, 404, 410, 422].includes(err.status) ? 400 : 502;
    return c.json({ error: err.message }, status);
  }
  console.error("[pr-checks] unexpected route failure:", err);
  return c.json({ error: "Pull request check request failed" }, 500);
}

/** GET /: repositories plus what each installation has accepted. */
app.get("/", async (c) => {
  requirePermission(c, "iac:read");
  const organizationId = c.get("organizationId");
  const [repositories, installations] = await Promise.all([
    listPrCheckRepositories(organizationId),
    listPrCheckInstallationAccess(organizationId),
  ]);
  return c.json({ appConfigured: isGithubAppConfigured(), installations, repositories });
});

app.get("/repositories", async (c) => {
  requirePermission(c, "iac:read");
  return c.json(await listPrCheckRepositories(c.get("organizationId")));
});

app.post("/repositories", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = PrCheckRepositoryInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid repository settings", issues: parsed.error.issues }, 400);
  }
  try {
    const saved = await createPrCheckRepository(
      organizationId,
      parsed.data as PrCheckRepositoryInputType,
      session.userId,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "pr_checks.create",
      entityType: "pr_check_repository",
      entityId: saved.id,
      metadata: {
        repo: saved.repo,
        enabled: saved.enabled,
        commentEnabled: saved.commentEnabled,
        costThreshold: saved.costThreshold,
      },
    });
    return c.json(saved, 201);
  } catch (err) {
    return failure(c, err);
  }
});

app.get("/repositories/:id", async (c) => {
  requirePermission(c, "iac:read");
  const repo = await getPrCheckRepository(c.get("organizationId"), c.req.param("id"));
  return repo ? c.json(repo) : c.json({ error: "Unknown repository" }, 404);
});

app.put("/repositories/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const parsed = PrCheckRepositoryInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid repository settings", issues: parsed.error.issues }, 400);
  }
  try {
    const saved = await updatePrCheckRepository(
      organizationId,
      c.req.param("id"),
      parsed.data as PrCheckRepositoryInputType,
    );
    void logAudit({
      organizationId,
      userId: session.userId,
      action: "pr_checks.update",
      entityType: "pr_check_repository",
      entityId: saved.id,
      metadata: {
        repo: saved.repo,
        enabled: saved.enabled,
        commentEnabled: saved.commentEnabled,
        costThreshold: saved.costThreshold,
        thresholdConclusion: saved.thresholdConclusion,
      },
    });
    return c.json(saved);
  } catch (err) {
    return failure(c, err);
  }
});

app.delete("/repositories/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  const id = c.req.param("id");
  const existing = await getPrCheckRepository(organizationId, id);
  if (!existing || !(await deletePrCheckRepository(organizationId, id))) {
    return c.json({ error: "Unknown repository" }, 404);
  }
  void logAudit({
    organizationId,
    userId: session.userId,
    action: "pr_checks.delete",
    entityType: "pr_check_repository",
    entityId: id,
    metadata: { repo: existing.repo },
  });
  return c.json({ ok: true as const });
});

app.get("/runs", async (c) => {
  requirePermission(c, "iac:read");
  const parsed = PrCheckRunsQuery.safeParse({
    repositoryId: c.req.query("repositoryId"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  return c.json(await listPrCheckRuns(c.get("organizationId"), parsed.data));
});

app.post("/preview", async (c) => {
  requirePermission(c, "iac:read");
  const organizationId = c.get("organizationId");
  const parsed = PrCheckPreviewInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid preview request", issues: parsed.error.issues }, 400);
  }
  try {
    if ("repositoryId" in parsed.data) {
      const repository = await getPrCheckRepository(organizationId, parsed.data.repositoryId);
      if (!repository) return c.json({ error: "Unknown repository" }, 404);
      const preview = await previewPullRequestCheck(
        organizationId,
        repository,
        parsed.data.pullNumber,
      );
      return preview ? c.json(preview) : c.json({ error: "No such pull request" }, 404);
    }
    const repoName = parsed.data.repo?.trim() || null;
    if (repoName && !isRepoFullName(repoName)) {
      return c.json({ error: "repo must be owner/name" }, 400);
    }
    const repository = repoName
      ? ((await listPrCheckRepositories(organizationId)).find(
          (r) => r.repo.toLowerCase() === repoName.toLowerCase(),
        ) ?? null)
      : null;
    return c.json(
      await previewFilesCheck(organizationId, parsed.data.files, repository, repoName),
    );
  } catch (err) {
    return failure(c, err);
  }
});

export { app as prChecksRoutes };
