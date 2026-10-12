import { useMemo } from "react";
import { DeliveryPanel } from "@infrawrench/ui/dora";
import { usePermissions } from "@/auth/permissions-context";
import { createWebDoraClient } from "@/lib/dora-client";

/**
 * Web host for the shared Delivery (DORA metrics) screen, rendered as the
 * "delivery" workspace tab.
 */
export function WebDeliveryPanel({ orgId }: { orgId: string }) {
  const { has } = usePermissions();
  const canEditSettings = has("org:settings:write");
  const client = useMemo(
    () => createWebDoraClient(orgId, canEditSettings),
    [orgId, canEditSettings],
  );
  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <DeliveryPanel key={orgId} client={client} />
    </div>
  );
}
