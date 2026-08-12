import { useMemo, useState } from "react";
import { ProbesPanel } from "@infrawrench/ui/probes";
import { DeclareIncidentModal, type IncidentSeed } from "@infrawrench/ui/incidents";
import { useNavigate } from "@tanstack/react-router";
import { createWebProbesClient } from "@/lib/probes-client";
import { createWebIncidentsClient } from "@/lib/incidents-client";
import { getWorkspaceNavigateArgs, incidentsTabTarget } from "@/lib/workspace-tabs";

/**
 * Synthetic probes. Rendered as a workspace tab by WebWorkspaceTabsViewport.
 *
 * A down probe carries a "Declare incident" button, and the modal opens here
 * rather than on the Incidents tab: an incident starts where somebody noticed
 * it, and making them navigate away and retype what is on screen is how
 * incidents end up declared in Slack instead. Declaring lands them on the new
 * incident.
 */
export function WebProbesPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const client = useMemo(() => createWebProbesClient(orgId), [orgId]);
  const incidentsClient = useMemo(() => createWebIncidentsClient(orgId), [orgId]);
  const [seed, setSeed] = useState<IncidentSeed | null>(null);

  return (
    <div className="p-6 max-w-4xl mx-auto flex flex-col gap-8">
      {/* Keyed by org so switching org remounts and refetches. */}
      <ProbesPanel key={orgId} client={client} onDeclareIncident={setSeed} />
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
