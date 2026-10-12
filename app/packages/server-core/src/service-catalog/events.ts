/**
 * `service.changed`: the event subscriptions' copy of a service write.
 *
 * Raised by the web routes after the write lands (create, edit, delete, and
 * membership changes as an `updated` with `members` in `changedFields`). No
 * idempotency key: every successful write is its own change, and a retried
 * request that writes again has changed the service again.
 */
import { SERVICE_CHANGED } from "@infrawrench/client-core";
import { orgAppUrl } from "../app-url";
import { publishEvent } from "../events/publish";
import type { ServiceRecord } from "./store";

export function publishServiceChanged(
  organizationId: string,
  service: ServiceRecord,
  action: "created" | "updated" | "deleted",
  changedFields: readonly string[] = [],
): Promise<number> {
  return publishEvent(
    SERVICE_CHANGED,
    organizationId,
    {
      action,
      serviceId: service.id,
      slug: service.slug,
      name: service.name,
      tier: service.tier,
      ownerTeam: service.ownerTeam,
      changedFields: [...changedFields],
    },
    {
      title: `Service ${service.name} ${action}`,
      url: action === "deleted" ? null : orgAppUrl(organizationId, `services/${service.id}`),
    },
  );
}
