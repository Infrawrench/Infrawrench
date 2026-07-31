import { Hono } from "hono";
import { eq, and, or, inArray, isNull } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../../db/client";
import { accounts, associations, resources, secretFieldStates } from "../../db/schema";
import { loadPlugins } from "../../plugins/loader";
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
 * `?resourceId=` narrows the answer to one resource's direct neighbourhood:
 * only edges with that resource at one end, and only the nodes those edges
 * touch. The Dependencies tab on the resource-detail page asks for exactly
 * that and discards everything else, so without the filter the busiest page
 * in the app would pull the org's entire topology on every mount.
 *
 * Fully generic over the reference data: no plugin ever contributes edges
 * directly, so the host stays free of provider-specific topology code.
 */
app.get("/", async (c) => {
  requirePermission(c, "resources:read");
  const organizationId = c.get("organizationId");
  const focusId = c.req.query("resourceId")?.trim() || null;

  // Restricts both edge sources to rows touching the focused resource. `and()`
  // drops undefined, so the unfiltered org-wide read is the same query minus
  // this clause.
  const touchesFocus = (consumer: AnyPgColumn, provider: AnyPgColumn) =>
    focusId ? or(eq(consumer, focusId), eq(provider, focusId)) : undefined;

  // Independent reads — none feeds another's query, so they go to the pool
  // together instead of waterfalling. The consumer join scopes both edge
  // sources to the org; provider ids are then validated against the resource
  // set below (buildDependencyGraph does it again client-side, but there's no
  // reason to ship foreign ids).
  //
  // The resource read is the one exception. Org-wide it runs in the same
  // batch; focused, the ids worth fetching are only known once the edges are
  // back, and a second small keyed read beats scanning every resource in the
  // org to answer a question about one of them.
  const [associationRows, refStateRows, orgAccounts, unfilteredResources] = await Promise.all([
    db
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
          touchesFocus(associations.consumerResourceId, associations.providerResourceId),
        ),
      ),
    db
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
          touchesFocus(secretFieldStates.resourceId, secretFieldStates.sourceResourceId),
        ),
      ),
    db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    focusId
      ? Promise.resolve(null)
      : db
          .select({
            id: resources.id,
            pluginId: resources.pluginId,
            resourceTypeId: resources.resourceTypeId,
            accountId: resources.accountId,
            displayName: resources.displayName,
          })
          .from(resources)
          .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
  ]);

  let orgResources = unfilteredResources;
  if (!orgResources) {
    const wanted = new Set<string>([focusId!]);
    for (const row of [...associationRows, ...refStateRows]) {
      wanted.add(row.consumerResourceId);
      if (row.providerResourceId) wanted.add(row.providerResourceId);
    }
    orgResources = await db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
          inArray(resources.id, [...wanted]),
        ),
      );
  }
  const resourceById = new Map(orgResources.map((r) => [r.id, r]));
  const accountNameById = new Map(orgAccounts.map((a) => [a.id, a.displayName]));

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

  // One load, indexed by manifest id — `getPlugin` is a linear scan over the
  // same memoized list, so calling it per node re-scanned it every time and
  // made the per-request cache below unnecessary.
  const pluginById = new Map(
    (await loadPlugins()).map((loaded) => [loaded.plugin.manifest.id, loaded]),
  );

  const nodes = [];
  for (const id of connectedIds) {
    const r = resourceById.get(id);
    if (!r) continue;
    const loaded = pluginById.get(r.pluginId);
    nodes.push({
      id: r.id,
      displayName: r.displayName,
      pluginId: r.pluginId,
      pluginDisplayName: loaded?.plugin.manifest.displayName ?? r.pluginId,
      pluginLogoSvg: loaded?.plugin.manifest.logoSvg ?? "",
      resourceTypeId: r.resourceTypeId,
      resourceTypeLabel:
        loaded?.plugin.resourceTypes.find((rt) => rt.id === r.resourceTypeId)?.displayName ??
        r.resourceTypeId,
      accountId: r.accountId,
      accountName: accountNameById.get(r.accountId) ?? "",
    });
  }

  return c.json({ nodes, edges });
});

export { app as dependencyGraphRoutes };
