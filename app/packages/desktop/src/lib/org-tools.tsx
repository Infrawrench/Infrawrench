import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import {
  AccessReviewIcon,
  BackupsIcon,
  CalendarIcon,
  ChangesIcon,
  CiIcon,
  ComplianceIcon,
  DeliveryIcon,
  DeployIcon,
  DomainsIcon,
  EnvironmentDiffIcon,
  EnvironmentsIcon,
  ExpiryIcon,
  FanoutIcon,
  GraphIcon,
  IacIcon,
  IncidentsIcon,
  JitAccessIcon,
  LogsIcon,
  MetricAlertIcon,
  PostureIcon,
  PriceCatalogIcon,
  ProbesIcon,
  QueryMonitorIcon,
  QuotasIcon,
  RunbookIcon,
  ServicesIcon,
  SlosIcon,
  StatusPagesIcon,
  VulnerabilitiesIcon,
  WallboardIcon,
  useUIStore,
  withoutDisabledProducts,
  type SidebarToolDef,
} from "@infrawrench/ui";
import { WorkflowIcon } from "@infrawrench/ui/workflows";
import { CostsIcon } from "@infrawrench/ui/cost";
import { CostReportsIcon } from "@infrawrench/ui/cost-reports";
import { ResourceReportsIcon } from "@infrawrench/ui/resource-reports";
import { CostCanvasesIcon } from "@infrawrench/ui/cost-canvases";
import { KubernetesEfficiencyIcon } from "@infrawrench/ui/k8s-efficiency";
import { InvoicesIcon } from "@infrawrench/ui/invoices";
import type { OrgFeature } from "@infrawrench/client-core";
import {
  accessReviewTabTarget,
  agentsTabTarget,
  backupsTabTarget,
  calendarTabTarget,
  complianceTabTarget,
  costCanvasesTabTarget,
  costReportsTabTarget,
  costsTabTarget,
  deploymentsTabTarget,
  dnsTabTarget,
  environmentDiffTabTarget,
  environmentsTabTarget,
  graphTabTarget,
  iacTabTarget,
  invoicesTabTarget,
  jitAccessTabTarget,
  k8sEfficiencyTabTarget,
  logsTabTarget,
  queryMonitorsTabTarget,
  resourceReportsTabTarget,
  runbooksTabTarget,
  vulnerabilitiesTabTarget,
  wallboardTabTarget,
  workflowsTabTarget,
  navigateToWorkspaceTarget,
} from "./workspace-tabs";
import { cloudClient } from "./cloud-client";
import { useDisabledProducts } from "./disabled-products";
import { runRpc } from "./rpc/client";

/**
 * The org-level tools, one entry per sidebar tile. One list feeds both the
 * sidebar's Apps tree, spotlight and the Home tab, which groups the same entries
 * into products (`PRODUCTS` in `@infrawrench/ui`) by their `key`; a tool
 * added here shows in the launcher at once and on Home once a product claims
 * its key.
 */
export function useOrgTools(): SidebarToolDef[] {
  const gt = useGT();
  const navigate = useNavigate();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  // Features a platform admin rolls out per organization (CI): their entry
  // points show only once the active cloud organization has them.
  const [orgFeatures, setOrgFeatures] = useState<readonly OrgFeature[]>([]);
  useEffect(() => {
    setOrgFeatures([]);
    if (!activeCloudOrgId) return;
    let cancelled = false;
    runRpc(cloudClient("orgFeatures").orgFeatures.list({ params: { orgId: activeCloudOrgId } }))
      .then((r) => !cancelled && setOrgFeatures(r.features))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeCloudOrgId]);

  const disabledProducts = useDisabledProducts();

  // Deploy is here in both modes: with an org it is the full deploy screen,
  // and without one it is the history of what `infrawrench deploy` did on this
  // machine. Costs and Changes have no local half (spend is collected
  // server-side, change events are recorded by the cloud poller) so the tool
  // count differs between local and org mode; every surface lists
  // whatever it gets.
  const navTools: SidebarToolDef[] = [
    {
      key: "agents",
      label: gt("Agents"),
      icon: <span className="font-mono text-[11px]">&gt;_</span>,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, agentsTabTarget(), { label: gt("Agents") }),
    },
    {
      key: "workflows",
      label: gt("Workflows"),
      icon: <WorkflowIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, workflowsTabTarget(), { label: gt("Workflows") }),
    },
    {
      key: "deploy",
      label: gt("Deploy"),
      icon: <DeployIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, deploymentsTabTarget(), { label: gt("Deploy") }),
    },
    ...(activeCloudOrgId
      ? [
          {
            key: "costs",
            label: gt("Costs"),
            icon: <CostsIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, costsTabTarget(), { label: gt("Costs") }),
          },
          // Cloud-only for the same reason as Costs: a report is an org row
          // over server-collected spend, so local mode has nothing to save or
          // draw. A workspace tab, like Costs.
          {
            key: "cost-reports",
            label: gt("Reports"),
            icon: <CostReportsIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, costReportsTabTarget(), {
                label: gt("Reports"),
              }),
          },
          // Cloud-only like Reports: the rows join the cloud's synced inventory
          // with its cost store.
          {
            key: "resource-reports",
            label: gt("Resource reports"),
            icon: <ResourceReportsIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, resourceReportsTabTarget(), {
                label: gt("Resource reports"),
              }),
          },
          // Cloud-only: canvases are built by the cloud chat agent over
          // server-collected spend.
          {
            key: "cost-canvases",
            label: gt("Canvases"),
            icon: <CostCanvasesIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, costCanvasesTabTarget(), {
                label: gt("Canvases"),
              }),
          },
          // Cloud-only: the report reads server-collected Kubernetes cost.
          {
            key: "k8s-efficiency",
            label: gt("Kubernetes efficiency"),
            icon: <KubernetesEfficiencyIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, k8sEfficiencyTabTarget(), {
                label: gt("Kubernetes efficiency"),
              }),
          },
          // Cloud-only for the same reason as Costs: an invoice bills for
          // spend collected server-side, so local mode has neither the
          // customers nor the data. A workspace tab, like Costs and Reports.
          {
            key: "invoices",
            label: gt("Invoices"),
            icon: <InvoicesIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, invoicesTabTarget(), {
                label: gt("Invoices"),
              }),
          },
          // Cloud-only for the same reason as Costs: rules are evaluated by
          // the cloud poller against the cloud metric store. Not a workspace
          // tab: same as web, a plain route.
          {
            key: "metric-alerts",
            label: gt("Alerts"),
            icon: <MetricAlertIcon />,
            onClick: () => void navigate({ to: "/metric-alerts" }),
          },
          // Cloud-only for the same reason as Costs: change events are recorded
          // by the cloud poller, and there is no poller in local-only mode.
          // Not a workspace tab: same as web, a plain route.
          {
            key: "changes",
            label: gt("Changes"),
            icon: <ChangesIcon />,
            onClick: () => void navigate({ to: "/changes" }),
          },
          // Cloud-only, unlike Posture next to it: the review joins the org's
          // resource-ownership records and the shared dismissal store, neither
          // of which local mode has, and answering "unowned" for every
          // principal would describe the desktop app rather than the clouds.
          // A workspace-tab kind, so the strip stays in sync with the panel.
          {
            key: "access-review",
            label: gt("Access review"),
            icon: <AccessReviewIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, accessReviewTabTarget(), {
                label: gt("Access review"),
              }),
          },
          // Cloud-only for the same reason: policies, approvers and the
          // expiry sweep live in the cloud.
          {
            key: "jit-access",
            label: gt("Just-in-time access"),
            icon: <JitAccessIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, jitAccessTabTarget(), {
                label: gt("Just-in-time access"),
              }),
          },
          // Cloud-only: reconciliation classifies the org's *synced*
          // inventory against an uploaded Terraform state, and local-only mode
          // has no synced inventory.
          {
            key: "iac",
            label: gt("IaC"),
            icon: <IacIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, iacTabTarget(), { label: gt("IaC") }),
          },
          // Cloud-only like Changes: probes run in the cloud poller through
          // the egress proxy, and results live in the cloud metric store.
          {
            key: "probes",
            label: gt("Probes"),
            icon: <ProbesIcon />,
            onClick: () => void navigate({ to: "/probes" }),
          },
          // Cloud-only: an SLO is evaluated by the cloud poller over the cloud
          // metric store, the probes stance.
          {
            key: "slos",
            label: gt("SLOs"),
            icon: <SlosIcon />,
            onClick: () => void navigate({ to: "/slos" }),
          },
          // Cloud-only: membership and scores are resolved in the cloud, the
          // SLOs stance.
          {
            key: "services",
            label: gt("Services"),
            icon: <ServicesIcon />,
            onClick: () => void navigate({ to: "/services" }),
          },
          // Cloud-only: deploy events and incidents live in the cloud.
          {
            key: "delivery",
            label: gt("Delivery"),
            icon: <DeliveryIcon />,
            onClick: () => void navigate({ to: "/delivery" }),
          },
          // Cloud-only and rolled out per organization: runs come from the
          // GitHub App's webhooks.
          ...(orgFeatures.includes("ci")
            ? [
                {
                  key: "ci",
                  label: gt("CI"),
                  icon: <CiIcon />,
                  onClick: () => void navigate({ to: "/ci", search: {} }),
                },
              ]
            : []),
          {
            key: "status-pages",
            label: gt("Status pages"),
            icon: <StatusPagesIcon />,
            onClick: () => void navigate({ to: "/status-pages" }),
          },
          // Cloud-only, and with no local half at all: a quota reading is a
          // live credentialed provider call on a schedule only the poller
          // runs, and the trend needs history only the cloud stores.
          {
            key: "quotas",
            label: gt("Quotas"),
            icon: <QuotasIcon />,
            onClick: () => void navigate({ to: "/quotas" }),
          },
          {
            key: "price-catalog",
            label: gt("Price catalog"),
            icon: <PriceCatalogIcon />,
            onClick: () => void navigate({ to: "/price-catalog" }),
          },
          // Cloud-only for the same reason as Probes: an incident is
          // org-scoped and declaring one composes cloud features.
          {
            key: "incidents",
            label: gt("Incidents"),
            icon: <IncidentsIcon />,
            onClick: () => void navigate({ to: "/incidents" }),
          },
          // Cloud-only: an ephemeral environment is created against org
          // accounts, recorded in org tables and torn down by the cloud lease
          // pass. There is no local half to render.
          {
            key: "environments",
            label: gt("Environments"),
            icon: <EnvironmentsIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, environmentsTabTarget(), {
                label: gt("Environments"),
              }),
          },
        ]
      : []),
    // Graph has a local half (output references live in the local SQLite)
    // so unlike Costs the tile shows in both modes.
    {
      key: "graph",
      label: gt("Graph"),
      icon: <GraphIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, graphTabTarget(), { label: gt("Graph") }),
    },
    // Expiring also has a local half: the feed is computed from stored state
    // and the locally loaded plugins' expiry declarations. Not a workspace
    // tab: same as web and Changes, a plain route.
    {
      key: "expiring",
      label: gt("Expiring"),
      icon: <ExpiryIcon />,
      onClick: () => void navigate({ to: "/expiring" }),
    },
    // Posture also has a local half: findings are computed from stored state
    // and the locally loaded plugins' posture declarations. A plain route,
    // same as Expiring.
    {
      key: "posture",
      label: gt("Posture"),
      icon: <PostureIcon />,
      onClick: () => void navigate({ to: "/posture" }),
    },
    // Vulnerabilities is cloud only (the poller collects scanner findings)
    // but shows in both modes like Backups, so local mode gets the panel's
    // explanation rather than a missing tile. A workspace-tab kind.
    {
      key: "vulnerabilities",
      label: gt("Vulnerabilities"),
      icon: <VulnerabilitiesIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, vulnerabilitiesTabTarget(), {
          label: gt("Vulnerabilities"),
        }),
    },
    // Compliance is cloud only (its evidence is org state: the audit log,
    // access decisions, scanner findings) but shows in both modes like
    // Vulnerabilities. A workspace-tab kind that remembers its framework, so
    // the tile returns to the open tab's framework rather than resetting it.
    {
      key: "compliance",
      label: gt("Compliance"),
      icon: <ComplianceIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(
          navigate,
          useUIStore.getState().workspaceTabs.find((tab) => tab.target.kind === "compliance")
            ?.target ?? complianceTabTarget(),
          { label: gt("Compliance") },
        ),
    },
    // Backups is cloud only: the coverage could be computed locally, but the
    // recovery objectives it is judged against are org state with nowhere to
    // live in a single-machine workspace. A workspace-tab kind so the strip
    // stays in sync with the active panel.
    {
      key: "backups",
      label: gt("Backups"),
      icon: <BackupsIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, backupsTabTarget(), { label: gt("Backups") }),
    },
    // The wallboard is cloud only: three of its four sources (incidents, query
    // monitors, sync paging) are org state.
    {
      key: "wallboard",
      label: gt("Wallboard"),
      icon: <WallboardIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, wallboardTabTarget(), { label: gt("Wallboard") }),
    },
    // The operations calendar is cloud only for the same reason Backups is:
    // five of its six sources are org state.
    {
      key: "calendar",
      label: gt("Calendar"),
      icon: <CalendarIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, calendarTabTarget(), { label: gt("Calendar") }),
    },
    // Runbooks are cloud only: a procedure is a shared document and a run is a
    // record of who did what, so both are org state.
    {
      key: "runbooks",
      label: gt("Runbooks"),
      icon: <RunbookIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, runbooksTabTarget(), { label: gt("Runbooks") }),
    },
    // Query monitors are cloud only: the schedule is run by the poller, so a
    // monitor that only existed on one laptop would only run while that laptop
    // was open, which is the opposite of what a monitor is for.
    {
      key: "query-monitors",
      label: gt("Query monitors"),
      icon: <QueryMonitorIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, queryMonitorsTabTarget(), {
          label: gt("Query monitors"),
        }),
    },
    // Domains also has a local half: the inventory is computed from stored
    // state and the locally loaded plugins' DNS declarations. A workspace-tab
    // kind (same as Logs), so the strip stays in sync with the active panel.
    {
      key: "dns",
      label: gt("Domains"),
      icon: <DomainsIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, dnsTabTarget(), { label: gt("Domains") }),
    },
    // Env diff also has a local half: local mode enumerates both accounts
    // through the plugin, since the local workspace has no synced store to
    // read. Workspace-tab kind so a/b selection survives restart.
    {
      key: "environment-diff",
      label: gt("Env diff"),
      icon: <EnvironmentDiffIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, environmentDiffTabTarget(), {
          label: gt("Env diff"),
        }),
    },
    // Fan-out SSH has a local half (local SSH accounts exec through the
    // machine's own ssh machinery) so, like Graph, it shows in both modes.
    // A plain route, same as web.
    {
      key: "ssh-fanout",
      label: gt("Fan-out"),
      icon: <FanoutIcon />,
      onClick: () => void navigate({ to: "/ssh-fanout" }),
    },
    // Logs also has a local half (the in-renderer plugin clients fetch tails
    // directly) so like Graph the tile shows in both modes (saved queries
    // and alerting are the cloud-only part, hidden by the panel locally).
    {
      key: "logs",
      label: gt("Logs"),
      icon: <LogsIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, logsTabTarget(), { label: gt("Logs") }),
    },
  ];
  // Apps the organization has turned off take their tools with them, which
  // is what removes them from the Apps tree, Recent, the launcher and Home.
  // Local mode has no organization, so nothing is off.
  return withoutDisabledProducts(navTools, disabledProducts);
}
