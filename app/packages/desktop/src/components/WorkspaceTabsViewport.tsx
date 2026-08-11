import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRouterState } from "@tanstack/react-router";
import { hasPermission } from "@infrawrench/client-core";
import {
  WorkspaceTabsViewport as BaseViewport,
  dashboardTabTarget,
  environmentDiffTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  resourceTabTarget,
  DeploymentsPanel,
  IssueFilingProvider,
  useUIStore,
  workspaceTabTargetsEqual,
  type DeploymentClient,
  type WorkspaceTab,
} from "@infrawrench/ui";
import { createDesktopSettingsApi } from "@/lib/settings-client";
import { invoke } from "@/lib/invoke";
import { DashboardPanel } from "@/routes/dashboard.$dashboardId";
import { AccountPanel } from "@/routes/accounts.$accountId";
import { ResourcePanel } from "@/routes/resource.$accountId.$resourceId";
import {
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
  syncWorkspaceRouteFromPath,
} from "@/lib/workspace-tabs";
import { CostsPanel, type CostsClient } from "@infrawrench/ui/cost";
import { CostReportsPanel, type CostReportsClient } from "@infrawrench/ui/cost-reports";
import { InvoicesPanel, type InvoicesClient } from "@infrawrench/ui/invoices";
import { type OrphansClient, type RightsizingClient, type SchedulesClient } from "@infrawrench/ui";
import { createDesktopCostsClient } from "@/lib/costs-client";
import { createDesktopCostReportsClient } from "@/lib/cost-reports-client";
import { createDesktopInvoicesClient } from "@/lib/invoices-client";
import { createDesktopSchedulesClient } from "@/lib/schedules-client";
import { createDesktopOrphansClient } from "@/lib/orphans-client";
import { createDesktopRightsizingClient } from "@/lib/rightsizing-client";
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
import { DesktopDnsPanel } from "@/components/DesktopDnsPanel";
import { DesktopEnvironmentDiffPanel } from "@/components/DesktopEnvironmentDiffPanel";
import { DesktopMetricAlertsPanel } from "@/components/DesktopMetricAlertsPanel";
import { DesktopProbesPanel } from "@/components/DesktopProbesPanel";
import { DesktopQuotasPanel } from "@/components/DesktopQuotasPanel";
import { DesktopIncidentsPanel } from "@/components/DesktopIncidentsPanel";
import { DesktopSshFanoutPanel } from "@/components/DesktopSshFanoutPanel";
import { DesktopSettingsPanel } from "@/components/DesktopSettingsPanel";
import { DesktopAgentsPanel } from "@/components/DesktopAgentsPanel";

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

let costReportsClient: CostReportsClient | null = null;
function getCostReportsClient(): CostReportsClient {
  if (!costReportsClient) costReportsClient = createDesktopCostReportsClient();
  return costReportsClient;
}

let invoicesClient: InvoicesClient | null = null;
function getInvoicesClient(): InvoicesClient {
  if (!invoicesClient) invoicesClient = createDesktopInvoicesClient();
  return invoicesClient;
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
  // On non-tab routes (index) we hide all tab panels so the route's
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
    <IssueFiling orgId={activeCloudOrgId}>
      <BaseViewport
        showActive={showActive}
        renderTabPanel={(tab) => renderPanel(tab, navigate, activeCloudOrgId)}
      />
    </IssueFiling>
  );
}

/**
 * Bind the shared issue-filing provider (Jira and Linear) to the desktop's
 * cloud transport, so the Costs, Savings, and Posture tabs offer to file a
 * finding exactly as web does.
 *
 * Local (non-cloud) mode has no org and no cloud credentials, so it renders
 * the children bare — the filing context is then absent and every button
 * resolves to nothing, which is the correct answer rather than a control that
 * could only fail.
 *
 * Requests go over the same allowlisted `cloud_settings_request` IPC channel
 * the settings sections use; `/jira` and `/linear` are in that allowlist
 * (electron/cloud-data/settings.ts).
 */
function IssueFiling({ orgId, children }: { orgId: string | null; children: ReactNode }) {
  const api = useMemo(() => createDesktopSettingsApi(), []);
  const [permissions, setPermissions] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!orgId) {
      setPermissions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const me = await api.get<{ permissions: string[] }>(`/api/org/${orgId}/team/me`);
        if (!cancelled) setPermissions(me.permissions);
      } catch {
        if (!cancelled) setPermissions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId]);

  if (!orgId) return <>{children}</>;

  return (
    <IssueFilingProvider
      orgId={orgId}
      api={api}
      canReadJira={hasPermission(permissions, "jira:read")}
      canFileJira={hasPermission(permissions, "jira:write")}
      canReadLinear={hasPermission(permissions, "linear:read")}
      canFileLinear={hasPermission(permissions, "linear:write")}
      openExternal={(url) => void invoke("open_external_url", { url })}
    >
      {children}
    </IssueFilingProvider>
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
      return <DesktopAgentsPanel navigate={(args) => void navigate(args)} />;
    case "workflows":
      return <DesktopWorkflowsPanel />;
    case "costs":
      return (
        <CostsPanel
          // Keyed by org so switching org refetches rather than showing the
          // previous org's budgets and flagged resources.
          key={activeCloudOrgId ?? "local"}
          client={getCostsClient()}
          // Always the system browser: a provider's top-up page is a billing
          // flow and has no business inside the app shell.
          onOpenExternal={(url) => void invoke("open_external_url", { url })}
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
    case "cost-reports":
      // Cloud-only, like Costs: reports are org rows over server-collected
      // spend, so local mode has neither the store nor the data. The tile is
      // hidden without an org; this guard covers a restored tab.
      return activeCloudOrgId ? (
        <CostReportsPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's reports.
          key={activeCloudOrgId}
          client={getCostReportsClient()}
          reportId={t.reportId}
          // The URL owns which report is open, so navigating is what records it
          // on the tab and brings it back on reactivation.
          onSelectReport={(reportId) =>
            void navigate(getWorkspaceNavigateArgs(costReportsTabTarget(reportId)))
          }
          onOpenDashboard={(dashboardId) =>
            void navigate(getWorkspaceNavigateArgs(dashboardTabTarget(dashboardId)))
          }
        />
      ) : (
        <div className="h-full flex items-center justify-center px-8 text-center text-sm text-on-surface-faint">
          Cost reports live in Infrawrench Cloud — sign in and pick an organization to see them.
        </div>
      );
    case "invoices":
      // Cloud-only, like Costs and Cost reports: an invoice bills for spend
      // collected server-side, so local mode has neither the customers nor the
      // data. The tile is hidden without an org; this guard covers a restored
      // tab.
      return activeCloudOrgId ? (
        <InvoicesPanel
          // Keyed by org so switching org remounts and refetches rather than
          // showing the previous org's customers.
          key={activeCloudOrgId}
          client={getInvoicesClient()}
          invoiceId={t.invoiceId}
          // The URL owns which invoice is open, so navigating is what records it
          // on the tab and brings it back on reactivation.
          onSelectInvoice={(invoiceId) =>
            void navigate(getWorkspaceNavigateArgs(invoicesTabTarget(invoiceId)))
          }
        />
      ) : (
        <div className="h-full flex items-center justify-center px-8 text-center text-sm text-on-surface-faint">
          Invoices live in Infrawrench Cloud — sign in and pick an organization to see them.
        </div>
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
    case "dns":
      return (
        <DesktopDnsPanel
          // Keyed by mode so switching org (or dropping to local) remounts
          // and refetches rather than showing the previous mode's zones.
          key={activeCloudOrgId ?? "local"}
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
    case "environment-diff":
      return (
        <DesktopEnvironmentDiffPanel
          // Keyed by mode so switching org (or dropping to local) remounts and
          // recompares rather than showing the previous mode's accounts.
          key={activeCloudOrgId ?? "local"}
          a={t.a}
          b={t.b}
          // Record the pair on the tab and in the URL, so the comparison
          // survives a restart. `replace` keeps the back button from stepping
          // through every dropdown change.
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
    case "ssh-fanout":
      return <DesktopSshFanoutPanel />;
    case "metric-alerts":
      return <DesktopMetricAlertsPanel />;
    case "probes":
      return <DesktopProbesPanel />;
    case "quotas":
      return <DesktopQuotasPanel />;
    case "incidents":
      return <DesktopIncidentsPanel incidentId={t.incidentId} />;
    case "settings":
      return <DesktopSettingsPanel section={t.section ?? ""} />;
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
