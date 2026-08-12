import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "@infrawrench/ui";
import { IncidentsPanel } from "@infrawrench/ui/incidents";
import { createDesktopIncidentsClient } from "@/lib/incidents-client";
import { incidentsTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * Incident mode on desktop — the same screen web renders. Rendered as a
 * workspace tab (the "incidents" kind).
 *
 * Cloud-only: an incident is org-scoped and declaring one composes cloud
 * features (change freezes, alert routing, status pages), so without an org the
 * tab explains rather than fetching.
 *
 * Navigating is what records which incident the tab is on — the Settings/Deploy
 * convention, and what makes reactivating the tab land back on the incident
 * somebody was reading rather than on the list.
 */
export function DesktopIncidentsPanel({ incidentId }: { incidentId?: string | undefined }) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopIncidentsClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        Incidents require cloud mode — sign in to sync.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <IncidentsPanel
        key={activeCloudOrgId}
        client={client}
        incidentId={incidentId}
        onIncidentChange={(next) =>
          void navigateToWorkspaceTarget(navigate, incidentsTabTarget(next ?? undefined), {
            label: "Incidents",
          })
        }
      />
    </div>
  );
}
