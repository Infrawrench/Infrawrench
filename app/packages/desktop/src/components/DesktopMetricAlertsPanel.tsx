import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "@infrawrench/ui";
import { MetricAlertsPanel } from "@infrawrench/ui/metric-alerts";
import { DeclareIncidentModal, type IncidentSeed } from "@infrawrench/ui/incidents";
import { createDesktopMetricAlertsClient } from "@/lib/metric-alerts-client";
import { createDesktopIncidentsClient } from "@/lib/incidents-client";
import { incidentsTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * Metric threshold alert rules on desktop — the same screen web renders.
 * Rendered as a workspace tab (the "metric-alerts" kind). Cloud-only: rules
 * are evaluated by the cloud poller, so without an org the tab explains
 * rather than fetching.
 *
 * Each firing carries a "Declare incident" button; the modal opens here rather
 * than on the Incidents tab, because an incident starts where somebody noticed
 * it. Declaring lands them on the new incident.
 */
export function DesktopMetricAlertsPanel() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopMetricAlertsClient(), []);
  const incidentsClient = useMemo(() => createDesktopIncidentsClient(), []);
  const [seed, setSeed] = useState<IncidentSeed | null>(null);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Metric alerts require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <MetricAlertsPanel key={activeCloudOrgId} client={client} onDeclareIncident={setSeed} />
      {seed && (
        <DeclareIncidentModal
          client={incidentsClient}
          seed={seed}
          onDeclared={(incident) => {
            setSeed(null);
            void navigateToWorkspaceTarget(navigate, incidentsTabTarget(incident.id), {
              label: "Incidents",
            });
          }}
          onClose={() => setSeed(null)}
        />
      )}
    </div>
  );
}
