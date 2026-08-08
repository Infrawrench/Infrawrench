import { Hono } from "hono";
import { eq, and, inArray, isNull, desc, max } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { ProbeStatus } from "@infrawrench/plugin-base";
import type { StoredWorkflowMetricDef as MetricDef } from "@infrawrench/ui/workflows";
import {
  widgetConfigSchemaFor,
  DASHBOARD_WIDGET_KINDS,
  type DashboardWidget,
  type DashboardWidgetKind,
} from "@infrawrench/ui/cost/config";
import { db } from "../../db/client";
import {
  dashboards,
  dashboardPins,
  dashboardWidgets,
  dashboardWorkflowPins,
  resources,
  accounts,
  workflows,
  workflowMetrics,
  workflowRuns,
  chatConversations,
} from "../../db/schema";
import {
  getLatestAccountCountsBatch,
  getLatestMetrics,
  getLatestMetricsBatch,
  getLatestStats,
  getLatestStatsBatch,
  getMetricRange,
} from "@infrawrench/server-core/clickhouse/readers";
import type { AuthSession } from "../auth-middleware";
import { getPlugin } from "../../plugins/loader";
import { requirePermission } from "../../auth/permissions";
import { nextPinSyncVersion } from "../../services/sync-versions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** Card kinds the grid can hold, and therefore that a reorder may name. */
const CARD_KINDS = new Set(["resource", "workflow", "widget"]);

/**
 * Next free slot at the end of a dashboard's grid.
 *
 * Resource pins, workflow pins, and widgets share one drag-reorderable
 * sequence, so a new card of any kind has to clear the highest `gridX` across
 * all three tables — placing it at the end of its own table would drop it into
 * the middle of the grid.
 */
async function nextGridX(dashboardId: string): Promise<number> {
  const [pins, workflowPins, widgets] = await Promise.all([
    db
      .select({ value: max(dashboardPins.gridX) })
      .from(dashboardPins)
      .where(eq(dashboardPins.dashboardId, dashboardId)),
    db
      .select({ value: max(dashboardWorkflowPins.gridX) })
      .from(dashboardWorkflowPins)
      .where(eq(dashboardWorkflowPins.dashboardId, dashboardId)),
    db
      .select({ value: max(dashboardWidgets.gridX) })
      .from(dashboardWidgets)
      .where(
        and(eq(dashboardWidgets.dashboardId, dashboardId), isNull(dashboardWidgets.deletedAt)),
      ),
  ]);
  const highest = Math.max(
    pins[0]?.value ?? -1,
    workflowPins[0]?.value ?? -1,
    widgets[0]?.value ?? -1,
  );
  return highest + 1;
}

interface WorkflowPinDto {
  pinId: string;
  workflowId: string;
  gridX: number;
  name: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  metrics: Array<{ key: string; label: string; unit: string | null; value: unknown }>;
}

/**
 * Load the workflow pins for a dashboard, enriched with each workflow's
 * declared metrics (current values), last-run time, and last-run status. All
 * data is DB-only (no plugin probing), so it's returned inline with the
 * dashboard rather than via a separate enrich endpoint like resource pins.
 */
async function loadWorkflowPins(dashboardId: string): Promise<WorkflowPinDto[]> {
  const pins = await db
    .select({
      pinId: dashboardWorkflowPins.id,
      workflowId: dashboardWorkflowPins.workflowId,
      gridX: dashboardWorkflowPins.gridX,
      name: workflows.name,
      lastRunAt: workflows.lastRunAt,
      metricDefs: workflows.metricDefs,
    })
    .from(dashboardWorkflowPins)
    .innerJoin(workflows, eq(dashboardWorkflowPins.workflowId, workflows.id))
    .where(
      and(
        eq(dashboardWorkflowPins.dashboardId, dashboardId),
        isNull(dashboardWorkflowPins.deletedAt),
        isNull(workflows.deletedAt),
      ),
    )
    .orderBy(dashboardWorkflowPins.gridX, dashboardWorkflowPins.createdAt);

  if (pins.length === 0) return [];

  const workflowIds = pins.map((p) => p.workflowId);

  const metricRows = await db
    .select({
      workflowId: workflowMetrics.workflowId,
      key: workflowMetrics.key,
      value: workflowMetrics.value,
    })
    .from(workflowMetrics)
    .where(
      and(inArray(workflowMetrics.workflowId, workflowIds), isNull(workflowMetrics.deletedAt)),
    );
  const valueByKey = new Map<string, unknown>();
  for (const m of metricRows) valueByKey.set(`${m.workflowId}:${m.key}`, m.value ?? null);

  const runRows = await db
    .select({ workflowId: workflowRuns.workflowId, status: workflowRuns.status })
    .from(workflowRuns)
    .where(inArray(workflowRuns.workflowId, workflowIds))
    .orderBy(desc(workflowRuns.createdAt));
  const latestStatus = new Map<string, string>();
  for (const r of runRows)
    if (!latestStatus.has(r.workflowId)) latestStatus.set(r.workflowId, r.status);

  return pins.map((p) => {
    const defs = (Array.isArray(p.metricDefs) ? p.metricDefs : []) as MetricDef[];
    return {
      pinId: p.pinId,
      workflowId: p.workflowId,
      gridX: p.gridX,
      name: p.name,
      lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
      lastStatus: latestStatus.get(p.workflowId) ?? null,
      metrics: defs.map((d) => ({
        key: d.key,
        label: d.label ?? d.key,
        unit: d.unit ?? null,
        value: valueByKey.get(`${p.workflowId}:${d.key}`) ?? null,
      })),
    };
  });
}

/** Load the non-resource widgets (cost graphs, budgets) for a dashboard. */
async function loadWidgets(dashboardId: string): Promise<DashboardWidget[]> {
  const rows = await db
    .select()
    .from(dashboardWidgets)
    .where(and(eq(dashboardWidgets.dashboardId, dashboardId), isNull(dashboardWidgets.deletedAt)))
    .orderBy(dashboardWidgets.gridX, dashboardWidgets.createdAt);
  return rows.map((w) => ({
    id: w.id,
    dashboardId: w.dashboardId,
    kind: w.kind as DashboardWidgetKind,
    title: w.title,
    config: w.config as DashboardWidget["config"],
    gridX: w.gridX,
    gridY: w.gridY,
    gridW: w.gridW,
    gridH: w.gridH,
  }));
}

/** GET /api/dashboards — list all dashboards */
app.get("/", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const rows = await db
    .select({ id: dashboards.id, name: dashboards.name, isDefault: dashboards.isDefault })
    .from(dashboards)
    .where(and(eq(dashboards.organizationId, organizationId), isNull(dashboards.deletedAt)))
    .orderBy(desc(dashboards.isDefault), dashboards.createdAt);
  return c.json(rows);
});

/** POST /api/dashboards — create a dashboard */
app.post("/", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const { name } = await c.req.json<{ name: string }>();
  const [created] = await db
    .insert(dashboards)
    .values({ id: uuidv4(), organizationId, name, isDefault: false })
    .returning();
  return c.json(created);
});

/** GET /api/dashboards/:id — get dashboard with pins */
app.get("/:id", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const dashboardId = c.req.param("id");

  const [dashboard] = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);

  if (!dashboard) return c.json({ error: "Not found" }, 404);

  const pins = await db
    .select({
      pinId: dashboardPins.id,
      resourceId: dashboardPins.resourceId,
      gridX: dashboardPins.gridX,
      gridY: dashboardPins.gridY,
      gridW: dashboardPins.gridW,
      gridH: dashboardPins.gridH,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(
      and(
        eq(dashboardPins.dashboardId, dashboardId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .orderBy(dashboardPins.gridX, dashboardPins.createdAt);

  const workflowPins = await loadWorkflowPins(dashboardId);
  const widgets = await loadWidgets(dashboardId);

  return c.json({ dashboard, pins, workflowPins, widgets });
});

/** GET /api/dashboards/default/full — get-or-create default dashboard with pins */
app.get("/default/full", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");

  let [defaultDashboard] = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        eq(dashboards.isDefault, true),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);

  if (!defaultDashboard) {
    const [created] = await db
      .insert(dashboards)
      .values({ id: uuidv4(), organizationId, name: "Home", isDefault: true })
      .returning();
    defaultDashboard = created!;
  }

  const pins = await db
    .select({
      pinId: dashboardPins.id,
      resourceId: dashboardPins.resourceId,
      gridX: dashboardPins.gridX,
      gridY: dashboardPins.gridY,
      gridW: dashboardPins.gridW,
      gridH: dashboardPins.gridH,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(
      and(
        eq(dashboardPins.dashboardId, defaultDashboard.id),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .orderBy(dashboardPins.gridX, dashboardPins.createdAt);

  const workflowPins = await loadWorkflowPins(defaultDashboard.id);
  const widgets = await loadWidgets(defaultDashboard.id);

  return c.json({ dashboard: defaultDashboard, pins, workflowPins, widgets });
});

/** POST /api/dashboards/widgets — add a cost-graph or budget widget. */
app.post("/widgets", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<{
    dashboardId?: string;
    kind?: string;
    title?: string;
    config?: unknown;
  }>();

  const kind = body.kind as DashboardWidgetKind;
  if (!DASHBOARD_WIDGET_KINDS.includes(kind)) {
    return c.json({ error: "Invalid widget kind" }, 400);
  }
  if (!body.dashboardId) return c.json({ error: "dashboardId is required" }, 400);

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(
      and(
        eq(dashboards.id, body.dashboardId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboards.deletedAt),
      ),
    )
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  const parsed = widgetConfigSchemaFor(kind).safeParse(body.config);
  if (!parsed.success) {
    return c.json({ error: "Invalid widget config", issues: parsed.error.issues }, 400);
  }

  const [created] = await db
    .insert(dashboardWidgets)
    .values({
      id: uuidv4(),
      organizationId,
      dashboardId: dashboard.id,
      kind,
      title: body.title ?? "",
      config: parsed.data,
      gridX: await nextGridX(dashboard.id),
    })
    .returning();
  return c.json(created);
});

/** PATCH /api/dashboards/widgets/:widgetId — update title/config/layout. */
app.patch("/widgets/:widgetId", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const body = await c.req.json<{
    title?: string;
    config?: unknown;
    gridX?: number;
    gridY?: number;
    gridW?: number;
    gridH?: number;
  }>();

  const [widget] = await db
    .select()
    .from(dashboardWidgets)
    .where(
      and(
        eq(dashboardWidgets.id, c.req.param("widgetId")),
        eq(dashboardWidgets.organizationId, organizationId),
        isNull(dashboardWidgets.deletedAt),
      ),
    )
    .limit(1);
  if (!widget) return c.json({ error: "Not found" }, 404);

  const updates: Partial<typeof dashboardWidgets.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.config !== undefined) {
    const parsed = widgetConfigSchemaFor(widget.kind as DashboardWidgetKind).safeParse(body.config);
    if (!parsed.success) {
      return c.json({ error: "Invalid widget config", issues: parsed.error.issues }, 400);
    }
    updates.config = parsed.data;
  }
  for (const key of ["gridX", "gridY", "gridW", "gridH"] as const) {
    const value = body[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) updates[key] = value;
  }

  const [updated] = await db
    .update(dashboardWidgets)
    .set(updates)
    .where(eq(dashboardWidgets.id, widget.id))
    .returning();
  return c.json(updated);
});

/** DELETE /api/dashboards/widgets/:widgetId — soft delete. */
app.delete("/widgets/:widgetId", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");

  const [deleted] = await db
    .update(dashboardWidgets)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(dashboardWidgets.id, c.req.param("widgetId")),
        eq(dashboardWidgets.organizationId, organizationId),
        isNull(dashboardWidgets.deletedAt),
      ),
    )
    .returning({ id: dashboardWidgets.id });
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

/** POST /api/dashboards/:id/rename */
app.post("/:id/rename", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const dashboardId = c.req.param("id");
  const { name } = await c.req.json<{ name: string }>();
  await db
    .update(dashboards)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)));
  return c.json({ ok: true });
});

/** DELETE /api/dashboards/:id */
app.delete("/:id", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const dashboardId = c.req.param("id");

  const [dash] = await db
    .select({ isDefault: dashboards.isDefault })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);

  if (!dash) return c.json({ error: "Not found" }, 404);
  if (dash.isDefault) return c.json({ error: "Cannot delete the default dashboard" }, 400);

  await db.delete(dashboardPins).where(eq(dashboardPins.dashboardId, dashboardId));
  await db
    .delete(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)));
  return c.json({ ok: true });
});

/** POST /api/dashboards/pin */
app.post("/pin", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const { dashboardId, resourceId, gridX, gridY } = await c.req.json<{
    dashboardId: string;
    resourceId: string;
    gridX?: number;
    gridY?: number;
  }>();

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  const [resource] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
    .limit(1);
  if (!resource) return c.json({ error: "Resource not found" }, 404);

  // When no explicit position, place at the end of the whole grid
  const effectiveGridX = gridX ?? (await nextGridX(dashboardId));

  await db
    .insert(dashboardPins)
    .values({
      id: uuidv4(),
      dashboardId,
      resourceId,
      gridX: effectiveGridX,
      gridY: gridY ?? 0,
      syncVersion: nextPinSyncVersion(organizationId),
    })
    // A conflict means the resource is already pinned here — unpin hard-deletes,
    // so no tombstone can be in the way. Leave the existing card's position
    // alone rather than yanking it back to the end of the row.
    .onConflictDoNothing();
  return c.json({ ok: true });
});

/**
 * POST /api/dashboards/:id/reorder — persist card order.
 *
 * `cards` is the whole grid in its new order, mixing all three kinds, and
 * `gridX` is written as the index within that one sequence. `resourceIds` is
 * the older resource-pins-only form, kept for compatibility and treated as
 * `cards` of kind "resource".
 */
app.post("/:id/reorder", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const dashboardId = c.req.param("id");
  const body = await c.req.json<{
    cards?: Array<{ kind: string; id: string }>;
    resourceIds?: string[];
  }>();
  const cards =
    body.cards ?? (body.resourceIds ?? []).map((id) => ({ kind: "resource" as const, id }));
  if (cards.some((card) => !CARD_KINDS.has(card.kind) || !card.id)) {
    return c.json({ error: "Invalid card reference" }, 400);
  }

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  await Promise.all(
    cards.map(({ kind, id }, index) => {
      if (kind === "workflow") {
        return db
          .update(dashboardWorkflowPins)
          .set({ gridX: index })
          .where(
            and(
              eq(dashboardWorkflowPins.dashboardId, dashboardId),
              eq(dashboardWorkflowPins.workflowId, id),
            ),
          );
      }
      if (kind === "widget") {
        return db
          .update(dashboardWidgets)
          .set({ gridX: index })
          .where(and(eq(dashboardWidgets.dashboardId, dashboardId), eq(dashboardWidgets.id, id)));
      }
      return db
        .update(dashboardPins)
        .set({ gridX: index, syncVersion: nextPinSyncVersion(organizationId) })
        .where(and(eq(dashboardPins.dashboardId, dashboardId), eq(dashboardPins.resourceId, id)));
    }),
  );

  return c.json({ ok: true });
});

/** POST /api/dashboards/unpin */
app.post("/unpin", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const { dashboardId, resourceId } = await c.req.json<{
    dashboardId: string;
    resourceId: string;
  }>();

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  // Hard delete. A tombstone would be what tells a pulling client the pin went
  // away, but desktop sync is push-only (see electron/cloud-sync.ts) so nothing
  // consumes one — it would just accumulate rows. Revisit alongside any future
  // downward apply: deletions are invisible to a puller without it.
  await db
    .delete(dashboardPins)
    .where(
      and(eq(dashboardPins.dashboardId, dashboardId), eq(dashboardPins.resourceId, resourceId)),
    );
  return c.json({ ok: true });
});

/** POST /api/dashboards/workflow-pin — pin a workflow's metrics onto a dashboard */
app.post("/workflow-pin", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const { dashboardId, workflowId } = await c.req.json<{
    dashboardId: string;
    workflowId: string;
  }>();

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  const [workflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
    .limit(1);
  if (!workflow) return c.json({ error: "Workflow not found" }, 404);

  await db
    .insert(dashboardWorkflowPins)
    .values({
      id: uuidv4(),
      organizationId,
      dashboardId,
      workflowId,
      gridX: await nextGridX(dashboardId),
    })
    .onConflictDoNothing();
  return c.json({ ok: true });
});

/** POST /api/dashboards/workflow-unpin — remove a pinned workflow */
app.post("/workflow-unpin", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const { dashboardId, workflowId } = await c.req.json<{
    dashboardId: string;
    workflowId: string;
  }>();

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  await db
    .delete(dashboardWorkflowPins)
    .where(
      and(
        eq(dashboardWorkflowPins.dashboardId, dashboardId),
        eq(dashboardWorkflowPins.workflowId, workflowId),
      ),
    );
  return c.json({ ok: true });
});

/** POST /api/dashboards/validate-tabs — validate which workspace tab targets still exist */
app.post("/validate-tabs", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  const { tabs } = await c.req.json<{
    tabs: Array<{
      id: string;
      target: {
        kind: string;
        dashboardId?: string;
        accountId?: string;
        resourceId?: string;
        conversationId?: string;
      };
    }>;
  }>();

  const validIds = new Set<string>();

  for (const tab of tabs) {
    const { target } = tab;
    if (
      target.kind === "agents" ||
      target.kind === "costs" ||
      // Retired in favour of a section on Costs, but still valid for older
      // clients that have the tab open and a panel to render it with.
      target.kind === "savings" ||
      target.kind === "graph" ||
      target.kind === "logs" ||
      target.kind === "changes" ||
      target.kind === "expiring" ||
      target.kind === "posture" ||
      target.kind === "dns" ||
      target.kind === "environment-diff" ||
      target.kind === "ssh-fanout" ||
      target.kind === "metric-alerts" ||
      target.kind === "probes" ||
      target.kind === "workflows" ||
      target.kind === "deployments" ||
      target.kind === "settings"
    ) {
      validIds.add(tab.id);
    } else if (target.kind === "chat") {
      // The conversation-list tab is always valid; a conversation tab only
      // survives while the caller's own conversation is unarchived.
      if (!target.conversationId) {
        validIds.add(tab.id);
      } else {
        const [row] = await db
          .select({ id: chatConversations.id })
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.id, target.conversationId),
              eq(chatConversations.organizationId, organizationId),
              eq(chatConversations.userId, userId),
              isNull(chatConversations.archivedAt),
            ),
          )
          .limit(1);
        if (row) validIds.add(tab.id);
      }
    } else if (target.kind === "dashboard" && target.dashboardId) {
      const [row] = await db
        .select({ id: dashboards.id, name: dashboards.name })
        .from(dashboards)
        .where(
          and(
            eq(dashboards.id, target.dashboardId),
            eq(dashboards.organizationId, organizationId),
            isNull(dashboards.deletedAt),
          ),
        )
        .limit(1);
      if (row) validIds.add(tab.id);
    } else if (target.kind === "account" && target.accountId) {
      const [row] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, target.accountId),
            eq(accounts.organizationId, organizationId),
            isNull(accounts.deletedAt),
          ),
        )
        .limit(1);
      if (row) validIds.add(tab.id);
    } else if (target.kind === "resource" && target.resourceId) {
      const [row] = await db
        .select({ id: resources.id })
        .from(resources)
        .where(
          and(
            eq(resources.id, target.resourceId),
            eq(resources.organizationId, organizationId),
            isNull(resources.deletedAt),
          ),
        )
        .limit(1);
      if (row) validIds.add(tab.id);
    }
  }

  return c.json({ validTabIds: [...validIds] });
});

/**
 * Build the ProbeStatus dashboard cards consume, from data already fetched
 * out of ClickHouse. Sparkline = first MetricSeries with ≥2 points.
 */
function projectProbeStatus(row: {
  resourceTypeId: string;
  latestStats: Awaited<ReturnType<typeof getLatestStats>>;
  latestMetrics: Awaited<ReturnType<typeof getLatestMetrics>>;
  accountCounts: { typeLabel: string; count: number }[] | null;
}): ProbeStatus {
  if (row.resourceTypeId === "__account__") {
    return { phase: "ok", resourceCounts: row.accountCounts ?? [] };
  }
  const result: ProbeStatus = { phase: "ok" };
  if (row.latestStats) result.stats = row.latestStats;
  const firstSeries = row.latestMetrics?.[0];
  if (firstSeries && firstSeries.points.length >= 2) {
    result.sparkline = firstSeries.points;
    result.sparklineLabel = firstSeries.label;
  }
  return result;
}

/** GET /api/dashboards/pin/:pinId — full enriched pin data + probed status */
app.get("/pin/:pinId", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const pinId = c.req.param("pinId");

  const [pin] = await db
    .select({
      pinId: dashboardPins.id,
      resourceId: dashboardPins.resourceId,
      gridX: dashboardPins.gridX,
      gridY: dashboardPins.gridY,
      gridW: dashboardPins.gridW,
      gridH: dashboardPins.gridH,
      displayName: resources.displayName,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      dashboardOrgId: dashboards.organizationId,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .innerJoin(dashboards, eq(dashboardPins.dashboardId, dashboards.id))
    .innerJoin(accounts, eq(resources.accountId, accounts.id))
    .where(
      and(
        eq(dashboardPins.id, pinId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);

  if (!pin) return c.json({ error: "Pin not found" }, 404);

  const loaded = await getPlugin(pin.pluginId);
  const pluginLogoSvg = loaded?.plugin.manifest.logoSvg ?? "";
  const pluginDisplayName = loaded?.plugin.manifest.displayName ?? pin.pluginId;

  const [latestStats, latestMetrics, accountCounts] = await Promise.all([
    pin.resourceTypeId === "__account__"
      ? Promise.resolve(null)
      : getLatestStats(organizationId, pin.resourceId),
    pin.resourceTypeId === "__account__"
      ? Promise.resolve(null)
      : getLatestMetrics(organizationId, pin.resourceId),
    pin.resourceTypeId === "__account__"
      ? ((await getLatestAccountCountsBatch(organizationId, [pin.accountId])).get(pin.accountId) ??
        null)
      : Promise.resolve(null),
  ]);

  const status = projectProbeStatus({
    resourceTypeId: pin.resourceTypeId,
    latestStats,
    latestMetrics,
    accountCounts,
  });

  const { dashboardOrgId: _omit, ...pinFields } = pin;
  return c.json({ ...pinFields, pluginLogoSvg, pluginDisplayName, status });
});

/** GET /api/dashboards/pin/:pinId/range?fromMs=…&toMs=… — historical metric series */
app.get("/pin/:pinId/range", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const pinId = c.req.param("pinId");
  const fromMs = Number(c.req.query("fromMs"));
  const toMs = Number(c.req.query("toMs"));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return c.json({ error: "Invalid fromMs/toMs" }, 400);
  }

  const [pin] = await db
    .select({
      resourceId: dashboardPins.resourceId,
      resourceTypeId: resources.resourceTypeId,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .innerJoin(dashboards, eq(dashboardPins.dashboardId, dashboards.id))
    .where(
      and(
        eq(dashboardPins.id, pinId),
        eq(dashboards.organizationId, organizationId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!pin) return c.json({ error: "Pin not found" }, 404);
  if (pin.resourceTypeId === "__account__") return c.json({ series: [] });

  const series = await getMetricRange(organizationId, pin.resourceId, fromMs, toMs);
  return c.json({ series });
});

/** POST /api/dashboards/probe — read cached stats/metrics for dashboard cards */
app.post("/probe", async (c) => {
  requirePermission(c, "dashboards:read");
  const organizationId = c.get("organizationId");
  const { items } = await c.req.json<{
    items: Array<{
      resourceId: string;
      accountId: string;
      pluginId: string;
      resourceTypeId: string;
    }>;
  }>();

  const results: Record<string, ProbeStatus> = {};
  if (items.length === 0) return c.json(results);

  const rows = await db
    .select({
      resourceId: resources.id,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
    })
    .from(resources)
    .innerJoin(accounts, eq(resources.accountId, accounts.id))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(
          resources.id,
          items.map((i) => i.resourceId),
        ),
      ),
    );

  const byId = new Map(rows.map((r) => [r.resourceId, r]));

  const resourceIdsForMetrics = rows.flatMap((r) =>
    r.resourceTypeId !== "__account__" ? [r.resourceId] : [],
  );
  const accountIdsForCounts = [
    ...new Set(rows.flatMap((r) => (r.resourceTypeId === "__account__" ? [r.accountId] : []))),
  ];

  const [statsByResource, metricsByResource, countsByAccount] = await Promise.all([
    getLatestStatsBatch(organizationId, resourceIdsForMetrics),
    getLatestMetricsBatch(organizationId, resourceIdsForMetrics),
    getLatestAccountCountsBatch(organizationId, accountIdsForCounts),
  ]);

  for (const item of items) {
    const row = byId.get(item.resourceId);
    if (!row) {
      results[item.resourceId] = { phase: "error", error: "Resource not found" };
      continue;
    }
    results[item.resourceId] = projectProbeStatus({
      resourceTypeId: row.resourceTypeId,
      latestStats: statsByResource.get(row.resourceId) ?? null,
      latestMetrics: metricsByResource.get(row.resourceId) ?? null,
      accountCounts: countsByAccount.get(row.accountId) ?? null,
    });
  }

  return c.json(results);
});

export { app as dashboardRoutes };
