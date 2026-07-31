/**
 * HTTP API for workflows (org-scoped, mounted at /api/org/:orgId/workflows).
 *
 * CRUD plus: GET /:id/typings (generated infra.d.ts for the Monaco editor),
 * POST /:id/check (headless type check), POST /:id/run (manual run in the
 * isolate), GET /:id/runs, GET /:id/metrics.
 *
 * The logic lives in services/workflows.ts so the MCP/chat tool registry drives
 * exactly the same code path; this file is transport only.
 *
 * Reads take `workflows:read`; creating, editing, deleting, and manually
 * running take `workflows:write`. Manual run sits with `write` rather than a
 * permission of its own because anyone who can edit a workflow can already give
 * it a cron or git trigger — a separate `run` would be a lock on an open door.
 * Deciding approval requests is a genuinely different trust level and lives in
 * `workflows:approve` (see routes/workflow-approvals.ts).
 */
import { Hono, type Context } from "hono";

import type { MetricDef, WorkflowTrigger } from "@infrawrench/workflow-runtime";

import { requirePermission } from "../../auth/permissions";
import {
  WorkflowError,
  checkWorkflowSource,
  clearWorkflowSchedule,
  createWorkflow,
  generateWorkflowTypings,
  getWorkflow,
  listWorkflowMetrics,
  listWorkflowRuns,
  listWorkflows,
  redactWorkflow,
  setWorkflowSchedule,
  softDeleteWorkflow,
  updateWorkflow,
  workflowScheduleView,
  type WorkflowBody,
  type WorkflowScheduleBody,
} from "../../services/workflows";
import { runWorkflowById } from "../../services/workflow-runner";

const app = new Hono();

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

/** Map a service-level failure onto its HTTP response. */
function fail(c: Context, e: unknown) {
  if (e instanceof WorkflowError) return c.json({ error: e.message }, e.status);
  throw e;
}

/** Load a workflow or return the 404 body; callers bail when it's null. */
async function load(c: Context, id: string) {
  const wf = await getWorkflow(orgId(c), id);
  return wf ?? null;
}

app.get("/", async (c) => {
  requirePermission(c, "workflows:read");
  const rows = await listWorkflows(orgId(c));
  return c.json(rows.map(redactWorkflow));
});

app.post("/", async (c) => {
  requirePermission(c, "workflows:write");
  const body = (await c.req.json()) as WorkflowBody;
  const userId = (c.get("session") as { userId?: string } | undefined)?.userId ?? null;
  try {
    return c.json(redactWorkflow(await createWorkflow(orgId(c), body, userId)), 201);
  } catch (e) {
    return fail(c, e);
  }
});

app.get("/:id", async (c) => {
  requirePermission(c, "workflows:read");
  const wf = await load(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  return c.json(redactWorkflow(wf));
});

app.put("/:id", async (c) => {
  requirePermission(c, "workflows:write");
  const body = (await c.req.json()) as WorkflowBody;
  try {
    return c.json(redactWorkflow(await updateWorkflow(orgId(c), c.req.param("id"), body)));
  } catch (e) {
    return fail(c, e);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "workflows:write");
  try {
    await softDeleteWorkflow(orgId(c), c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e);
  }
});

// --- Cron schedule sub-resource (the workflow's cron trigger) ---

app.get("/:id/schedule", async (c) => {
  requirePermission(c, "dashboards:read");
  const wf = await load(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  return c.json({ schedule: workflowScheduleView(wf) });
});

app.put("/:id/schedule", async (c) => {
  requirePermission(c, "dashboards:write");
  const body = (await c.req.json().catch(() => null)) as WorkflowScheduleBody | null;
  if (!body || typeof body.expression !== "string") {
    return c.json({ error: "Body must be JSON with an `expression` string." }, 400);
  }
  try {
    const wf = await setWorkflowSchedule(orgId(c), c.req.param("id"), body);
    return c.json({ schedule: workflowScheduleView(wf) });
  } catch (e) {
    return fail(c, e);
  }
});

app.delete("/:id/schedule", async (c) => {
  requirePermission(c, "dashboards:write");
  try {
    await clearWorkflowSchedule(orgId(c), c.req.param("id"));
    return c.json({ ok: true });
  } catch (e) {
    return fail(c, e);
  }
});

// Generated TypeScript typings for the editor
app.get("/:id/typings", async (c) => {
  requirePermission(c, "workflows:read");
  const wf = await load(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  const dts = await generateWorkflowTypings(orgId(c), {
    metrics: (wf.metricDefs ?? []) as MetricDef[],
    triggerKind: (wf.trigger as WorkflowTrigger).kind,
  });
  return c.json({ dts });
});

// Headless type check of a candidate source (editorless clients).
app.post("/:id/check", async (c) => {
  requirePermission(c, "workflows:read");
  const wf = await load(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { source?: string };
  const result = await checkWorkflowSource(orgId(c), body.source ?? wf.source, {
    metrics: (wf.metricDefs ?? []) as MetricDef[],
    triggerKind: (wf.trigger as WorkflowTrigger).kind,
  });
  return c.json(result);
});

// Manual run
app.post("/:id/run", async (c) => {
  requirePermission(c, "workflows:write");
  const wf = await load(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  const { runId, result } = await runWorkflowById({
    organizationId: orgId(c),
    workflowId: wf.id,
    triggerSource: "manual",
    // HTTP runs are non-interactive; interactive prompting uses the websocket.
    interactive: false,
  });
  return c.json({ runId, result });
});

// Run history
app.get("/:id/runs", async (c) => {
  requirePermission(c, "workflows:read");
  const wf = await load(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  return c.json(await listWorkflowRuns(wf.id));
});

// Current metric values
app.get("/:id/metrics", async (c) => {
  requirePermission(c, "workflows:read");
  const wf = await load(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  return c.json(await listWorkflowMetrics(wf.id));
});

export default app;
