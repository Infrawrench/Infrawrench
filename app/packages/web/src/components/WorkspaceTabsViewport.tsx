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
import {
  getWorkspaceNavigateArgs,
  isRouteHostedTabPanel,
  navigateToWorkspaceTarget,
  syncWorkspaceRouteFromPath,
} from "@/lib/workspace-tabs";
import { type WorkflowClient } from "@infrawrench/ui/workflows";
import { type DeploymentClient } from "@infrawrench/ui";
import { createWebDeploymentClient } from "@/lib/deployment-client";
import { WebDeploymentsPanel } from "./WebDeploymentsPanel";
import { type AgentClient } from "@infrawrench/ui/agents";
import { createWebWorkflowClient } from "@/lib/workflow-client";
import { createWebCostReportsClient, createWebCostsClient } from "@/lib/cost-client";
import { createWebInvoicesClient } from "@/lib/invoices-client";
import { InvoicesPanel, type InvoicesClient } from "@infrawrench/ui/invoices";
import { createWebAgentClient } from "@/lib/agent-client";
import { WebWorkflowsPanel } from "./WebWorkflowsPanel";
import { WebAgentsPanel } from "./WebAgentsPanel";
import { WebAppWindowPanel } from "./WebAppsPanels";
import { WebChatPanel } from "./WebChatPanel";
import { WebGraphPanel } from "./WebGraphPanel";
import { CostsPanel, type CostsClient } from "@infrawrench/ui/cost";
import { CostReportsPanel, type CostReportsClient } from "@infrawrench/ui/cost-reports";
import {
  costReportsTabTarget,
  incidentsTabTarget,
  invoicesTabTarget,
  workflowsTabTarget,
} from "@/lib/workspace-tabs";
import {
  environmentDiffTabTarget,
  resourceTabTarget,
  type OrphansClient,
  type RightsizingClient,
  type SchedulesClient,
} from "@infrawrench/ui";
import { createWebOrphansClient } from "@/lib/orphans-client";
import { createWebRightsizingClient } from "@/lib/rightsizing-client";
import { createWebSchedulesClient } from "@/lib/schedules-client";
import { createWebLogWorkspaceClient } from "@/lib/log-workspace-client";
import { LogWorkspacePanel, type LogWorkspaceClient } from "@infrawrench/ui";
import { WebChangesPanel } from "./WebChangesPanel";
import { WebExpiryPanel } from "./WebExpiryPanel";
import { WebPosturePanel } from "./WebPosturePanel";
import { WebAccessReviewPanel } from "./WebAccessReviewPanel";
import { WebBackupsPanel } from "./WebBackupsPanel";
import { WebWallboardPanel } from "./WebWallboardPanel";
import { WebDnsPanel } from "./WebDnsPanel";
import { WebIacPanel } from "./WebIacPanel";
import { WebEnvironmentDiffPanel } from "./WebEnvironmentDiffPanel";
import { WebMetricAlertsPanel } from "./WebMetricAlertsPanel";
import { WebProbesPanel } from "./WebProbesPanel";
import { WebStatusPagesPanel } from "./WebStatusPagesPanel";
import { WebQuotasPanel } from "./WebQuotasPanel";
import { WebIncidentsPanel } from "./WebIncidentsPanel";
import { WebEnvironmentsPanel } from "./WebEnvironmentsPanel";
import { WebSshFanoutPanel } from "./WebSshFanoutPanel";

interface WebWorkspaceTabsViewportProps {
  orgId: string;
  /**
   * False until the restored tabs have been validated against this org
   * (see the validate-tabs effect in __root.tsx). While false, only the tab
   * matching the current URL mounts — tabs persisted from another org must
   * not mount and fetch ids that don't exist here.
   */
  tabsValidated: boolean;
}

// Web-side glue between WorkspaceTabsViewport (in @infrawrench/ui) and the
// per-kind panel components. Each open tab is rendered once and kept mounted
// across tab switches — see WorkspaceTabsViewport for the rendering rules.
export function WebWorkspaceTabsViewport({ orgId, tabsValidated }: WebWorkspaceTabsViewportProps) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const tabsHydrated = useUIStore((s) => s.tabsHydrated);

  // The URL is a "tab URL" when syncWorkspaceRouteFromPath returns a target.
  // On non-tab routes (onboarding) we hide all tab panels so the route's
  // <Outlet/> renders alone — tabs stay mounted in the DOM. Settings is a
  // hybrid: it lives in the tab strip like any other tab, but its content is
  // route-rendered (the section pages are a router subtree), so the viewport
  // steps aside for the <Outlet/> the same way — and hands the Settings tab's
  // panel over to the layout route, which is the element that holds what the
  // tab opens (see isRouteHostedTabPanel).
  const routeTarget = syncWorkspaceRouteFromPath(pathname, hash);
  const showActive = routeTarget !== null && routeTarget.kind !== "settings";

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
      panelRenderedByHost={(tab: WorkspaceTab) => isRouteHostedTabPanel(routeTarget, tab)}
      {...(tabsValidated
        ? {}
        : {
            shouldMountTab: (tab: WorkspaceTab) =>
              routeTarget !== null && workspaceTabTargetsEqual(tab.target, routeTarget),
          })}
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

const costReportsClients = new Map<string, CostReportsClient>();
function getCostReportsClient(orgId: string): CostReportsClient {
  let client = costReportsClients.get(orgId);
  if (!client) {
    client = createWebCostReportsClient(orgId);
    costReportsClients.set(orgId, client);
  }
  return client;
}

const invoicesClients = new Map<string, InvoicesClient>();
function getInvoicesClient(orgId: string): InvoicesClient {
  let client = invoicesClients.get(orgId);
  if (!client) {
    client = createWebInvoicesClient(orgId);
    invoicesClients.set(orgId, client);
  }
  return client;
}

const orphansClients = new Map<string, OrphansClient>();
function getOrphansClient(orgId: string): OrphansClient {
  let client = orphansClients.get(orgId);
  if (!client) {
    client = createWebOrphansClient(orgId);
    orphansClients.set(orgId, client);
  }
  return client;
}

const rightsizingClients = new Map<string, RightsizingClient>();
function getRightsizingClient(orgId: string): RightsizingClient {
  let client = rightsizingClients.get(orgId);
  if (!client) {
    client = createWebRightsizingClient(orgId);
    rightsizingClients.set(orgId, client);
  }
  return client;
}

const schedulesClients = new Map<string, SchedulesClient>();
function getSchedulesClient(orgId: string): SchedulesClient {
  let client = schedulesClients.get(orgId);
  if (!client) {
    client = createWebSchedulesClient(orgId);
    schedulesClients.set(orgId, client);
  }
  return client;
}

const logWorkspaceClients = new Map<string, LogWorkspaceClient>();
function getLogWorkspaceClient(orgId: string): LogWorkspaceClient {
  let client = logWorkspaceClients.get(orgId);
  if (!client) {
    client = createWebLogWorkspaceClient(orgId);
    logWorkspaceClients.set(orgId, client);
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
      return (
        <WebWorkflowsPanel
          client={getWorkflowClient(orgId)}
          orgId={orgId}
          workflowId={t.workflowId}
          // The URL owns which workflow is open — navigating is what records it
          // on the tab, so a reload or a tab switch comes back to it.
          onSelectWorkflow={(workflowId) =>
            void navigate(getWorkspaceNavigateArgs(workflowsTabTarget(workflowId ?? undefined)))
          }
        />
      );
    case "deployments":
      return (
        <WebDeploymentsPanel
          client={getDeploymentClient(orgId)}
          orgId={orgId}
          {...(t.repo ? { initialRepo: t.repo } : {})}
        />
      );
    case "costs":
      return (
        <CostsPanel
          // Keyed by org so switching org remounts the panel and refetches
          // rather than showing the previous org's budgets and flagged
          // resources.
          key={orgId}
          client={getCostsClient(orgId)}
          onOpenExternal={(url) => window.open(url, "_blank", "noopener,noreferrer")}
          onOpenDashboard={(dashboardId) =>
            void navigate(getWorkspaceNavigateArgs({ kind: "dashboard", dashboardId }))
          }
          orphans={getOrphansClient(orgId)}
          onOpenResource={(r, accountId) => {
            if (!r.id) return;
            void navigate(
              getWorkspaceNavigateArgs({
                kind: "resource",
                accountId,
                resourceId: r.id,
                view: "details",
                pluginId: r.pluginId,
                resourceTypeId: r.resourceTypeId,
              }),
            );
          }}
          rightsizing={getRightsizingClient(orgId)}
          onOpenOversizedResource={(r, accountId) => {
            if (!r.id) return;
            void navigate(
              getWorkspaceNavigateArgs({
                kind: "resource",
                accountId,
                resourceId: r.id,
                view: "details",
                pluginId: r.pluginId,
                resourceTypeId: r.resourceTypeId,
              }),
            );
          }}
          schedules={getSchedulesClient(orgId)}
          onOpenScheduledResource={(s) =>
            void navigate(
              getWorkspaceNavigateArgs({
                kind: "resource",
                accountId: s.accountId,
                resourceId: s.resourceId,
                view: "details",
                pluginId: s.pluginId,
                resourceTypeId: s.resourceTypeId,
              }),
            )
          }
        />
      );
    case "cost-reports":
      return (
        <CostReportsPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's reports.
          key={orgId}
          client={getCostReportsClient(orgId)}
          reportId={t.reportId}
          // The URL owns which report is open — navigating is what records it
          // on the tab, so a reload or a tab switch comes back to it.
          onSelectReport={(reportId) =>
            void navigate(getWorkspaceNavigateArgs(costReportsTabTarget(reportId)))
          }
          onOpenDashboard={(dashboardId) =>
            void navigate(getWorkspaceNavigateArgs({ kind: "dashboard", dashboardId }))
          }
        />
      );
    case "invoices":
      return (
        <InvoicesPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's customers.
          key={orgId}
          client={getInvoicesClient(orgId)}
          invoiceId={t.invoiceId}
          // The URL owns which invoice is open — navigating is what records it
          // on the tab, so a reload or a tab switch comes back to it.
          onSelectInvoice={(invoiceId) =>
            void navigate(getWorkspaceNavigateArgs(invoicesTabTarget(invoiceId)))
          }
        />
      );
    case "graph":
      return (
        <WebGraphPanel
          orgId={orgId}
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
          // Keyed by org so switching org remounts the panel and refetches
          // rather than tailing the previous org's streams.
          key={orgId}
          client={getLogWorkspaceClient(orgId)}
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
      return <WebChangesPanel key={orgId} orgId={orgId} />;
    case "expiring":
      return (
        <WebExpiryPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's deadlines.
          key={orgId}
          orgId={orgId}
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
        <WebPosturePanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's findings.
          key={orgId}
          orgId={orgId}
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
    case "access-review":
      return (
        <WebAccessReviewPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's principals.
          key={orgId}
          orgId={orgId}
          openResource={(principal) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  principal.accountId,
                  principal.resourceId,
                  principal.pluginId,
                  principal.resourceTypeId,
                ),
              ),
            )
          }
        />
      );
    case "backups":
      return (
        <WebBackupsPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's coverage.
          key={orgId}
          orgId={orgId}
          openResource={(target) =>
            void navigate(
              getWorkspaceNavigateArgs(resourceTabTarget(target.accountId, target.resourceId)),
            )
          }
        />
      );
    case "wallboard":
      return (
        <WebWallboardPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's wall.
          key={orgId}
          orgId={orgId}
        />
      );
    case "dns":
      return (
        <WebDnsPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's zones.
          key={orgId}
          orgId={orgId}
          openRecord={(record) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  record.accountId,
                  record.resourceId,
                  record.pluginId,
                  record.resourceTypeId,
                ),
              ),
            )
          }
          openZone={(zone) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  zone.accountId,
                  zone.resourceId,
                  zone.pluginId,
                  zone.resourceTypeId,
                ),
              ),
            )
          }
        />
      );
    case "iac":
      return <WebIacPanel key={orgId} orgId={orgId} />;
    case "environment-diff":
      return (
        <WebEnvironmentDiffPanel
          // Keyed by org so switching org remounts and refetches rather than
          // comparing this org's accounts against the previous one's ids.
          key={orgId}
          orgId={orgId}
          a={t.a}
          b={t.b}
          // Record the pair on the tab and in the URL, so the comparison
          // survives a reload and can be shared as a link. `replace` keeps the
          // back button from stepping through every dropdown change.
          onSelectionChange={(selection) =>
            void navigateToWorkspaceTarget(
              navigate,
              environmentDiffTabTarget(selection.a, selection.b),
              { replace: true },
            )
          }
          openResource={(target) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  target.accountId,
                  target.resourceId,
                  target.pluginId,
                  target.resourceTypeId,
                ),
              ),
            )
          }
        />
      );
    case "environments":
      return (
        <WebEnvironmentsPanel
          key={orgId}
          orgId={orgId}
          openResource={(target) =>
            void navigate(
              getWorkspaceNavigateArgs(
                resourceTabTarget(
                  target.accountId,
                  target.resourceId,
                  target.pluginId,
                  target.resourceTypeId,
                ),
              ),
            )
          }
        />
      );
    case "ssh-fanout":
      return <WebSshFanoutPanel key={orgId} orgId={orgId} />;
    case "metric-alerts":
      return <WebMetricAlertsPanel key={orgId} orgId={orgId} />;
    case "probes":
      return <WebProbesPanel key={orgId} orgId={orgId} />;
    case "status-pages":
      return <WebStatusPagesPanel key={orgId} orgId={orgId} />;
    case "quotas":
      return <WebQuotasPanel key={orgId} orgId={orgId} />;
    case "incidents":
      return (
        <WebIncidentsPanel
          key={orgId}
          orgId={orgId}
          incidentId={t.incidentId}
          // The URL owns which incident is open — navigating is what records it
          // on the tab, so a reload or a tab switch comes back to it.
          onSelectIncident={(incidentId) =>
            void navigate(getWorkspaceNavigateArgs(incidentsTabTarget(incidentId ?? undefined)))
          }
        />
      );
    case "chat":
      return <WebChatPanel orgId={orgId} conversationId={t.conversationId} />;
    case "settings":
      // Route-rendered (see showActive above) — the tab only marks the place
      // in the strip; the settings router subtree draws the content.
      return null;
    case "linux-app":
      // Joins the session the host's Apps tab opened; a window tab carries no
      // key of its own, which is why closing that tab ends its windows too.
      return (
        <WebAppWindowPanel
          accountId={t.accountId}
          resourceId={t.resourceId}
          windowId={t.windowId}
          tabId={tab.id}
        />
      );
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
