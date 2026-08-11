import { useMemo, useState } from "react";
import { MetricAlertsPanel } from "@infrawrench/ui/metric-alerts";
import { DeclareIncidentModal, type IncidentSeed } from "@infrawrench/ui/incidents";
import { useNavigate } from "@tanstack/react-router";
import { createWebMetricAlertsClient } from "@/lib/metric-alerts-client";
import { createWebIncidentsClient } from "@/lib/incidents-client";
import { getWorkspaceNavigateArgs, incidentsTabTarget } from "@/lib/workspace-tabs";

/**
 * Metric threshold alert rules. The panel lives in `@infrawrench/ui` so
 * desktop renders the identical screen; this component is the web host.
 * Rendered as a workspace tab (the "metric-alerts" kind) by
 * WebWorkspaceTabsViewport.
 *
 * Each firing carries a "Declare incident" button and the modal opens here —
 * see the note on WebProbesPanel: an incident starts where somebody noticed it.
 */
export function WebMetricAlertsPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const client = useMemo(() => createWebMetricAlertsClient(orgId), [orgId]);
  const incidentsClient = useMemo(() => createWebIncidentsClient(orgId), [orgId]);
  const [seed, setSeed] = useState<IncidentSeed | null>(null);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <MetricAlertsPanel key={orgId} client={client} onDeclareIncident={setSeed} />
      {seed && (
        <DeclareIncidentModal
          client={incidentsClient}
          seed={seed}
          onDeclared={(incident) => {
            setSeed(null);
            void navigate(getWorkspaceNavigateArgs(incidentsTabTarget(incident.id)));
          }}
          onClose={() => setSeed(null)}
        />
      )}
    </div>
  );
}
