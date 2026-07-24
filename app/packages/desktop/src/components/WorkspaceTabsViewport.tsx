import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
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
import { getWorkspaceNavigateArgs, syncWorkspaceRouteFromPath } from "@/lib/workspace-tabs";
import { WorkflowsPanel, type WorkflowClient } from "@infrawrench/ui/workflows";
import { AgentsPanel, type AgentClient } from "@infrawrench/ui/agents";
import { createDesktopWorkflowClient } from "@/lib/workflow-client";
import { createDesktopAgentClient } from "@/lib/agent-client";
import { CloudChatPanel } from "@/components/CloudChatPanel";

// Stable singleton WorkflowClient so the panel's effects don't refire each
// render. The desktop client runs workflows in-renderer (isolate + plugin
// clients) and persists via db_select/db_execute; infra.prompt uses
// window.prompt for now (a richer modal is a follow-up).
let workflowClient: WorkflowClient | null = null;
function getWorkflowClient(): WorkflowClient {
  if (!workflowClient) workflowClient = createDesktopWorkflowClient();
  return workflowClient;
}

let agentClient: AgentClient | null = null;
function getAgentClient(): AgentClient {
  if (!agentClient) agentClient = createDesktopAgentClient();
  return agentClient;
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
    if (latestTabs.some((tab) => targetsMatch(tab.target, target))) return;
    useUIStore.getState().syncWorkspaceRoute(target);
  }, [tabsHydrated, pathname, hash, searchStr]);

  return (
    <BaseViewport showActive={showActive} renderTabPanel={(tab) => renderPanel(tab, navigate)} />
  );
}

function renderPanel(tab: WorkspaceTab, navigate: ReturnType<typeof useNavigate>) {
  const t = tab.target;
  switch (t.kind) {
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
      return <WorkflowsPanel client={getWorkflowClient()} />;
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

function targetsMatch(a: WorkspaceTabTarget, b: WorkspaceTabTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "workflows" && b.kind === "workflows") return a.workflowId === b.workflowId;
  if (a.kind === "agents" && b.kind === "agents") return true;
  if (a.kind === "chat" && b.kind === "chat") return a.conversationId === b.conversationId;
  if (a.kind === "dashboard" && b.kind === "dashboard") return a.dashboardId === b.dashboardId;
  if (a.kind === "account" && b.kind === "account") return a.accountId === b.accountId;
  if (a.kind === "resource" && b.kind === "resource") {
    return (
      a.accountId === b.accountId &&
      a.resourceId === b.resourceId &&
      (a.view ?? "details") === (b.view ?? "details") &&
      a.agentSessionId === b.agentSessionId &&
      a.sshKeyId === b.sshKeyId &&
      a.sshKeyName === b.sshKeyName
    );
  }
  return false;
}
