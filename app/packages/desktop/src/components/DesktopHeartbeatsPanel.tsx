import { useMemo, useState } from "react";
import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "@infrawrench/ui";
import { HeartbeatsPanel } from "@infrawrench/ui/heartbeats/HeartbeatsPanel";
import { DeclareIncidentModal, type IncidentSeed } from "@infrawrench/ui/incidents";
import { createDesktopHeartbeatsClient } from "@/lib/heartbeats-client";
import { createDesktopIncidentsClient } from "@/lib/incidents-client";
import { incidentsTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * Heartbeat monitors on desktop. Rendered as a workspace tab. Cloud-only: the
 * ping URL is served by the cloud app and the deadline sweep runs in the
 * cloud poller, so without an org the tab says so rather than fetching.
 */
export function DesktopHeartbeatsPanel() {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopHeartbeatsClient(), []);
  const incidentsClient = useMemo(() => createDesktopIncidentsClient(), []);
  const [seed, setSeed] = useState<IncidentSeed | null>(null);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("Heartbeats require cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Keyed by org so switching org remounts and refetches. */}
      <HeartbeatsPanel key={activeCloudOrgId} client={client} onDeclareIncident={setSeed} />
      {seed && (
        <DeclareIncidentModal
          client={incidentsClient}
          seed={seed}
          onDeclared={(incident) => {
            setSeed(null);
            void navigateToWorkspaceTarget(navigate, incidentsTabTarget(incident.id), {
              label: gt("Incidents"),
            });
          }}
          onClose={() => setSeed(null)}
        />
      )}
    </div>
  );
}
