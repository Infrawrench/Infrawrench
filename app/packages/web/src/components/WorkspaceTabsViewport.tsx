import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRouterState } from "@tanstack/react-router";
import {
  WorkspaceTabsViewport as BaseViewport,
  useUIStore,
  workspaceTabTargetsEqual,
  type WorkspaceTab,
} from "@infrawrench/ui";
import { DashboardPanel } from "@/routes/org.$orgId.dashboard.$dashboardId";
import { AccountPanel } from "@/routes/org.$orgId.accounts.$accountId";
import { ResourcePanel } from "@/routes/org.$orgId.resources.$pluginId.$resourceTypeId.$resourceId";
import { getWorkspaceNavigateArgs, syncWorkspaceRouteFromPath } from "@/lib/workspace-tabs";
import { type WorkflowClient } from "@infrawrench/ui/workflows";
import { DeploymentsPanel, type DeploymentClient } from "@infrawrench/ui";
import { createWebDeploymentClient } from "@/lib/deployment-client";
import { type AgentClient } from "@infrawrench/ui/agents";
import { createWebWorkflowClient } from "@/lib/workflow-client";
import { createWebCostsClient } from "@/lib/cost-client";
import { createWebAgentClient } from "@/lib/agent-client";
import { WebWorkflowsPanel } from "./WebWorkflowsPanel";
import { WebAgentsPanel } from "./WebAgentsPanel";
import { WebChatPanel } from "./WebChatPanel";
import { CostsPanel, type CostsClient } from "@infrawrench/ui/cost";

interface WebWorkspaceTabsViewportProps {
  orgId: string;
}

// Web-side glue between WorkspaceTabsViewport (in @infrawrench/ui) and the
// per-kind panel components. Each open tab is rendered once and kept mounted
// across tab switches — see WorkspaceTabsViewport for the rendering rules.
export function WebWorkspaceTabsViewport({ orgId }: WebWorkspaceTabsViewportProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const tabsHydrated = useUIStore((s) => s.tabsHydrated);

  // The URL is a "tab URL" when syncWorkspaceRouteFromPath returns a target.
  // On non-tab routes (settings, onboarding) we hide all tab panels so the
  // route's <Outlet/> renders alone — tabs stay mounted in the DOM.
  const routeTarget = syncWorkspaceRouteFromPath(pathname, hash);
  const showActive = routeTarget !== null;

  // Direct URL navigation (deep link, browser back/forward) needs to add the
  // matching tab to the workspace if it isn't already open. The viewport
  // itself only renders tabs from the store, so this hook keeps the store
  // in sync with the URL. Compute the target inside the effect so the dep
  // array stays primitive (otherwise the fresh object refires every render).
  useEffect(() => {
    if (!tabsHydrated) return;
    const target = syncWorkspaceRouteFromPath(pathname, hash);
    if (!target) return;
    const { workspaceTabs: latestTabs } = useUIStore.getState();
    if (latestTabs.some((tab) => workspaceTabTargetsEqual(tab.target, target))) return;
    useUIStore.getState().syncWorkspaceRoute(target);
  }, [tabsHydrated, pathname, hash]);

  return (
    <BaseViewport
      showActive={showActive}
      renderTabPanel={(tab) => renderPanel(tab, orgId, navigate)}
    />
  );
}

// Stable WorkflowClient per org so the panel's effects don't refire each render.
const workflowClients = new Map<string, WorkflowClient>();
const agentClients = new Map<string, AgentClient>();
const costsClients = new Map<string, CostsClient>();
const deploymentClients = new Map<string, DeploymentClient>();
function getDeploymentClient(orgId: string): DeploymentClient {
  let client = deploymentClients.get(orgId);
  if (!client) {
    client = createWebDeploymentClient(orgId);
    deploymentClients.set(orgId, client);
  }
  return client;
}
function getWorkflowClient(orgId: string): WorkflowClient {
  let client = workflowClients.get(orgId);
  if (!client) {
    client = createWebWorkflowClient(orgId);
    workflowClients.set(orgId, client);
  }
  return client;
}

function getAgentClient(orgId: string): AgentClient {
  let client = agentClients.get(orgId);
  if (!client) {
    client = createWebAgentClient(orgId);
    agentClients.set(orgId, client);
  }
  return client;
}

function getCostsClient(orgId: string): CostsClient {
  let client = costsClients.get(orgId);
  if (!client) {
    client = createWebCostsClient(orgId);
    costsClients.set(orgId, client);
  }
  return client;
}

function renderPanel(tab: WorkspaceTab, orgId: string, navigate: ReturnType<typeof useNavigate>) {
  const t = tab.target;
  switch (t.kind) {
    case "dashboard":
      return <DashboardPanel orgId={orgId} dashboardId={t.dashboardId} />;
    case "account":
      return <AccountPanel orgId={orgId} accountId={t.accountId} />;
    case "agents":
      return (
        <WebAgentsPanel
          client={getAgentClient(orgId)}
          orgId={orgId}
          openWorkspaceTarget={(target) => void navigate(getWorkspaceNavigateArgs(target))}
        />
      );
    case "workflows":
      return <WebWorkflowsPanel client={getWorkflowClient(orgId)} orgId={orgId} />;
    case "deployments":
      return (
        <DeploymentsPanel
          client={getDeploymentClient(orgId)}
          {...(t.repo ? { initialRepo: t.repo } : {})}
        />
      );
    case "costs":
      return (
        <CostsPanel
          client={getCostsClient(orgId)}
          onOpenDashboard={(dashboardId) =>
            void navigate(getWorkspaceNavigateArgs({ kind: "dashboard", dashboardId }))
          }
        />
      );
    case "chat":
      return <WebChatPanel orgId={orgId} conversationId={t.conversationId} />;
    case "resource":
      if (!t.pluginId || !t.resourceTypeId) {
        // Without pluginId/resourceTypeId we can't construct the detail URL.
        // Fall through to the account panel for the resource's account so
        // the user lands somewhere sensible.
        return <AccountPanel orgId={orgId} accountId={t.accountId} />;
      }
      return (
        <ResourcePanel
          orgId={orgId}
          pluginId={t.pluginId}
          resourceTypeId={t.resourceTypeId}
          resourceId={t.resourceId}
          accountId={t.accountId}
          parent={t.parentResourceId}
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
