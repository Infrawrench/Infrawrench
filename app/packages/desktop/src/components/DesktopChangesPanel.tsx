import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ChangesPanel, useUIStore } from "@infrawrench/ui";
import { createDesktopChangesClient } from "@/lib/changes-client";
import { createDesktopStatusIncidentsClient } from "@/lib/status-incidents-client";
import { getWorkspaceNavigateArgs, resourceTabTarget } from "@/lib/workspace-tabs";
import { invoke } from "@/lib/invoke";

/**
 * The org change timeline on desktop — the same panel web renders, over the
 * `cloud_changes_list` IPC. Rendered as a workspace tab (the "changes" kind).
 *
 * Cloud-only: the feed is recorded by the cloud poller. The guard below keeps
 * a restored tab (or signing out with the tab open) from rendering without an
 * org.
 */
export function DesktopChangesPanel() {
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopChangesClient(), []);
  const statusClient = useMemo(() => createDesktopStatusIncidentsClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="flex-1 overflow-auto p-6">
        <h1 className="text-xl font-semibold mb-1">Changes</h1>
        <p className="text-sm text-on-surface-muted">
          The change timeline is recorded by Infrawrench Cloud&apos;s poller as it syncs your
          accounts. Local-only mode has no poller, so there is no feed — sign in to an organization
          to see one.
        </p>
      </div>
    );
  }

  return (
    <ChangesPanel
      // Keyed by org so switching org refetches rather than showing the
      // previous org's events.
      key={activeCloudOrgId}
      client={client}
      statusClient={statusClient}
      onOpenUrl={(url) => void invoke("open_external_url", { url })}
      onInvestigateMoment={() => void navigate({ to: "/moment" })}
      onOpenResource={(entry) =>
        void navigate(
          getWorkspaceNavigateArgs(
            resourceTabTarget(
              entry.accountId,
              entry.resourceId,
              entry.pluginId,
              entry.resourceTypeId,
            ),
          ),
        )
      }
    />
  );
}
