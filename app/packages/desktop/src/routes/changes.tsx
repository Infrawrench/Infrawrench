import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { ChangesPanel, useUIStore } from "@infrawrench/ui";
import { createDesktopChangesClient } from "@/lib/changes-client";
import { getWorkspaceNavigateArgs, resourceTabTarget } from "@/lib/workspace-tabs";

export const Route = createFileRoute("/changes")({
  component: ChangesPage,
});

/**
 * The org change timeline on desktop — the same panel web renders, over the
 * `cloud_changes_list` IPC.
 *
 * A plain route rather than a workspace tab, matching web: the feed has no
 * per-instance state worth keeping mounted (no PTY, no scrollback), and the
 * sidebar tile only appears in cloud mode, so a restored tab could outlive the
 * org it belonged to. The guard below is the second half of that — signing out
 * with the page open lands here without an org.
 */
function ChangesPage() {
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopChangesClient(), []);

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
