import { useMemo } from "react";
import {
  ServicesPanel,
  type ServiceResourceRef,
  type ServicesPanelLocation,
} from "@infrawrench/ui/services";
import { usePermissions } from "@/auth/permissions-context";
import { createWebServicesClient } from "@/lib/services-client";

/**
 * Web host for the shared Services screen, rendered as the "services"
 * workspace tab. Which service is open, or whether the scorecards view is
 * showing, lives in the URL (`/org/:orgId/services[/:id | /scorecards]`), the
 * SLOs stance: that records it on the tab and makes a service a link.
 */
export function WebServicesPanel({
  orgId,
  serviceId,
  view,
  onNavigate,
  onOpenResource,
}: {
  orgId: string;
  serviceId?: string | undefined;
  view?: "scorecards" | undefined;
  onNavigate: (location: ServicesPanelLocation) => void;
  onOpenResource: (ref: ServiceResourceRef) => void;
}) {
  const { has } = usePermissions();
  const canWrite = has("resources:write");
  const canReadTeam = has("team:read");
  const canReadCosts = has("costs:read");
  const client = useMemo(
    () => createWebServicesClient(orgId, { canWrite, canReadTeam, canReadCosts }),
    [orgId, canWrite, canReadTeam, canReadCosts],
  );
  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ServicesPanel
        key={orgId}
        client={client}
        serviceId={serviceId}
        view={view}
        onNavigate={onNavigate}
        onOpenResource={onOpenResource}
      />
    </div>
  );
}
