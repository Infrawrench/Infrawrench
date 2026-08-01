import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DesktopExpiryPanel } from "@/components/DesktopExpiryPanel";
import { getWorkspaceNavigateArgs, resourceTabTarget } from "@/lib/workspace-tabs";

export const Route = createFileRoute("/expiring")({
  component: ExpiringPage,
});

/**
 * The cross-provider Expiry radar on desktop — the same screen web renders.
 *
 * A plain route rather than a workspace tab, matching Changes: the feed has no
 * per-instance state worth keeping mounted. Unlike Changes it works in both
 * modes — the deadlines are computed from stored state, and local mode reads
 * the declarations off the locally loaded plugins — so the sidebar tile shows
 * with or without an org, like Graph.
 */
function ExpiringPage() {
  const navigate = useNavigate();

  return (
    <DesktopExpiryPanel
      openResource={(item) =>
        void navigate(
          getWorkspaceNavigateArgs(
            resourceTabTarget(item.accountId, item.resourceId, item.pluginId, item.resourceTypeId),
          ),
        )
      }
    />
  );
}
