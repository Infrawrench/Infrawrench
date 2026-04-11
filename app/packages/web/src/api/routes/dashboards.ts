import { Hono } from "hono";
import { eq, and, isNull, desc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db/client";
import { dashboards, dashboardPins, resources, accounts } from "../../db/schema";
import type { AuthSession } from "../auth-middleware";
import { getPlugin } from "../../plugins/loader";
import { syncAccountResources } from "./accounts";
import { decrypt } from "../../services/encryption";
import { buildPluginHostServices } from "../../services/host-services";
import { sqlDrivers, kvDrivers, dockerDrivers } from "../../services/drivers";
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
  const organizationId = c.get("organizationId");

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
  await db.delete(dashboards).where(and(eq(dashboards.id, dashboardId), eq(dashboards.organizationId, organizationId)));
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

  await db
    .insert(dashboardPins)
    .values({ id: uuidv4(), dashboardId, resourceId, gridX: gridX ?? 0, gridY: gridY ?? 0 })
    .onConflictDoNothing();
  return c.json({ ok: true });
});

/** POST /api/dashboards/unpin */
app.post("/unpin", async (c) => {
  const organizationId = c.get("organizationId");
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

  // Batch-check which dashboards/accounts/resources still exist
  const validIds = new Set<string>();

  for (const tab of tabs) {
    const { target } = tab;
    if (target.kind === "dashboard" && target.dashboardId) {
      const [row] = await db
        .select({ id: dashboards.id, name: dashboards.name })
        .from(dashboards)
        .where(and(eq(dashboards.id, target.dashboardId), eq(dashboards.organizationId, organizationId), isNull(dashboards.deletedAt)))
        .limit(1);
      if (row) validIds.add(tab.id);
    } else if (target.kind === "account" && target.accountId) {
      const [row] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, target.accountId), eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)))
        .limit(1);
      if (row) validIds.add(tab.id);
    } else if (target.kind === "resource" && target.resourceId) {
      const [row] = await db
        .select({ id: resources.id })
        .from(resources)
        .where(and(eq(resources.id, target.resourceId), eq(resources.organizationId, organizationId), isNull(resources.deletedAt)))
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

  const results: Record<string, {
    phase: "ok" | "error";
    pgVersion?: string;
    dbSize?: string;
    tableCount?: number;
    tableCountLabel?: string;
    resourceCounts?: Array<{ typeLabel: string; count: number }>;
    error?: string;
  }> = {};

  // Cache decrypted credentials per account
  const credsByAccount = new Map<string, Record<string, string>>();

  async function getCredentials(accountId: string) {
    const cached = credsByAccount.get(accountId);
    if (cached) return cached;
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
    const creds = JSON.parse(plaintext) as Record<string, string>;
    credsByAccount.set(accountId, creds);
    return creds;
  }

  await Promise.allSettled(items.map(async (item) => {
    const creds = await getCredentials(item.accountId);
    if (!creds) {
      results[item.resourceId] = { phase: "error", error: "Account not found" };
      return;
    }

    const loaded = await getPlugin(item.pluginId);
    if (!loaded) {
      results[item.resourceId] = { phase: "error", error: `Plugin not found: ${item.pluginId}` };
      return;
    }

    const manifest = loaded.plugin.manifest;

    // Account summary card
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

    // KV driver (Redis, Memcached)
    if (manifest.kvDriver) {
      const cs = creds[manifest.kvDriver.credentialKey] ?? "";
      const driver = kvDrivers.get(manifest.kvDriver.driver);
      if (driver) {
        const hostServices = buildPluginHostServices(manifest, creds);
        const client = loaded.plugin.createClient(creds, hostServices);
        const stats = await client.fetchStats?.();
        const { version = "", size = "" } = stats ?? {};
        results[item.resourceId] = { phase: "ok", pgVersion: version, dbSize: size };
        return;
      }
    }

    // Docker driver
    if (manifest.dockerDriver) {
      const dockerHost = creds[manifest.dockerDriver.credentialKey] ?? "";
      const driver = dockerDrivers.get(manifest.dockerDriver.driver);
      if (driver) {
        const hostServices = buildPluginHostServices(manifest, creds);
        const client = loaded.plugin.createClient(creds, hostServices);
        const stats = await client.fetchStats?.();
        const { version = "", size = "", tableCount = 0 } = stats ?? {};
        results[item.resourceId] = { phase: "ok", pgVersion: version, dbSize: size, tableCount, tableCountLabel: "Running" };
        return;
      }
    }

    // Storage resource
    const storageType = loaded.plugin.resourceTypes.find(
      (t) => t.id === item.resourceTypeId && t.supportsStorageBrowser,
    );
    if (storageType) {
      const client = loaded.plugin.createClient(creds);
      const bucketName = item.resourceId.split(":").slice(2).join(":");
      const stats = await (client as { fetchStorageStats?(b: string): Promise<{ count: number; size: string }> })
        .fetchStorageStats?.(bucketName);
      results[item.resourceId] = {
        phase: "ok",
        ...(stats?.count !== undefined ? { tableCount: stats.count } : {}),
        tableCountLabel: "Objects",
        ...(stats?.size !== undefined ? { dbSize: stats.size } : {}),
      };
      return;
    }

    // SQL driver
    if (manifest.sqlDriver) {
      const cs = creds[manifest.sqlDriver.credentialKey] ?? "";
      const driver = sqlDrivers.get(manifest.sqlDriver.driver);
      if (driver) {
        const hostServices = buildPluginHostServices(manifest, creds);
        const client = loaded.plugin.createClient(creds, hostServices);
        const stats = await client.fetchStats?.();
        const { version = "", size = "", tableCount = 0 } = stats ?? {};
        results[item.resourceId] = { phase: "ok", pgVersion: version, dbSize: size, tableCount };
        return;
      }
    }

    // No connectable driver — mark as ok with no stats
    results[item.resourceId] = { phase: "ok" };
  }));

  // Convert unhandled rejections to errors
  for (const item of items) {
    if (!results[item.resourceId]) {
      results[item.resourceId] = { phase: "error", error: "Probe failed" };
    }
  }

  return c.json(results);
});

export { app as dashboardRoutes };
