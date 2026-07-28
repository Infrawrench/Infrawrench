import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRouterState } from "@tanstack/react-router";
import {
  WorkspaceTabsViewport as BaseViewport,
  dashboardTabTarget,
  useUIStore,
  workspaceTabTargetsEqual,
  type WorkspaceTab,
} from "@infrawrench/ui";
import { DashboardPanel } from "@/routes/dashboard.$dashboardId";
import { AccountPanel } from "@/routes/accounts.$accountId";
import { ResourcePanel } from "@/routes/resource.$accountId.$resourceId";
import { getWorkspaceNavigateArgs, syncWorkspaceRouteFromPath } from "@/lib/workspace-tabs";
import { AgentsPanel, type AgentClient } from "@infrawrench/ui/agents";
import { CostsPanel, type CostsClient } from "@infrawrench/ui/cost";
import { createDesktopCostsClient } from "@/lib/costs-client";
import { createDesktopAgentClient } from "@/lib/agent-client";
import { CloudChatPanel } from "@/components/CloudChatPanel";
import { DesktopWorkflowsPanel } from "@/components/DesktopWorkflowsPanel";

let agentClient: AgentClient | null = null;
function getAgentClient(): AgentClient {
  if (!agentClient) agentClient = createDesktopAgentClient();
  return agentClient;
}

let costsClient: CostsClient | null = null;
function getCostsClient(): CostsClient {
  if (!costsClient) costsClient = createDesktopCostsClient();
  return costsClient;
}

// Desktop-side glue between WorkspaceTabsViewport (in @infrawrench/ui) and the
// per-kind panel components. Each open tab is rendered once and kept mounted
// across tab switches — see WorkspaceTabsViewport for the rendering rules.
export function DesktopWorkspaceTabsViewport() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  // Under hash history the query string lives inside the hash fragment, so
  // window.location.search is always empty — read it from router state.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const tabsHydrated = useUIStore((s) => s.tabsHydrated);

  // The URL is a "tab URL" when syncWorkspaceRouteFromPath returns a target.
  // On non-tab routes (index, settings) we hide all tab panels so the route's
  // <Outlet/> renders alone — tabs stay mounted in the DOM.
  const showActive = syncWorkspaceRouteFromPath(pathname, hash, searchStr) !== null;

  // Direct URL navigation (deep link, browser back/forward) needs to add the
  // matching tab to the workspace if it isn't already open.
  useEffect(() => {
    if (!tabsHydrated) return;
    const target = syncWorkspaceRouteFromPath(pathname, hash, searchStr);
    if (!target) return;
    const { workspaceTabs: latestTabs } = useUIStore.getState();
    if (latestTabs.some((tab) => workspaceTabTargetsEqual(tab.target, target))) return;
    useUIStore.getState().syncWorkspaceRoute(target);
  }, [tabsHydrated, pathname, hash, searchStr]);

  return (
    <BaseViewport showActive={showActive} renderTabPanel={(tab) => renderPanel(tab, navigate)} />
  );
}

function renderPanel(tab: WorkspaceTab, navigate: ReturnType<typeof useNavigate>) {
  const t = tab.target;
  switch (t.kind) {
    case "deployments":
      // Deploying needs a cloud org (a GitHub App install to read the Infrafile,
      // a build host to build on). The desktop binary is also the CLI, which
      // does the same three stages locally, so it is the answer here.
      return (
        <div className="p-6 text-sm text-on-surface-secondary">
          <p className="mb-2">Deploys run from the web app or the terminal.</p>
          <p className="text-xs text-on-surface-faint">
            In this project&apos;s directory, run <code>infrawrench deploy</code>. It reads the
            Infrafile at your repo root and builds with your local Docker daemon.
          </p>
        </div>
      );
    case "dashboard":
      return <DashboardPanel dashboardId={t.dashboardId} />;
    case "account":
      return <AccountPanel accountId={t.accountId} />;
    case "agents":
      return (
        <AgentsPanel
          client={getAgentClient()}
          openWorkspaceTarget={(target) => void navigate(getWorkspaceNavigateArgs(target))}
        />
      );
    case "workflows":
      return <DesktopWorkflowsPanel />;
    case "costs":
      return (
        <CostsPanel
          client={getCostsClient()}
          onOpenDashboard={(dashboardId) =>
            void navigate(getWorkspaceNavigateArgs(dashboardTabTarget(dashboardId)))
          }
        />
      );
    case "chat":
      return <CloudChatPanel conversationId={t.conversationId} />;
    case "resource":
      return (
        <ResourcePanel
          accountId={t.accountId}
          resourceId={t.resourceId}
          peerPlugin={t.pluginId}
          peerType={t.resourceTypeId}
          peerParent={t.parentResourceId}
          view={t.view ?? "details"}
          agentSessionId={t.agentSessionId}
          sshKeyId={t.sshKeyId}
          sshKeyName={t.sshKeyName}
          initialCommand={t.initialCommand}
          initialCwd={t.initialCwd}
        />
      );
  }
}
