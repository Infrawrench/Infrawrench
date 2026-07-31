import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { accounts, associations, resources, secretFieldStates } from "../../db/schema";
import { getPlugin } from "../../plugins/loader";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

/**
 * GET /api/org/:orgId/dependency-graph — the org's resource dependency graph.
 *
 * Edges are output references: the `associations` topology rows plus the
 * `secret_field_states` output-ref rows (both are written when a reference is
 * created; the shared model dedupes the overlap by consumer field). Nodes are
 * the org resources that participate in at least one edge — the graph is
 * about references, so unreferenced resources stay off the canvas.
 *
 * Fully generic over the reference data: no plugin ever contributes edges
 * directly, so the host stays free of provider-specific topology code.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");

  const orgResources = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      displayName: resources.displayName,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)));
  const resourceById = new Map(orgResources.map((r) => [r.id, r]));

  // Consumer join scopes both edge sources to the org; provider ids are then
  // validated against the org's resource set below (buildDependencyGraph does
  // it again client-side, but there's no reason to ship foreign ids).
  const associationRows = await db
    .select({
      consumerResourceId: associations.consumerResourceId,
      consumerFieldKey: associations.consumerFieldKey,
      providerResourceId: associations.providerResourceId,
      providerOutputKey: associations.providerOutputKey,
    })
    .from(associations)
    .innerJoin(resources, eq(associations.consumerResourceId, resources.id))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        isNull(associations.deletedAt),
      ),
    );

  const refStateRows = await db
    .select({
      consumerResourceId: secretFieldStates.resourceId,
      consumerFieldKey: secretFieldStates.fieldKey,
      providerResourceId: secretFieldStates.sourceResourceId,
      providerOutputKey: secretFieldStates.sourceOutputKey,
    })
    .from(secretFieldStates)
    .innerJoin(resources, eq(secretFieldStates.resourceId, resources.id))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        eq(secretFieldStates.resolutionKind, "output-ref"),
      ),
    );

  // Associations first: they are the canonical topology rows, and the shared
  // model keeps the first edge it sees per (consumer, field).
  const edges: {
    consumerResourceId: string;
    consumerFieldKey: string;
    providerResourceId: string;
    providerOutputKey: string;
  }[] = [];
  const seen = new Set<string>();
  for (const row of [...associationRows, ...refStateRows]) {
    if (!row.providerResourceId || !row.providerOutputKey) continue;
    if (!resourceById.has(row.providerResourceId)) continue;
    if (row.providerResourceId === row.consumerResourceId) continue;
    const key = `${row.consumerResourceId} ${row.consumerFieldKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      consumerResourceId: row.consumerResourceId,
      consumerFieldKey: row.consumerFieldKey,
      providerResourceId: row.providerResourceId,
      providerOutputKey: row.providerOutputKey,
    });
  }

  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.consumerResourceId);
    connectedIds.add(edge.providerResourceId);
  }

  const orgAccounts = await db
    .select({ id: accounts.id, displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  const accountNameById = new Map(orgAccounts.map((a) => [a.id, a.displayName]));

  const pluginCache = new Map<
    string,
    { logoSvg: string; displayName: string; resourceTypes: Map<string, string> }
  >();
  const pluginMeta = async (pluginId: string) => {
    let meta = pluginCache.get(pluginId);
    if (!meta) {
      const loaded = await getPlugin(pluginId);
      meta = loaded
        ? {
            logoSvg: loaded.plugin.manifest.logoSvg,
            displayName: loaded.plugin.manifest.displayName,
            resourceTypes: new Map(
              loaded.plugin.resourceTypes.map((rt) => [rt.id, rt.displayName]),
            ),
          }
        : { logoSvg: "", displayName: pluginId, resourceTypes: new Map<string, string>() };
      pluginCache.set(pluginId, meta);
    }
    return meta;
  };

  const nodes = [];
  for (const id of connectedIds) {
    const r = resourceById.get(id);
    if (!r) continue;
    const meta = await pluginMeta(r.pluginId);
    nodes.push({
      id: r.id,
      displayName: r.displayName,
      pluginId: r.pluginId,
      pluginDisplayName: meta.displayName,
      pluginLogoSvg: meta.logoSvg,
      resourceTypeId: r.resourceTypeId,
      resourceTypeLabel: meta.resourceTypes.get(r.resourceTypeId) ?? r.resourceTypeId,
      accountId: r.accountId,
      accountName: accountNameById.get(r.accountId) ?? "",
    });
  }

  return c.json({ nodes, edges });
});

export { app as dependencyGraphRoutes };
