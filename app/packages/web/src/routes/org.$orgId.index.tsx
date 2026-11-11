import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUIStore } from "@infrawrench/ui";
import { getWorkspaceNavigateArgs, homeTabTarget } from "@/lib/workspace-tabs";

// The organization's bare address has no page of its own. Opening it goes
// back to where you were, the tab that was active when the app was last
// open, and to Home, the grid of apps, when there is none. Any deeper
// address is an explicit destination and is never redirected from here.
export const Route = createFileRoute("/org/$orgId/")({
  component: OrgIndex,
});

function OrgIndex() {
  const gt = useGT();
  const navigate = useNavigate();
  const tabsHydrated = useUIStore((s) => s.tabsHydrated);

  useEffect(() => {
    if (!tabsHydrated) return;
    // Read once, at arrival: this is a decision about where to land, not a
    // subscription to the tab strip.
    const { workspaceTabs, activeWorkspaceTabId } = useUIStore.getState();
    const last = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspaceTabs[0];
    void navigate({ ...getWorkspaceNavigateArgs(last?.target ?? homeTabTarget()), replace: true });
  }, [navigate, tabsHydrated]);

  return <div className="p-6 text-on-surface-muted text-sm animate-pulse">{gt("Loading…")}</div>;
}
