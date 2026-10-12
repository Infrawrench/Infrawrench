/**
 * The `service` DORA scope dimension: each change grouped by the service that
 * owns the resource it touched.
 *
 * Lives here rather than in `dora/` because membership is this feature's
 * business ({@link getServicesForResources} is the only reader that combines
 * rules and explicit rows). `dora/dimensions.ts` lists it with the built-ins;
 * this module imports nothing but types from there, so the two never form an
 * ESM cycle.
 *
 * A deploy is placed by its target (the project or service it shipped), then
 * by its own resource row; a resource change by the changed resource.
 * Infrafile runs and API-recorded deploys that name no resource are "not
 * known". A change can only take one value, so a resource in several services
 * goes to {@link primaryService}: the most critical tier first, untiered last,
 * then name, then id, so the same change lands in the same row on every report
 * and a change to shared infrastructure counts against the most critical
 * service it serves.
 */
import type { DoraScopeValue, ServiceRef } from "@infrawrench/client-core";
import type { DoraScopeDimension } from "../dora/dimensions";
import { getServicesForResources } from "./lookup";

export const SERVICE_DORA_DIMENSION_ID = "service";

/** The service a multi-service resource's changes are grouped under. */
export function primaryService(refs: readonly ServiceRef[]): ServiceRef | null {
  let best: ServiceRef | null = null;
  for (const ref of refs) {
    if (!best || compareServices(ref, best) < 0) best = ref;
  }
  return best;
}

function compareServices(a: ServiceRef, b: ServiceRef): number {
  const ta = a.tier ?? Number.POSITIVE_INFINITY;
  const tb = b.tier ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export const serviceDoraDimension: DoraScopeDimension = {
  id: SERVICE_DORA_DIMENSION_ID,
  label: "Service",
  async resolve(organizationId, subjects) {
    const ids = subjects.flatMap((s) =>
      [s.targetResourceId, s.resourceId].filter((x): x is string => !!x),
    );
    const services = await getServicesForResources(organizationId, ids);
    const out = new Map<string, DoraScopeValue | null>();
    for (const s of subjects) {
      const refs =
        (s.targetResourceId ? services.get(s.targetResourceId) : undefined) ??
        (s.resourceId ? services.get(s.resourceId) : undefined) ??
        [];
      const ref = primaryService(refs);
      out.set(s.id, ref ? { key: ref.id, label: ref.name } : null);
    }
    return out;
  },
};
