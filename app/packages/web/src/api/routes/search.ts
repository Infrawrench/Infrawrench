import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, resources, workflows } from "../../db/schema";

// Inline workflow glyph for the spotlight group header (matches WorkflowIcon).
const WORKFLOW_LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/></svg>`;
import { getPlugin } from "../../plugins/loader";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/** GET /api/search?q=... — search resources across all accounts */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const q = (c.req.query("q") ?? "").toLowerCase().trim();

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

  const allAccounts = await db
    .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));

  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

  const pluginCache = new Map<
    string,
    { logoSvg: string; displayName: string; resourceTypes: Map<string, string> }
  >();

  const results = [];
  for (const r of allResources) {
    let pluginMeta = pluginCache.get(r.pluginId);
    if (!pluginMeta) {
      const loaded = await getPlugin(r.pluginId);
      if (loaded) {
        const rtMap = new Map(loaded.plugin.resourceTypes.map((rt) => [rt.id, rt.displayName]));
        pluginMeta = {
          logoSvg: loaded.plugin.manifest.logoSvg,
          displayName: loaded.plugin.manifest.displayName,
          resourceTypes: rtMap,
        };
      } else {
        pluginMeta = { logoSvg: "", displayName: r.pluginId, resourceTypes: new Map() };
      }
      pluginCache.set(r.pluginId, pluginMeta);
    }

    const account = accountMap.get(r.accountId);
    const accountName = account?.displayName ?? "";
    const resourceTypeLabel = pluginMeta.resourceTypes.get(r.resourceTypeId) ?? r.resourceTypeId;

    if (q) {
      const searchable =
        `${r.displayName} ${accountName} ${pluginMeta.displayName} ${resourceTypeLabel}`.toLowerCase();
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

  // Workflows are navigation targets too — index them by name.
  const wfRows = await db
    .select({ id: workflows.id, name: workflows.name, trigger: workflows.trigger })
    .from(workflows)
    .where(and(eq(workflows.organizationId, organizationId), isNull(workflows.deletedAt)));
  for (const w of wfRows) {
    if (q && !w.name.toLowerCase().includes(q)) continue;
    const triggerKind = (w.trigger as { kind?: string } | null)?.kind ?? "manual";
    results.push({
      id: w.id,
      pluginId: "__workflows__",
      pluginDisplayName: "Workflows",
      pluginLogoSvg: WORKFLOW_LOGO_SVG,
      resourceTypeId: "__workflow__",
      resourceTypeLabel: "Workflow",
      accountId: "",
      accountName: "",
      displayName: w.name,
      subtitle: `${triggerKind} trigger`,
    });
  }

  return c.json(results);
});

export { app as searchRoutes };
