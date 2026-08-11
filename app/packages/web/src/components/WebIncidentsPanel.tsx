import { useEffect, useMemo, useState } from "react";
import { IncidentsPanel } from "@infrawrench/ui/incidents";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { apiGet } from "@/lib/api";
import { createWebIncidentsClient } from "@/lib/incidents-client";

/**
 * Incident mode — the declared kind, not provider status incidents. The panel
 * lives in `@infrawrench/ui` so desktop renders the identical screen; this
 * component is the web host. Rendered as a workspace tab (the "incidents"
 * kind) by WebWorkspaceTabsViewport.
 *
 * Which incident is open lives in the URL, the CostReportsPanel stance: that
 * is what records it on the tab so a reload comes back to it, and it makes an
 * incident a link somebody can paste into a channel — during an incident that
 * is most of how people navigate.
 */
export function WebIncidentsPanel({
  orgId,
  incidentId,
  onSelectIncident,
}: {
  orgId: string;
  incidentId?: string | undefined;
  onSelectIncident: (incidentId: string | null) => void;
}) {
  // Start read-only and widen once the permission read lands: a failed read
  // leaves the write actions hidden, and the server enforces regardless.
  const [canWrite, setCanWrite] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ permissions: string[] }>(`/api/org/${orgId}/team/me`)
      .then((me) => {
        if (!cancelled) setCanWrite(hasPermission(me.permissions, "incidents:write"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const client = useMemo(() => createWebIncidentsClient(orgId, canWrite), [orgId, canWrite]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <IncidentsPanel
        key={orgId}
        client={client}
        incidentId={incidentId}
        onIncidentChange={onSelectIncident}
      />
    </div>
  );
}
