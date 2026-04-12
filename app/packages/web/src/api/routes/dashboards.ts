import { Hono } from "hono";
import { eq, and, isNull, desc, max } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { dashboards, dashboardPins, resources, accounts } from "../../db/schema";
import type { AuthSession } from "../auth-middleware";
import { getPlugin } from "../../plugins/loader";
import { syncAccountResources } from "./accounts";
import { decrypt } from "../../services/encryption";
import { buildPluginHostServices } from "../../services/host-services";
import { getListableResourceTypes } from "@infrawrench/ui";

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
          ? {
              logoSvg: loaded.plugin.manifest.logoSvg,
              displayName: loaded.plugin.manifest.displayName,
            }
          : { logoSvg: "", displayName: pin.pluginId as string };
        pluginCache.set(pin.pluginId as string, meta);
      }
      return { ...pin, pluginLogoSvg: meta.logoSvg, pluginDisplayName: meta.displayName };
    }),
  );
}

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
    .where(
      and(
        eq(dashboardPins.dashboardId, dashboardId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .orderBy(dashboardPins.gridX, dashboardPins.createdAt);

  const pins = await enrichPins(rawPins);
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
    .where(
      and(
        eq(dashboardPins.dashboardId, defaultDashboard.id),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    )
    .orderBy(dashboardPins.gridX, dashboardPins.createdAt);

  const pins = await enrichPins(rawPins);
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

/** POST /api/dashboards/probe — probe resource status for dashboard cards */
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

  const results: Record<
    string,
    {
      phase: "ok" | "error";
      resourceCounts?: Array<{ typeLabel: string; count: number }>;
      stats?: Array<{ label: string; value: string; variant?: string }>;
      sparkline?: Array<{ timestamp: number; value: number }>;
      sparklineLabel?: string;
      error?: string;
    }
  > = {};

  const credsByAccount = new Map<string, Promise<Record<string, string> | null>>();
  const pluginsById = new Map<string, ReturnType<typeof getPlugin>>();

  async function getCredentials(accountId: string) {
    const cached = credsByAccount.get(accountId);
    if (cached) return cached;
    const pending = (async () => {
      const [account] = await db
        .select({
          encryptedCredentials: accounts.encryptedCredentials,
          credentialsIv: accounts.credentialsIv,
        })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
        .limit(1);
      if (!account) return null;
      const plaintext = await decrypt(account.encryptedCredentials, account.credentialsIv);
      return JSON.parse(plaintext) as Record<string, string>;
    })();
    credsByAccount.set(accountId, pending);
    return pending;
  }

  function getCachedPlugin(pluginId: string) {
    const cached = pluginsById.get(pluginId);
    if (cached) return cached;
    const pending = getPlugin(pluginId);
    pluginsById.set(pluginId, pending);
    return pending;
  }

  await Promise.allSettled(
    items.map(async (item) => {
      const creds = await getCredentials(item.accountId);
      if (!creds) {
        results[item.resourceId] = { phase: "error", error: "Account not found" };
        return;
      }

      const loaded = await getCachedPlugin(item.pluginId);
      if (!loaded) {
        results[item.resourceId] = { phase: "error", error: `Plugin not found: ${item.pluginId}` };
        return;
      }

      const manifest = loaded.plugin.manifest;

      if (item.resourceTypeId === "__account__") {
        const topLevelTypes = getListableResourceTypes(loaded.plugin.resourceTypes);
        const hostServices = buildPluginHostServices(manifest, creds);
        const client = loaded.plugin.createClient(creds, hostServices);
        const counts = await Promise.allSettled(
          topLevelTypes.map(async (t) => ({
            typeLabel: t.pluralDisplayName,
            count: (await client.listResources(t.id, item.accountId)).length,
          })),
        );
        const resourceCounts = counts
          .filter((r) => r.status === "fulfilled" && r.value.count > 0)
          .map((r) => (r as PromiseFulfilledResult<{ typeLabel: string; count: number }>).value);
        results[item.resourceId] = { phase: "ok", resourceCounts };
        return;
      }

      // Unified stats path — all plugins implement fetchDashboardStats
      const hostServices = buildPluginHostServices(manifest, creds);
      const client = loaded.plugin.createClient(creds, hostServices);
      if (client.fetchDashboardStats) {
        const resourceTypeDef = loaded.plugin.resourceTypes.find(
          (t) => t.id === item.resourceTypeId,
        );
        const [statsResult, metricResult] = await Promise.allSettled([
          client.fetchDashboardStats(item.resourceTypeId, item.resourceId, item.accountId),
          resourceTypeDef?.supportsMetrics && client.fetchMetricSeries
            ? client.fetchMetricSeries(item.resourceTypeId, item.resourceId, item.accountId)
            : Promise.resolve(null),
        ]);
        const result: (typeof results)[string] = { phase: "ok" };

        if (statsResult.status === "fulfilled") {
          result.stats = statsResult.value;
        }

        if (metricResult.status === "fulfilled") {
          const first = metricResult.value?.[0];
          if (first && first.points.length >= 2) {
            result.sparkline = first.points;
            result.sparklineLabel = first.label;
          }
        }

        results[item.resourceId] = result;
      } else {
        results[item.resourceId] = { phase: "ok" };
      }
    }),
  );

  for (const item of items) {
    if (!results[item.resourceId]) {
      results[item.resourceId] = { phase: "error", error: "Probe failed" };
    }
  }

  return c.json(results);
});

export { app as dashboardRoutes };
