/**
 * "Which service is this resource part of?": the one question every other
 * feature asks of services.
 *
 * Incidents, alerts and the weekly digest show a resource; with this they can
 * show the service it belongs to as well. Integrations that arrive later
 * (vulnerability findings, deploy metrics, outbound events) should call
 * {@link getServicesForResources} rather than reading the membership tables,
 * because membership is rules plus explicit rows and only the resolver knows
 * how to combine them.
 */
import { isServiceTier, type ServiceRef } from "@infrawrench/client-core";
import { listServiceRecords, resolveServiceMembers } from "./store";

/** Every member resource id → its services, for one org. */
type OrgIndex = Map<string, ServiceRef[]>;

/**
 * Per-isolate cache of the org index, for callers that ask once per alert.
 * A cache, never coordination (the edge stance on in-memory maps): a stale
 * entry only means an alert names a service membership up to `cacheMs` old.
 */
const indexCache = new Map<string, { at: number; index: OrgIndex }>();
const INDEX_CACHE_MAX_ORGS = 200;

async function buildOrgIndex(organizationId: string): Promise<OrgIndex> {
  const index: OrgIndex = new Map();
  const rows = await listServiceRecords(organizationId);
  if (rows.length === 0) return index;
  const membership = await resolveServiceMembers(organizationId, rows);
  for (const row of rows) {
    const ref: ServiceRef = {
      id: row.id,
      name: row.name,
      slug: row.slug,
      tier: isServiceTier(row.tier) ? row.tier : null,
    };
    for (const member of membership.get(row.id)?.members ?? []) {
      const list = index.get(member.resourceId) ?? [];
      list.push(ref);
      index.set(member.resourceId, list);
    }
  }
  return index;
}

/**
 * Services each resource belongs to, keyed by Infrawrench resource id.
 *
 * Only resources with at least one service appear in the map, so a missing
 * key means "in no service". Never throws: it is called on alert and digest
 * paths, where a failed annotation must not cost the alert itself; failure
 * logs and returns an empty map.
 *
 * Cost: one inventory read for the org when any service has rules. An org
 * with no services answers from a single indexed query. `cacheMs` lets a hot
 * caller (the alert router) reuse a recent index instead.
 */
export async function getServicesForResources(
  organizationId: string,
  resourceIds: readonly string[],
  opts: { cacheMs?: number } = {},
): Promise<Map<string, ServiceRef[]>> {
  const out = new Map<string, ServiceRef[]>();
  const wanted = new Set(resourceIds.filter(Boolean));
  if (wanted.size === 0) return out;
  try {
    let index: OrgIndex;
    const cached = indexCache.get(organizationId);
    if (opts.cacheMs && cached && Date.now() - cached.at < opts.cacheMs) {
      index = cached.index;
    } else {
      index = await buildOrgIndex(organizationId);
      if (indexCache.size >= INDEX_CACHE_MAX_ORGS) indexCache.clear();
      indexCache.set(organizationId, { at: Date.now(), index });
    }
    for (const id of wanted) {
      const refs = index.get(id);
      if (refs) out.set(id, refs);
    }
  } catch (err) {
    console.error(`[services] lookup for org ${organizationId} failed:`, err);
  }
  return out;
}

/** Convenience for a single resource; empty when it belongs to no service. */
export async function getServicesForResource(
  organizationId: string,
  resourceId: string,
  opts: { cacheMs?: number } = {},
): Promise<ServiceRef[]> {
  return (await getServicesForResources(organizationId, [resourceId], opts)).get(resourceId) ?? [];
}

/**
 * "Service: Checkout API" for an alert body or a digest line, or "" when the
 * resource is in no service. Mirrors `ownerContextLine` in `ownership/notify`.
 */
export function serviceContextLine(refs: readonly ServiceRef[]): string {
  if (refs.length === 0) return "";
  return `${refs.length === 1 ? "Service" : "Services"}: ${refs.map((r) => r.name).join(", ")}`;
}
