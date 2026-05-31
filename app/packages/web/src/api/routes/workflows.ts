/**
 * HTTP API for workflows (org-scoped, mounted at /api/org/:orgId/workflows).
 *
 * CRUD plus: GET /:id/typings (generated infra.d.ts for the Monaco editor),
 * POST /:id/run (manual run in the isolate), GET /:id/runs, GET /:id/metrics.
 *
 * NOTE: workflows reuse the dashboards:read / dashboards:write permissions for
 * now; dedicated workflows:* permissions are a follow-up (see WORKFLOWS_PLAN.md).
 */
import { Hono, type Context } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";

import {
  generateInfraDts,
  type MetricDef,
  type WorkflowTrigger,
} from "@infrawrench/workflow-runtime";

import { db } from "@infrawrench/server-core/db/client";
import { workflowMetrics, workflowRuns, workflows } from "@infrawrench/server-core/db/schema";

import { requirePermission } from "../../auth/permissions";
import { listOrgPlugins } from "../../services/workflow-host";
import { runWorkflowById } from "../../services/workflow-runner";

const app = new Hono();

interface WorkflowBody {
  name?: string;
  description?: string | null;
  source?: string;
  trigger?: WorkflowTrigger;
  metrics?: MetricDef[];
  enabled?: boolean;
}

function orgId(c: Context): string {
  return c.get("organizationId") as string;
}

/** When a workflow has a cron/git trigger, derive scheduling/secret fields. */
function triggerDerived(
  trigger: WorkflowTrigger,
  enabled: boolean,
): { nextRunAt: Date | null; webhookToken: string | null } {
  if (trigger.kind === "cron" && enabled) {
    // Poller computes the precise next time from the cron expression; seed "now"
    // so it gets picked up on the next tick.
    return { nextRunAt: new Date(), webhookToken: null };
  }
  if (trigger.kind === "git") {
    return { nextRunAt: null, webhookToken: crypto.randomUUID() };
  }
  return { nextRunAt: null, webhookToken: null };
}

async function loadWorkflow(c: Context, id: string) {
  const [wf] = await db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, id),
        eq(workflows.organizationId, orgId(c)),
        isNull(workflows.deletedAt),
      ),
    )
    .limit(1);
  return wf;
}

// List
app.get("/", async (c) => {
  requirePermission(c, "dashboards:read");
  const rows = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.organizationId, orgId(c)), isNull(workflows.deletedAt)))
    .orderBy(desc(workflows.updatedAt));
  return c.json(rows);
});

// Create
app.post("/", async (c) => {
  requirePermission(c, "dashboards:write");
  const body = (await c.req.json()) as WorkflowBody;
  const trigger: WorkflowTrigger = body.trigger ?? { kind: "manual" };
  const enabled = body.enabled ?? true;
  const derived = triggerDerived(trigger, enabled);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(workflows).values({
    id,
    organizationId: orgId(c),
    name: body.name?.trim() || "Untitled workflow",
    description: body.description ?? null,
    source: body.source ?? "",
    trigger,
    metricDefs: body.metrics ?? [],
    enabled,
    webhookToken: derived.webhookToken,
    nextRunAt: derived.nextRunAt,
    createdByUserId: (c.get("session") as { userId?: string } | undefined)?.userId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [created] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return c.json(created, 201);
});

// Get one
app.get("/:id", async (c) => {
  requirePermission(c, "dashboards:read");
  const wf = await loadWorkflow(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  return c.json(wf);
});

// Update
app.put("/:id", async (c) => {
  requirePermission(c, "dashboards:write");
  const id = c.req.param("id");
  const existing = await loadWorkflow(c, id);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json()) as WorkflowBody;
  const trigger: WorkflowTrigger = body.trigger ?? (existing.trigger as WorkflowTrigger);
  const enabled = body.enabled ?? existing.enabled;
  const derived = triggerDerived(trigger, enabled);
  await db
    .update(workflows)
    .set({
      name: body.name?.trim() || existing.name,
      description: body.description ?? existing.description,
      source: body.source ?? existing.source,
      trigger,
      metricDefs: body.metrics ?? existing.metricDefs,
      enabled,
      // Preserve an existing git webhook token; only (re)issue when needed.
      webhookToken: existing.webhookToken ?? derived.webhookToken,
      nextRunAt: derived.nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(workflows.id, id));
  const [updated] = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
  return c.json(updated);
});

// Soft delete
app.delete("/:id", async (c) => {
  requirePermission(c, "dashboards:write");
  const id = c.req.param("id");
  const existing = await loadWorkflow(c, id);
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db
    .update(workflows)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(workflows.id, id));
  return c.json({ ok: true });
});

// Generated TypeScript typings for the editor
app.get("/:id/typings", async (c) => {
  requirePermission(c, "dashboards:read");
  const wf = await loadWorkflow(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  const plugins = await listOrgPlugins(orgId(c));
  const trigger = wf.trigger as WorkflowTrigger;
  const dts = generateInfraDts({
    plugins,
    metrics: (wf.metricDefs ?? []) as MetricDef[],
    interactive: trigger.kind === "manual",
  });
  return c.json({ dts });
});

// Manual run
app.post("/:id/run", async (c) => {
  requirePermission(c, "dashboards:write");
  const wf = await loadWorkflow(c, c.req.param("id"));
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
  requirePermission(c, "dashboards:read");
  const wf = await loadWorkflow(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workflowId, wf.id))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(50);
  return c.json(rows);
});

// Current metric values
app.get("/:id/metrics", async (c) => {
  requirePermission(c, "dashboards:read");
  const wf = await loadWorkflow(c, c.req.param("id"));
  if (!wf) return c.json({ error: "Not found" }, 404);
  const rows = await db
    .select()
    .from(workflowMetrics)
    .where(and(eq(workflowMetrics.workflowId, wf.id), isNull(workflowMetrics.deletedAt)));
  return c.json(rows);
});

export default app;
