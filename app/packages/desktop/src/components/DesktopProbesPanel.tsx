import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { StatusPagesPanel, useUIStore } from "@infrawrench/ui";
import { ProbesPanel } from "@infrawrench/ui/probes";
import { DeclareIncidentModal, type IncidentSeed } from "@infrawrench/ui/incidents";
import { createDesktopProbesClient } from "@/lib/probes-client";
import { createDesktopStatusPagesClient } from "@/lib/status-pages-client";
import { createDesktopIncidentsClient } from "@/lib/incidents-client";
import { incidentsTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * Synthetic probes on desktop, and the status pages that publish them — the
 * same screens web renders. Rendered as a workspace tab (the "probes" kind).
 * Cloud-only: checks run in the cloud poller through the egress proxy and the
 * public page is served by the cloud app, so without an org the tab explains
 * rather than fetching.
 *
 * A down probe carries a "Declare incident" button, and the modal opens here
 * rather than on the Incidents tab: an incident starts where somebody noticed
 * it. Declaring lands them on the new incident.
 */
export function DesktopProbesPanel() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopProbesClient(), []);
  const statusPagesClient = useMemo(() => createDesktopStatusPagesClient(), []);
  const incidentsClient = useMemo(() => createDesktopIncidentsClient(), []);
  const [seed, setSeed] = useState<IncidentSeed | null>(null);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Synthetic probes require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ProbesPanel key={activeCloudOrgId} client={client} onDeclareIncident={setSeed} />
      <StatusPagesPanel key={`status-${activeCloudOrgId}`} client={statusPagesClient} />
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
