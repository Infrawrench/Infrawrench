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

/**
 * Services each resource belongs to, keyed by Infrawrench resource id.
 *
 * Only resources with at least one service appear in the map, so a missing
 * key means "in no service". Never throws: it is called on alert and digest
 * paths, where a failed annotation must not cost the alert itself; failure
 * logs and returns an empty map.
 *
 * Cost: one inventory read for the org when any service has rules. An org
 * with no services answers from a single indexed query.
 */
export async function getServicesForResources(
  organizationId: string,
  resourceIds: readonly string[],
): Promise<Map<string, ServiceRef[]>> {
  const out = new Map<string, ServiceRef[]>();
  const wanted = new Set(resourceIds.filter(Boolean));
  if (wanted.size === 0) return out;
  try {
    const rows = await listServiceRecords(organizationId);
    if (rows.length === 0) return out;
    const membership = await resolveServiceMembers(organizationId, rows);
    for (const row of rows) {
      const ref: ServiceRef = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        tier: isServiceTier(row.tier) ? row.tier : null,
      };
      for (const member of membership.get(row.id)?.members ?? []) {
        if (!wanted.has(member.resourceId)) continue;
        const list = out.get(member.resourceId) ?? [];
        list.push(ref);
        out.set(member.resourceId, list);
      }
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
): Promise<ServiceRef[]> {
  return (await getServicesForResources(organizationId, [resourceId])).get(resourceId) ?? [];
}

/**
 * "Service: Checkout API" for an alert body or a digest line, or "" when the
 * resource is in no service. Mirrors `ownerContextLine` in `ownership/notify`.
 */
export function serviceContextLine(refs: readonly ServiceRef[]): string {
  if (refs.length === 0) return "";
  return `${refs.length === 1 ? "Service" : "Services"}: ${refs.map((r) => r.name).join(", ")}`;
}
