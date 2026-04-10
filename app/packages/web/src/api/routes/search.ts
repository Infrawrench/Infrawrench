import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources } from "../../db/schema";
import { getPlugin } from "../../plugins/loader";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/search?q=... — search resources across all accounts */
app.get("/", async (c) => {
  const { organizationId } = c.get("session");
  const q = (c.req.query("q") ?? "").toLowerCase().trim();

  // Load all resources for the org
  const allResources = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
      fieldsJson: resources.fieldsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)));

  // Load account names
  const allAccounts = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));

  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

  // Enrich with plugin metadata and filter
  const pluginCache = new Map<string, { logoSvg: string; displayName: string; resourceTypes: Map<string, string> }>();

  const results = [];
  for (const r of allResources) {
    let pluginMeta = pluginCache.get(r.pluginId);
    if (!pluginMeta) {
      const loaded = await getPlugin(r.pluginId);
      if (loaded) {
        const rtMap = new Map(loaded.plugin.resourceTypes.map((rt) => [rt.id, rt.displayName]));
        pluginMeta = { logoSvg: loaded.plugin.manifest.logoSvg, displayName: loaded.plugin.manifest.displayName, resourceTypes: rtMap };
      } else {
        pluginMeta = { logoSvg: "", displayName: r.pluginId, resourceTypes: new Map() };
      }
      pluginCache.set(r.pluginId, pluginMeta);
    }

    const account = accountMap.get(r.accountId);
    const accountName = account?.displayName ?? "";
    const resourceTypeLabel = pluginMeta.resourceTypes.get(r.resourceTypeId) ?? r.resourceTypeId;

    // Filter by query
    if (q) {
      const searchable = `${r.displayName} ${accountName} ${pluginMeta.displayName} ${resourceTypeLabel}`.toLowerCase();
      if (!searchable.includes(q)) continue;
    }

    results.push({
      id: r.id,
      pluginId: r.pluginId,
      pluginDisplayName: pluginMeta.displayName,
      pluginLogoSvg: pluginMeta.logoSvg,
      resourceTypeId: r.resourceTypeId,
      resourceTypeLabel,
      accountId: r.accountId,
      accountName,
      displayName: r.displayName,
    });

    if (results.length >= 50) break;
  }

  return c.json(results);
});

export { app as searchRoutes };
