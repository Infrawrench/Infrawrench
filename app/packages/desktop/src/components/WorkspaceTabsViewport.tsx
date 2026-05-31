import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  WorkspaceTabsViewport as BaseViewport,
  useUIStore,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "@infrawrench/ui";
import { DashboardPanel } from "@/routes/dashboard.$dashboardId";
import { AccountPanel } from "@/routes/accounts.$accountId";
import { ResourcePanel } from "@/routes/resource.$accountId.$resourceId";
import { syncWorkspaceRouteFromPath } from "@/lib/workspace-tabs";
import { WorkflowsPanel, type WorkflowClient } from "@infrawrench/ui/workflows";
import { createDesktopWorkflowClient } from "@/lib/workflow-client";

// Stable singleton WorkflowClient so the panel's effects don't refire each
// render. The desktop client runs workflows in-renderer (isolate + plugin
// clients) and persists via db_select/db_execute; infra.prompt uses
// window.prompt for now (a richer modal is a follow-up).
let workflowClient: WorkflowClient | null = null;
function getWorkflowClient(): WorkflowClient {
  if (!workflowClient) workflowClient = createDesktopWorkflowClient();
  return workflowClient;
}

// Desktop-side glue between WorkspaceTabsViewport (in @infrawrench/ui) and the
// per-kind panel components. Each open tab is rendered once and kept mounted
// across tab switches — see WorkspaceTabsViewport for the rendering rules.
export function DesktopWorkspaceTabsViewport() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const tabsHydrated = useUIStore((s) => s.tabsHydrated);

  // The URL is a "tab URL" when syncWorkspaceRouteFromPath returns a target.
  // On non-tab routes (index, settings) we hide all tab panels so the route's
  // <Outlet/> renders alone — tabs stay mounted in the DOM.
  const showActive = syncWorkspaceRouteFromPath(pathname, hash) !== null;

  // Direct URL navigation (deep link, browser back/forward) needs to add the
  // matching tab to the workspace if it isn't already open.
  useEffect(() => {
    if (!tabsHydrated) return;
    const target = syncWorkspaceRouteFromPath(pathname, hash);
    if (!target) return;
    const { workspaceTabs: latestTabs } = useUIStore.getState();
    if (latestTabs.some((tab) => targetsMatch(tab.target, target))) return;
    useUIStore.getState().syncWorkspaceRoute(target);
  }, [tabsHydrated, pathname, hash]);

  return <BaseViewport showActive={showActive} renderTabPanel={(tab) => renderPanel(tab)} />;
}

function renderPanel(tab: WorkspaceTab) {
  const t = tab.target;
  switch (t.kind) {
    case "dashboard":
      return <DashboardPanel dashboardId={t.dashboardId} />;
    case "account":
      return <AccountPanel accountId={t.accountId} />;
    case "workflows":
      return <WorkflowsPanel client={getWorkflowClient()} />;
    case "resource":
      return (
        <ResourcePanel
          accountId={t.accountId}
          resourceId={t.resourceId}
          peerPlugin={t.pluginId}
          peerType={t.resourceTypeId}
          peerParent={t.parentResourceId}
          view={t.view ?? "details"}
        />
      );
  }
}

function targetsMatch(a: WorkspaceTabTarget, b: WorkspaceTabTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "workflows" && b.kind === "workflows") return a.workflowId === b.workflowId;
  if (a.kind === "dashboard" && b.kind === "dashboard") return a.dashboardId === b.dashboardId;
  if (a.kind === "account" && b.kind === "account") return a.accountId === b.accountId;
  if (a.kind === "resource" && b.kind === "resource") {
    return (
      a.accountId === b.accountId &&
      a.resourceId === b.resourceId &&
      (a.view ?? "details") === (b.view ?? "details")
    );
  }
  return false;
}
