/**
 * HTTP API for deployments (org-scoped, mounted at /api/org/:orgId/deployments).
 *
 * The interactive run is NOT here — `select(...)` needs a live round trip, so
 * it goes over the websocket (`services/deployment-ws.ts`), exactly as an
 * interactive workflow run does. What is here is everything that answers in one
 * shot: the repo picker's source list, a plan-only preview, and the history.
 *
 * The logic lives in services/deployments.ts; this file is transport only.
 */
import { Hono, type Context } from "hono";

import { requirePermission } from "../../auth/permissions";
import {
  DeploymentError,
  declaredEnvs,
  deleteDeployTrigger,
  listDeployTriggers,
  setDeployTriggerEnabled,
  upsertDeployTrigger,
  getDeploymentRun,
  listDeployableRepos,
  listDeploymentRuns,
  recordCliRun,
  resolveInfrafile,
  rollbackDeployment,
  runDeployment,
} from "../../services/deployments";
import { PlanRequiredError } from "../../services/entitlements";
import { checkChangeFreeze } from "../../services/change-freezes";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

function userId(c: Context): string | undefined {
  return (c.get("session") as { userId?: string } | undefined)?.userId;
}

function fail(c: Context, e: unknown) {
  // 402 Payment Required is the honest status for "your plan does not include
  // this", and lets the client tell it apart from a permission problem.
  if (e instanceof PlanRequiredError) return c.json({ error: e.message }, 402);
  if (e instanceof DeploymentError) {
    return c.json({ error: e.message }, e.status as 400 | 404 | 409);
  }
  throw e;
}

/** Repositories this org's GitHub App installations can deploy from. */
app.get("/repos", async (c) => {
  requirePermission(c, "deployments:read");
  return c.json(await listDeployableRepos(orgId(c)));
});

/**
 * The environments a repo's Infrafile declares, read at a branch head.
 * The env picker can't be populated until the file has been fetched and its
 * `envs` read, so this is a separate call the UI makes after picking a branch.
 */
app.post("/envs", async (c) => {
  // Read is right here: the file is fetched and regex-parsed, never executed.
  requirePermission(c, "deployments:read");
  const body = (await c.req.json()) as { repo?: string; branch?: string };
  try {
    const resolved = await resolveInfrafile(orgId(c), body.repo ?? "", body.branch ?? "main");
    return c.json({
      envs: declaredEnvs(resolved.source),
      sha: resolved.sha,
      repo: resolved.fullName,
      branch: resolved.branch,
    });
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * Plan-only preview: run `plan()` and render the Dockerfile, build nothing.
 * Non-interactive, so any `select(...)` must be answered via `answers`.
 */
app.post("/plan", async (c) => {
  // Its own permission, between read and write: a plan evaluates the repo's
  // Infrafile against this org's host, so it is code execution and not a read —
  // but it builds nothing and ships nothing, so it is not a write either.
  requirePermission(c, "deployments:plan");
  const body = (await c.req.json()) as {
    repo?: string;
    branch?: string;
    env?: string;
    answers?: Record<string, string>;
  };
  try {
    const { runId, result } = await runDeployment({
      organizationId: orgId(c),
      ...(userId(c) ? { userId: userId(c)! } : {}),
      repo: body.repo ?? "",
      branch: body.branch ?? "main",
      ...(body.env ? { env: body.env } : {}),
      ...(body.answers ? { answers: body.answers } : {}),
      planOnly: true,
      interactive: false,
    });
    return c.json({ runId, result });
  } catch (e) {
    return fail(c, e);
  }
});

/** Deploy history, newest first. */
app.get("/runs", async (c) => {
  requirePermission(c, "deployments:read");
  const env = c.req.query("env");
  const limit = Number(c.req.query("limit") ?? "50");
  return c.json(
    await listDeploymentRuns(orgId(c), {
      ...(env ? { env } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    }),
  );
});

app.get("/runs/:id", async (c) => {
  requirePermission(c, "deployments:read");
  try {
    return c.json(await getDeploymentRun(orgId(c), c.req.param("id")));
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * Roll back to a previous run: re-run its `deploy()` with the image and plan it
 * recorded, building nothing. Non-interactive by design — the plan is replayed
 * rather than recomputed, so there is nothing to ask.
 */
app.post("/runs/:id/rollback", async (c) => {
  requirePermission(c, "deployments:write");
  const frozen = await checkChangeFreeze(c, {
    action: "deployment.rollback",
    entityType: "deployment_run",
    entityId: c.req.param("id"),
  });
  if (frozen) return frozen;
  // The body is optional — a bare rollback has nothing to say.
  const body = (await c.req.json().catch(() => ({}))) as { deleteCreated?: unknown };
  try {
    const { runId, result } = await rollbackDeployment({
      organizationId: orgId(c),
      runId: c.req.param("id"),
      ...(userId(c) ? { userId: userId(c)! } : {}),
      // Explicit true or nothing: this deletes real resources.
      ...(body.deleteCreated === true ? { deleteCreated: true } : {}),
    });
    return c.json({ runId, result });
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * Record a run that happened elsewhere. The CLI builds on the operator's own
 * machine, so the server never sees that run — it is told what happened, which
 * is what keeps one history across both origins.
 */
app.post("/runs", async (c) => {
  requirePermission(c, "deployments:write");
  const body = (await c.req.json()) as Parameters<typeof recordCliRun>[2];
  if (!body?.env || !body?.status) {
    return c.json({ error: "env and status are required" }, 400);
  }
  try {
    return c.json(await recordCliRun(orgId(c), userId(c), body), 201);
  } catch (e) {
    return fail(c, e);
  }
});

/* --------------------------------------------------------- deploy on push -- */

app.get("/triggers", async (c) => {
  requirePermission(c, "deployments:read");
  return c.json(await listDeployTriggers(orgId(c)));
});

/**
 * Create or update a trigger. `deployments:write`, because a trigger is a
 * standing instruction to deploy — arming one is the same authority as
 * deploying, just deferred.
 */
app.post("/triggers", async (c) => {
  requirePermission(c, "deployments:write");
  const body = (await c.req.json()) as {
    repo?: string;
    branch?: string;
    env?: string;
    answers?: Record<string, string>;
  };
  if (!body.repo || !body.branch || !body.env) {
    return c.json({ error: "repo, branch and env are required" }, 400);
  }
  try {
    return c.json(
      await upsertDeployTrigger(orgId(c), userId(c), {
        repo: body.repo,
        branch: body.branch,
        env: body.env,
        ...(body.answers ? { answers: body.answers } : {}),
      }),
      201,
    );
  } catch (e) {
    return fail(c, e);
  }
});

app.patch("/triggers/:id", async (c) => {
  requirePermission(c, "deployments:write");
  const body = (await c.req.json()) as { enabled?: unknown };
  // Explicit or nothing. `enabled !== false` treated an empty body as "enable",
  // and enabling a trigger arms a real deploy on the next push — not something
  // a missing field should ever do.
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be true or false" }, 400);
  }
  try {
    return c.json(await setDeployTriggerEnabled(orgId(c), c.req.param("id"), body.enabled));
  } catch (e) {
    return fail(c, e);
  }
});

app.delete("/triggers/:id", async (c) => {
  requirePermission(c, "deployments:write");
  await deleteDeployTrigger(orgId(c), c.req.param("id"));
  return c.json({ ok: true });
});

export default app;
