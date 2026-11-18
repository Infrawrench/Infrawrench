import { useMemo, useState } from "react";
import { HeartbeatsPanel } from "@infrawrench/ui/heartbeats/HeartbeatsPanel";
import { DeclareIncidentModal, type IncidentSeed } from "@infrawrench/ui/incidents";
import { useNavigate } from "@tanstack/react-router";
import { createWebHeartbeatsClient } from "@/lib/heartbeats-client";
import { createWebIncidentsClient } from "@/lib/incidents-client";
import { getWorkspaceNavigateArgs, incidentsTabTarget } from "@/lib/workspace-tabs";

/**
 * Heartbeat monitors. Rendered as a workspace tab by WebWorkspaceTabsViewport.
 * A down heartbeat carries "Declare incident", opened here like the probes
 * panel's, so an incident starts where somebody noticed it.
 */
export function WebHeartbeatsPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const client = useMemo(() => createWebHeartbeatsClient(orgId), [orgId]);
  const incidentsClient = useMemo(() => createWebIncidentsClient(orgId), [orgId]);
  const [seed, setSeed] = useState<IncidentSeed | null>(null);

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Keyed by org so switching org remounts and refetches. */}
      <HeartbeatsPanel key={orgId} client={client} onDeclareIncident={setSeed} />
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
