import { Hono } from "hono";
import { eq, and, inArray, isNull, desc, max } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { ProbeStatus } from "@infrawrench/plugin-base";
import type { StoredWorkflowMetricDef as MetricDef } from "@infrawrench/ui/workflows";
import { db } from "../../db/client";
import {
  dashboards,
  dashboardPins,
  dashboardWorkflowPins,
  resources,
  accounts,
  workflows,
  workflowMetrics,
  workflowRuns,
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

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

export interface WorkflowPinDto {
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

  return c.json({ dashboard, pins, workflowPins });
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

  return c.json({ dashboard: defaultDashboard, pins, workflowPins });
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

  // When no explicit position, place at the end
  let effectiveGridX = gridX ?? 0;
  if (gridX == null) {
    const [maxRow] = await db
      .select({ maxX: max(dashboardPins.gridX) })
      .from(dashboardPins)
      .where(eq(dashboardPins.dashboardId, dashboardId));
    effectiveGridX = (maxRow?.maxX ?? -1) + 1;
  }

  await db
    .insert(dashboardPins)
    .values({ id: uuidv4(), dashboardId, resourceId, gridX: effectiveGridX, gridY: gridY ?? 0 })
    .onConflictDoNothing();
  return c.json({ ok: true });
});

/** POST /api/dashboards/:id/reorder — persist card order */
app.post("/:id/reorder", async (c) => {
  requirePermission(c, "dashboards:write");
  const organizationId = c.get("organizationId");
  const dashboardId = c.req.param("id");
  const { resourceIds } = await c.req.json<{ resourceIds: string[] }>();

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  // Update grid_x for each pin to reflect the new order
  await Promise.all(
    resourceIds.map((resourceId, index) =>
      db
        .update(dashboardPins)
        .set({ gridX: index })
        .where(
          and(eq(dashboardPins.dashboardId, dashboardId), eq(dashboardPins.resourceId, resourceId)),
        ),
    ),
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

  const [maxRow] = await db
    .select({ maxX: max(dashboardWorkflowPins.gridX) })
    .from(dashboardWorkflowPins)
    .where(eq(dashboardWorkflowPins.dashboardId, dashboardId));

  await db
    .insert(dashboardWorkflowPins)
    .values({
      id: uuidv4(),
      organizationId,
      dashboardId,
      workflowId,
      gridX: (maxRow?.maxX ?? -1) + 1,
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
  const { tabs } = await c.req.json<{
    tabs: Array<{
      id: string;
      target: {
        kind: string;
        dashboardId?: string;
        accountId?: string;
        resourceId?: string;
      };
    }>;
  }>();

  const validIds = new Set<string>();

  for (const tab of tabs) {
    const { target } = tab;
    if (target.kind === "agents" || target.kind === "workflows") {
      validIds.add(tab.id);
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
