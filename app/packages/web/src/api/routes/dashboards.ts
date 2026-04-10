import { Hono } from "hono";
import { eq, and, isNull, desc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { dashboards, dashboardPins, resources } from "../../db/schema";
import type { AuthSession } from "../auth-middleware";
import { getPlugin } from "../../plugins/loader";
import { syncAccountResources } from "./accounts";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** Sync all accounts that have pinned resources on a dashboard */
async function syncPinnedAccounts(dashboardId: string, organizationId: string) {
  const pinAccountRows = await db
    .select({ accountId: resources.accountId })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(and(eq(dashboardPins.dashboardId, dashboardId), isNull(dashboardPins.deletedAt)));
  const uniqueAccountIds = [...new Set(pinAccountRows.map((r) => r.accountId))];
  await Promise.allSettled(
    uniqueAccountIds.map((accountId) => syncAccountResources(accountId, organizationId)),
  );
}

/** Enrich pins with plugin logo and display name */
async function enrichPins(pins: Array<{ pluginId: string; [key: string]: unknown }>) {
  const pluginCache = new Map<string, { logoSvg: string; displayName: string }>();
  return Promise.all(
    pins.map(async (pin) => {
      let meta = pluginCache.get(pin.pluginId);
      if (!meta) {
        const loaded = await getPlugin(pin.pluginId as string);
        meta = loaded
          ? { logoSvg: loaded.plugin.manifest.logoSvg, displayName: loaded.plugin.manifest.displayName }
          : { logoSvg: "", displayName: pin.pluginId as string };
        pluginCache.set(pin.pluginId as string, meta);
      }
      return { ...pin, pluginLogoSvg: meta.logoSvg, pluginDisplayName: meta.displayName };
    }),
  );
}

/** GET /api/dashboards — list all dashboards */
app.get("/", async (c) => {
  const { organizationId } = c.get("session");
  const rows = await db
    .select({ id: dashboards.id, name: dashboards.name, isDefault: dashboards.isDefault })
    .from(dashboards)
    .where(and(eq(dashboards.organizationId, organizationId), isNull(dashboards.deletedAt)))
    .orderBy(desc(dashboards.isDefault), dashboards.createdAt);
  return c.json(rows);
});

/** POST /api/dashboards — create a dashboard */
app.post("/", async (c) => {
  const { organizationId } = c.get("session");
  const { name } = await c.req.json<{ name: string }>();
  const [created] = await db
    .insert(dashboards)
    .values({ id: uuidv4(), organizationId, name, isDefault: false })
    .returning();
  return c.json(created);
});

/** GET /api/dashboards/:id — get dashboard with pins */
app.get("/:id", async (c) => {
  const { organizationId } = c.get("session");
  const dashboardId = c.req.param("id");

  const [dashboard] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId), isNull(dashboards.deletedAt)))
    .limit(1);

  if (!dashboard) return c.json({ error: "Not found" }, 404);

  // Sync pinned accounts so deleted/updated resources are reflected
  await syncPinnedAccounts(dashboardId, organizationId).catch(() => {});

  const rawPins = await db
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
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(and(eq(dashboardPins.dashboardId, dashboardId), isNull(dashboardPins.deletedAt), isNull(resources.deletedAt)));

  const pins = await enrichPins(rawPins);
  return c.json({ dashboard, pins });
});

/** GET /api/dashboards/default/full — get-or-create default dashboard with pins */
app.get("/default/full", async (c) => {
  const { organizationId } = c.get("session");

  let [defaultDashboard] = await db
    .select()
    .from(dashboards)
    .where(and(eq(dashboards.organizationId, organizationId), eq(dashboards.isDefault, true), isNull(dashboards.deletedAt)))
    .limit(1);

  if (!defaultDashboard) {
    const [created] = await db
      .insert(dashboards)
      .values({ id: uuidv4(), organizationId, name: "Home", isDefault: true })
      .returning();
    defaultDashboard = created!;
  }

  // Sync pinned accounts so deleted/updated resources are reflected
  await syncPinnedAccounts(defaultDashboard.id, organizationId).catch(() => {});

  const rawPins = await db
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
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(and(eq(dashboardPins.dashboardId, defaultDashboard.id), isNull(dashboardPins.deletedAt), isNull(resources.deletedAt)));

  const pins = await enrichPins(rawPins);
  return c.json({ dashboard: defaultDashboard, pins });
});

/** POST /api/dashboards/:id/rename */
app.post("/:id/rename", async (c) => {
  const { organizationId } = c.get("session");
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
  const { organizationId } = c.get("session");
  const dashboardId = c.req.param("id");

  const [dash] = await db
    .select({ isDefault: dashboards.isDefault })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);

  if (!dash) return c.json({ error: "Not found" }, 404);
  if (dash.isDefault) return c.json({ error: "Cannot delete the default dashboard" }, 400);

  await db.delete(dashboardPins).where(eq(dashboardPins.dashboardId, dashboardId));
  await db.delete(dashboards).where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)));
  return c.json({ ok: true });
});

/** POST /api/dashboards/pin */
app.post("/pin", async (c) => {
  const { organizationId } = c.get("session");
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

  await db
    .insert(dashboardPins)
    .values({ id: uuidv4(), dashboardId, resourceId, gridX: gridX ?? 0, gridY: gridY ?? 0 })
    .onConflictDoNothing();
  return c.json({ ok: true });
});

/** POST /api/dashboards/unpin */
app.post("/unpin", async (c) => {
  const { organizationId } = c.get("session");
  const { dashboardId, resourceId } = await c.req.json<{ dashboardId: string; resourceId: string }>();

  const [dashboard] = await db
    .select({ id: dashboards.id })
    .from(dashboards)
    .where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)))
    .limit(1);
  if (!dashboard) return c.json({ error: "Dashboard not found" }, 404);

  await db.delete(dashboardPins).where(and(eq(dashboardPins.dashboardId, dashboardId), eq(dashboardPins.resourceId, resourceId)));
  return c.json({ ok: true });
});

export { app as dashboardRoutes };
