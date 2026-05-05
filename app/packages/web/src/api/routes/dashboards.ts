import { Hono } from "hono";
import { eq, and, inArray, isNull, desc, max } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { DashboardStat, MetricSeries, ProbeStatus } from "@infrawrench/plugin-base";
import { db } from "../../db/client";
import { dashboards, dashboardPins, resources, accounts } from "../../db/schema";
import type { AuthSession } from "../auth-middleware";
import { getPlugin } from "../../plugins/loader";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/dashboards — list all dashboards */
app.get("/", async (c) => {
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

  return c.json({ dashboard, pins });
});

/** GET /api/dashboards/default/full — get-or-create default dashboard with pins */
app.get("/default/full", async (c) => {
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

  return c.json({ dashboard: defaultDashboard, pins });
});

/** POST /api/dashboards/:id/rename */
app.post("/:id/rename", async (c) => {
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

/** POST /api/dashboards/validate-tabs — validate which workspace tab targets still exist */
app.post("/validate-tabs", async (c) => {
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
    if (target.kind === "dashboard" && target.dashboardId) {
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
 * Project cached stats/metrics JSON blobs (written by the poller) into the ProbeStatus
 * shape the dashboard UI expects. Sparkline is derived from the first MetricSeries with
 * enough points — same logic as the old live path.
 */
function projectProbeStatus(row: {
  resourceTypeId: string;
  latestStatsJson: unknown;
  latestMetricsJson: unknown;
  accountStatsJson: unknown;
}): ProbeStatus {
  if (row.resourceTypeId === "__account__") {
    const account = row.accountStatsJson as {
      resourceCounts?: ProbeStatus["resourceCounts"];
    } | null;
    return { phase: "ok", resourceCounts: account?.resourceCounts ?? [] };
  }
  const result: ProbeStatus = { phase: "ok" };
  const stats = row.latestStatsJson as DashboardStat[] | null;
  if (stats) result.stats = stats;
  const metrics = row.latestMetricsJson as MetricSeries[] | null;
  const firstSeries = metrics?.[0];
  if (firstSeries && firstSeries.points.length >= 2) {
    result.sparkline = firstSeries.points;
    result.sparklineLabel = firstSeries.label;
  }
  return result;
}

/** GET /api/dashboards/pin/:pinId — full enriched pin data + probed status */
app.get("/pin/:pinId", async (c) => {
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
      latestStatsJson: resources.latestStatsJson,
      latestMetricsJson: resources.latestMetricsJson,
      accountStatsJson: accounts.latestStatsJson,
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

  const status = projectProbeStatus(pin);

  const {
    dashboardOrgId: _omit,
    latestStatsJson: _s,
    latestMetricsJson: _m,
    accountStatsJson: _a,
    ...pinFields
  } = pin;
  return c.json({ ...pinFields, pluginLogoSvg, pluginDisplayName, status });
});

/** POST /api/dashboards/probe — read cached stats/metrics for dashboard cards */
app.post("/probe", async (c) => {
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
      latestStatsJson: resources.latestStatsJson,
      latestMetricsJson: resources.latestMetricsJson,
      accountStatsJson: accounts.latestStatsJson,
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
  for (const item of items) {
    const row = byId.get(item.resourceId);
    results[item.resourceId] = row
      ? projectProbeStatus(row)
      : { phase: "error", error: "Resource not found" };
  }

  return c.json(results);
});

export { app as dashboardRoutes };
