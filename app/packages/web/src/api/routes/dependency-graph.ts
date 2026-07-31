import { Hono } from "hono";
import { eq, and, or, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  collectDependencyRules,
  inferDependencyEdges,
  resourceIdentityTokens,
  resourceReferenceTokens,
  type DependencyGraphEdge,
  type InferenceResource,
} from "@infrawrench/client-core";
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

/** The resource columns both the graph and the inference pass read. */
const resourceColumns = {
  id: resources.id,
  pluginId: resources.pluginId,
  resourceTypeId: resources.resourceTypeId,
  accountId: resources.accountId,
  displayName: resources.displayName,
  externalId: resources.externalId,
  parentResourceId: resources.parentResourceId,
  fieldsJson: resources.fieldsJson,
  outputsJson: resources.outputsJson,
};

/** One row of `resourceColumns`, exactly as the select returns it. */
type ResourceRow = Awaited<ReturnType<typeof selectResources>>[number];

function selectResources() {
  return db.select(resourceColumns).from(resources);
}

/**
 * How many tokens a focused query is willing to push into the candidate SQL.
 * Each token costs a couple of `ILIKE`s over the org's resource JSON, and the
 * longest tokens are the ones that actually identify something — a resource
 * with more distinct field values than this is describing itself, not pointing
 * at things.
 */
const MAX_FOCUS_TOKENS = 8;

/**
 * LIKE patterns that find a token used as a JSON *value* rather than a key.
 * Values are quote- or comma-preceded in the serialized JSON (plugins flatten
 * lists into comma-joined strings), and numbers are colon-preceded and
 * unquoted. This only narrows the candidate rows — `inferDependencyEdges` still
 * does the exact matching — so an over-broad pattern costs time, never
 * correctness.
 */
function jsonValuePatterns(token: string): string[] {
  // `%`, `_` and `\` are wildcards in LIKE — a provider id containing one must
  // match literally.
  const escaped = token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const patterns = [`%"${escaped}%`, `%,${escaped}%`];
  if (/^[0-9]+$/.test(token)) patterns.push(`%:${escaped}%`);
  return patterns;
}

/**
 * GET /api/org/:orgId/dependency-graph — the org's resource dependency graph.
 *
 * Edges come from two places:
 *
 *  - **Output references** — the `associations` topology rows plus the
 *    `secret_field_states` output-ref rows (both are written when a reference
 *    is created; the shared model dedupes the overlap by consumer field).
 *  - **Synced cloud data** — `inferDependencyEdges` reads the wiring back out
 *    of what the poller already stored: `parent_resource_id`, and field values
 *    that exactly match another resource's identity (external id, name,
 *    endpoint, IP…). This is what makes the graph non-empty for an org that
 *    has never hand-wired a reference, which is most of them.
 *
 * Nodes are the org resources that participate in at least one edge — the
 * graph is about wiring, not inventory.
 *
 * `?resourceId=` narrows the answer to one resource's direct neighbourhood:
 * only edges with that resource at one end, and only the nodes those edges
 * touch. The Dependencies tab on the resource-detail page asks for exactly
 * that and discards everything else, so without the filter the busiest page in
 * the app would pull the org's entire topology on every mount.
 *
 * Fully generic over the data: no plugin ever contributes edges directly, so
 * the host stays free of provider-specific topology code.
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
  // The resource read is the one exception. Org-wide it runs in the same batch;
  // focused, the rows worth fetching are only known once the focus resource's
  // own fields are back, so it happens in `loadFocusedResources` below.
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
          .select(resourceColumns)
          .from(resources)
          .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
  ]);

  const referencedIds = new Set<string>();
  for (const row of [...associationRows, ...refStateRows]) {
    referencedIds.add(row.consumerResourceId);
    if (row.providerResourceId) referencedIds.add(row.providerResourceId);
  }

  const orgResources =
    unfilteredResources ?? (await loadFocusedResources(organizationId, focusId!, referencedIds));
  const resourceById = new Map(orgResources.map((r) => [r.id, r]));
  const accountNameById = new Map(orgAccounts.map((a) => [a.id, a.displayName]));

  // Associations first: they are the canonical topology rows, and the shared
  // model keeps the first edge it sees per (consumer, field, provider).
  const edges: DependencyGraphEdge[] = [];
  const seen = new Set<string>();
  for (const row of [...associationRows, ...refStateRows]) {
    if (!row.providerResourceId || !row.providerOutputKey) continue;
    if (!resourceById.has(row.providerResourceId)) continue;
    if (row.providerResourceId === row.consumerResourceId) continue;
    const key = `${row.consumerResourceId} ${row.consumerFieldKey} ${row.providerResourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      consumerResourceId: row.consumerResourceId,
      consumerFieldKey: row.consumerFieldKey,
      providerResourceId: row.providerResourceId,
      providerOutputKey: row.providerOutputKey,
      kind: "output-ref",
    });
  }

  // One load, indexed by manifest id — `getPlugin` is a linear scan over the
  // same memoized list, so calling it per node re-scanned it every time and
  // made the per-request cache below unnecessary. Loaded before inference
  // because the plugins' `dependsOn` declarations feed it.
  const plugins = await loadPlugins();
  const pluginById = new Map(plugins.map((loaded) => [loaded.plugin.manifest.id, loaded]));

  const inferred = inferDependencyEdges(orgResources.map(toInferenceResource), {
    existingEdges: edges,
    rules: collectDependencyRules(
      plugins.map((loaded) => ({
        id: loaded.plugin.manifest.id,
        resourceTypes: loaded.plugin.resourceTypes,
      })),
    ),
    ...(focusId ? { focusResourceId: focusId } : {}),
  });
  edges.push(...inferred.edges);

  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.consumerResourceId);
    connectedIds.add(edge.providerResourceId);
  }

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

  return c.json({ nodes, edges, truncated: inferred.truncated });
});

function toInferenceResource(row: ResourceRow): InferenceResource {
  return {
    id: row.id,
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    externalId: row.externalId,
    parentResourceId: row.parentResourceId,
    fields: row.fieldsJson,
    outputs: row.outputsJson,
  };
}

/**
 * The resource rows a focused query needs: the focus itself, whatever the
 * output-reference rows named, and the candidates inference could pair it with.
 *
 * Inference matches exact values, so a candidate must contain one of the focus'
 * tokens *somewhere* in its JSON — which `ILIKE` can answer without loading the
 * org. Both directions are covered by one predicate list: the focus' identity
 * tokens find resources pointing *at* it, its field values find the resources
 * it points at. The rows come back with everything that merely mentions a
 * token; `inferDependencyEdges` is what decides which mentions are edges.
 *
 * The one thing this loses versus the org-wide path is ambiguity detection over
 * resources that share a token with each other but not with the focus — they
 * never make it into the candidate set, so a token that is ambiguous org-wide
 * can look unique here. Candidates claiming the same token as the focus *are*
 * fetched, which is the collision that would actually mis-draw this graph.
 */
async function loadFocusedResources(
  organizationId: string,
  focusId: string,
  referencedIds: Set<string>,
): Promise<ResourceRow[]> {
  const [focus] = await db
    .select(resourceColumns)
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        eq(resources.id, focusId),
        isNull(resources.deletedAt),
      ),
    );

  // Longest first: a uuid or an arn narrows the scan, a three-letter name
  // matches half the org. Identity and reference tokens compete on the same
  // footing — both directions of the neighbourhood matter equally.
  const focusResource = focus ? toInferenceResource(focus) : null;
  const tokens = focusResource
    ? [
        ...new Set([
          ...resourceIdentityTokens(focusResource),
          ...resourceReferenceTokens(focusResource),
        ]),
      ]
        .sort((a, b) => b.length - a.length)
        .slice(0, MAX_FOCUS_TOKENS)
    : [];

  const predicates: (SQL | undefined)[] = [];
  const wantedIds = new Set<string>([focusId, ...referencedIds]);
  if (focus?.parentResourceId) wantedIds.add(focus.parentResourceId);
  predicates.push(inArray(resources.id, [...wantedIds]));
  // Children point at the focus through the sync path's own parent link.
  predicates.push(eq(resources.parentResourceId, focusId));
  for (const token of tokens) {
    // Exact external-id equality is the cheap, indexed case and also drags in
    // the rivals that make a token ambiguous.
    predicates.push(sql`lower(${resources.externalId}) = ${token}`);
    for (const pattern of jsonValuePatterns(token)) {
      predicates.push(sql`${resources.fieldsJson}::text ILIKE ${pattern}`);
      predicates.push(sql`${resources.outputsJson}::text ILIKE ${pattern}`);
    }
  }

  return db
    .select(resourceColumns)
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        or(...predicates),
      ),
    );
}

export { app as dependencyGraphRoutes };
