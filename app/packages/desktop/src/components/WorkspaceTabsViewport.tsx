import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRouterState } from "@tanstack/react-router";
import {
  WorkspaceTabsViewport as BaseViewport,
  dashboardTabTarget,
  resourceTabTarget,
  DeploymentsPanel,
  useUIStore,
  workspaceTabTargetsEqual,
  type DeploymentClient,
  type WorkspaceTab,
} from "@infrawrench/ui";
import { DashboardPanel } from "@/routes/dashboard.$dashboardId";
import { AccountPanel } from "@/routes/accounts.$accountId";
import { ResourcePanel } from "@/routes/resource.$accountId.$resourceId";
import { getWorkspaceNavigateArgs, syncWorkspaceRouteFromPath } from "@/lib/workspace-tabs";
import { AgentsPanel, type AgentClient } from "@infrawrench/ui/agents";
import { CostsPanel, type CostsClient } from "@infrawrench/ui/cost";
import { type OrphansClient, type RightsizingClient, type SchedulesClient } from "@infrawrench/ui";
import { createDesktopCostsClient } from "@/lib/costs-client";
import { createDesktopSchedulesClient } from "@/lib/schedules-client";
import { createDesktopOrphansClient } from "@/lib/orphans-client";
import { createDesktopRightsizingClient } from "@/lib/rightsizing-client";
import { createDesktopAgentClient } from "@/lib/agent-client";
import { createDesktopDeploymentClient } from "@/lib/cloud-deployments";
import { createDesktopLogWorkspaceClient } from "@/lib/log-workspace-client";
import { LogWorkspacePanel, type LogWorkspaceClient } from "@infrawrench/ui";
import { CloudChatPanel } from "@/components/CloudChatPanel";
import { DesktopWorkflowsPanel } from "@/components/DesktopWorkflowsPanel";
import { DesktopGraphPanel } from "@/components/DesktopGraphPanel";
import { LocalDeploymentsPanel } from "@/components/LocalDeploymentsPanel";
import { DesktopChangesPanel } from "@/components/DesktopChangesPanel";
import { DesktopExpiryPanel } from "@/components/DesktopExpiryPanel";
import { DesktopPosturePanel } from "@/components/DesktopPosturePanel";
import { DesktopMetricAlertsPanel } from "@/components/DesktopMetricAlertsPanel";
import { DesktopProbesPanel } from "@/components/DesktopProbesPanel";
import { DesktopSshFanoutPanel } from "@/components/DesktopSshFanoutPanel";

let agentClient: AgentClient | null = null;
function getAgentClient(): AgentClient {
  if (!agentClient) agentClient = createDesktopAgentClient();
  return agentClient;
}

// One client for every org: it resolves the active org per call, so switching
// org under a mounted Deploy tab reaches the new org's repos and history.
let deploymentClient: DeploymentClient | null = null;
function getDeploymentClient(): DeploymentClient {
  if (!deploymentClient) deploymentClient = createDesktopDeploymentClient();
  return deploymentClient;
}

let costsClient: CostsClient | null = null;
function getCostsClient(): CostsClient {
  if (!costsClient) costsClient = createDesktopCostsClient();
  return costsClient;
}

let orphansClient: OrphansClient | null = null;
function getOrphansClient(): OrphansClient {
  if (!orphansClient) orphansClient = createDesktopOrphansClient();
  return orphansClient;
}

let schedulesClient: SchedulesClient | null = null;
function getSchedulesClient(): SchedulesClient {
  if (!schedulesClient) schedulesClient = createDesktopSchedulesClient();
  return schedulesClient;
}

let rightsizingClient: RightsizingClient | null = null;
function getRightsizingClient(): RightsizingClient {
  if (!rightsizingClient) rightsizingClient = createDesktopRightsizingClient();
  return rightsizingClient;
}

// Keyed by mode (org id or "local") — cloud and local clients differ in both
// transports and saved-query availability, and the panel remounts on switch.
const logWorkspaceClients = new Map<string, LogWorkspaceClient>();
function getLogWorkspaceClient(activeCloudOrgId: string | null): LogWorkspaceClient {
  const key = activeCloudOrgId ?? "local";
  let client = logWorkspaceClients.get(key);
  if (!client) {
    client = createDesktopLogWorkspaceClient(activeCloudOrgId);
    logWorkspaceClients.set(key, client);
  }
  return client;
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
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

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
    <BaseViewport
      showActive={showActive}
      renderTabPanel={(tab) => renderPanel(tab, navigate, activeCloudOrgId)}
    />
  );
}

function renderPanel(
  tab: WorkspaceTab,
  navigate: ReturnType<typeof useNavigate>,
  activeCloudOrgId: string | null,
) {
  const t = tab.target;
  switch (t.kind) {
    case "deployments":
      // Deploying from the app needs an org: a GitHub App install to read the
      // Infrafile at a branch head, and a build host to build on. Without one
      // the desktop binary is also the CLI, which runs the same three stages
      // locally — so local mode shows what those runs did.
      return activeCloudOrgId ? (
        <DeploymentsPanel
          // Keyed by org so switching org refetches repos, history and
          // triggers rather than showing the previous org's.
          key={activeCloudOrgId}
          client={getDeploymentClient()}
          {...(t.repo ? { initialRepo: t.repo } : {})}
        />
      ) : (
        <LocalDeploymentsPanel />
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
          // Keyed by org so switching org refetches rather than showing the
          // previous org's budgets and flagged resources.
          key={activeCloudOrgId ?? "local"}
          client={getCostsClient()}
          onOpenDashboard={(dashboardId) =>
            void navigate(getWorkspaceNavigateArgs(dashboardTabTarget(dashboardId)))
          }
          // Available in both modes: the orphan rules are declarative and the
          // scan runs over stored state, so local mode classifies this
          // machine's workspace (without cost annotation) rather than
          // dropping the section. The client picks the store — see
          // lib/orphans-client.ts.
          orphans={getOrphansClient()}
          // Cloud-only: the percentiles live in the cloud metrics warehouse
          // and the size catalogs need the org's credentials, so local mode
          // omits the section entirely (the schedules rule).
          rightsizing={activeCloudOrgId ? getRightsizingClient() : undefined}
          onOpenOversizedResource={(r, accountId) => {
            if (!r.id) return;
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(accountId, r.id, r.pluginId, r.resourceTypeId),
              ),
            );
          }}
          // Cloud-only: the rows live server-side and the cloud poller runs
          // the transitions, so local mode omits the section entirely.
          schedules={activeCloudOrgId ? getSchedulesClient() : undefined}
          onOpenScheduledResource={(s) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(s.accountId, s.resourceId, s.pluginId, s.resourceTypeId),
              ),
            )
          }
          onOpenResource={(r, accountId) => {
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(accountId, r.id, r.pluginId, r.resourceTypeId),
              ),
            );
          }}
        />
      );
    case "graph":
      return (
        <DesktopGraphPanel
          openResource={(node) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(node.accountId, node.id, node.pluginId, node.resourceTypeId),
              ),
            )
          }
        />
      );
    case "logs":
      return (
        <LogWorkspacePanel
          // Keyed by mode so switching org (or dropping to local) remounts
          // and re-discovers streams rather than tailing the previous set.
          key={activeCloudOrgId ?? "local"}
          client={getLogWorkspaceClient(activeCloudOrgId)}
          onOpenResource={(selector) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  selector.accountId,
                  selector.resourceId,
                  selector.pluginId,
                  selector.resourceTypeId,
                ),
              ),
            )
          }
        />
      );
    case "changes":
      return <DesktopChangesPanel />;
    case "expiring":
      return (
        <DesktopExpiryPanel
          // Keyed by mode so switching org (or dropping to local) remounts
          // and refetches rather than showing the previous mode's deadlines.
          key={activeCloudOrgId ?? "local"}
          openResource={(item) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  item.accountId,
                  item.resourceId,
                  item.pluginId,
                  item.resourceTypeId,
                ),
              ),
            )
          }
        />
      );
    case "posture":
      return (
        <DesktopPosturePanel
          // Keyed by mode so switching org (or dropping to local) remounts
          // and refetches rather than showing the previous mode's findings.
          key={activeCloudOrgId ?? "local"}
          openResource={(finding) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  finding.accountId,
                  finding.resourceId,
                  finding.pluginId,
                  finding.resourceTypeId,
                ),
              ),
            )
          }
        />
      );
    case "ssh-fanout":
      return <DesktopSshFanoutPanel />;
    case "metric-alerts":
      return <DesktopMetricAlertsPanel />;
    case "probes":
      return <DesktopProbesPanel />;
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
