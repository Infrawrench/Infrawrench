import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { useUIStore, withoutDisabledProducts, type SidebarToolDef } from "@infrawrench/ui";
import type { OrgFeature } from "@infrawrench/client-core";
import { WorkflowIcon } from "@infrawrench/ui/workflows";
import { CostsIcon } from "@infrawrench/ui/cost";
import { CostReportsIcon } from "@infrawrench/ui/cost-reports";
import { ResourceReportsIcon } from "@infrawrench/ui/resource-reports";
import { CostCanvasesIcon } from "@infrawrench/ui/cost-canvases";
import { KubernetesEfficiencyIcon } from "@infrawrench/ui/k8s-efficiency";
import { InvoicesIcon } from "@infrawrench/ui/invoices";
import {
  DeployIcon,
  ChangesIcon,
  IacIcon,
  GraphIcon,
  ExpiryIcon,
  PostureIcon,
  VulnerabilitiesIcon,
  ComplianceIcon,
  AccessReviewIcon,
  JitAccessIcon,
  BackupsIcon,
  WallboardIcon,
  CalendarIcon,
  RunbookIcon,
  QueryMonitorIcon,
  DomainsIcon,
  EnvironmentDiffIcon,
  FanoutIcon,
  LogsIcon,
  MetricAlertIcon,
  ProbesIcon,
  StatusPagesIcon,
  QuotasIcon,
  PriceCatalogIcon,
  IncidentsIcon,
  SlosIcon,
  ServicesIcon,
  DeliveryIcon,
  CiIcon,
  EnvironmentsIcon,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";
import { useDisabledProducts } from "@/lib/disabled-products";
import { complianceTabTarget, getWorkspaceNavigateArgs } from "@/lib/workspace-tabs";

/**
 * The org-level tools, one entry per sidebar tile. One list feeds both the
 * sidebar's Apps tree, spotlight and the Home tab, which groups the same entries
 * into products (`PRODUCTS` in `@infrawrench/ui`) by their `key`; a tool
 * added here shows in the launcher at once and on Home once a product claims
 * its key.
 */
export function useOrgTools(orgId: string | undefined): SidebarToolDef[] {
  const gt = useGT();
  const navigate = useNavigate();

  // Features a platform admin rolls out per organization (CI): their
  // entry points show only once the organization has them.
  const [orgFeatures, setOrgFeatures] = useState<readonly OrgFeature[]>([]);
  useEffect(() => {
    setOrgFeatures([]);
    if (!orgId) return;
    let cancelled = false;
    apiGet<{ features: OrgFeature[] }>(`/api/org/${orgId}/features`)
      .then((r) => !cancelled && setOrgFeatures(r.features))
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Apps the organization has turned off take their tools with them, which
  // is what removes them from the Apps tree, Recent, the launcher and Home.
  const disabledProducts = useDisabledProducts(orgId);

  if (!orgId) return [];
  const tools: SidebarToolDef[] = [
    {
      key: "agents",
      label: gt("Agents"),
      icon: <span className="font-mono text-[11px]">&gt;_</span>,
      onClick: () => void navigate({ to: "/org/$orgId/agents", params: { orgId: orgId! } }),
    },
    {
      key: "workflows",
      label: gt("Workflows"),
      icon: <WorkflowIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/workflows", params: { orgId: orgId! } }),
    },
    {
      key: "deploy",
      label: gt("Deploy"),
      icon: <DeployIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/deployments", params: { orgId: orgId! } }),
    },
    {
      key: "costs",
      label: gt("Costs"),
      icon: <CostsIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/costs", params: { orgId: orgId! } }),
    },
    {
      key: "cost-reports",
      label: gt("Reports"),
      icon: <CostReportsIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/cost-reports", params: { orgId: orgId! } }),
    },
    {
      key: "resource-reports",
      label: gt("Resource reports"),
      icon: <ResourceReportsIcon />,
      onClick: () =>
        void navigate({ to: "/org/$orgId/resource-reports", params: { orgId: orgId! } }),
    },
    {
      key: "cost-canvases",
      label: gt("Canvases"),
      icon: <CostCanvasesIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/cost-canvases", params: { orgId: orgId! } }),
    },
    {
      key: "k8s-efficiency",
      label: gt("Kubernetes efficiency"),
      icon: <KubernetesEfficiencyIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/k8s-efficiency", params: { orgId: orgId! } }),
    },
    {
      key: "invoices",
      label: gt("Invoices"),
      icon: <InvoicesIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/invoices", params: { orgId: orgId! } }),
    },
    {
      key: "metric-alerts",
      label: gt("Alerts"),
      icon: <MetricAlertIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/metric-alerts", params: { orgId: orgId! } }),
    },
    {
      key: "changes",
      label: gt("Changes"),
      icon: <ChangesIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/changes", params: { orgId: orgId! } }),
    },
    {
      key: "iac",
      label: gt("IaC"),
      icon: <IacIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/iac", params: { orgId: orgId! } }),
    },
    {
      key: "graph",
      label: gt("Graph"),
      icon: <GraphIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/graph", params: { orgId: orgId! } }),
    },
    {
      key: "environments",
      label: gt("Environments"),
      icon: <EnvironmentsIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/environments", params: { orgId: orgId! } }),
    },
    {
      key: "expiring",
      label: gt("Expiring"),
      icon: <ExpiryIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/expiring", params: { orgId: orgId! } }),
    },
    {
      key: "posture",
      label: gt("Posture"),
      icon: <PostureIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/posture", params: { orgId: orgId! } }),
    },
    {
      key: "vulnerabilities",
      label: gt("Vulnerabilities"),
      icon: <VulnerabilitiesIcon />,
      onClick: () =>
        void navigate({ to: "/org/$orgId/vulnerabilities", params: { orgId: orgId! } }),
    },
    // A workspace-tab kind that remembers its framework: the tile
    // returns to the open tab's framework rather than resetting it.
    {
      key: "compliance",
      label: gt("Compliance"),
      icon: <ComplianceIcon />,
      onClick: () =>
        void navigate(
          getWorkspaceNavigateArgs(
            useUIStore.getState().workspaceTabs.find((tab) => tab.target.kind === "compliance")
              ?.target ?? complianceTabTarget(),
          ),
        ),
    },
    {
      key: "access-review",
      label: gt("Access review"),
      icon: <AccessReviewIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/access-review", params: { orgId: orgId! } }),
    },
    {
      key: "jit-access",
      label: gt("Just-in-time access"),
      icon: <JitAccessIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/jit-access", params: { orgId: orgId! } }),
    },
    {
      key: "backups",
      label: gt("Backups"),
      icon: <BackupsIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/backups", params: { orgId: orgId! } }),
    },
    {
      key: "wallboard",
      label: gt("Wallboard"),
      icon: <WallboardIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/wallboard", params: { orgId: orgId! } }),
    },
    {
      key: "calendar",
      label: gt("Calendar"),
      icon: <CalendarIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/calendar", params: { orgId: orgId! } }),
    },
    {
      key: "runbooks",
      label: gt("Runbooks"),
      icon: <RunbookIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/runbooks", params: { orgId: orgId! } }),
    },
    {
      key: "query-monitors",
      label: gt("Query monitors"),
      icon: <QueryMonitorIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/query-monitors", params: { orgId: orgId! } }),
    },
    {
      key: "dns",
      label: gt("Domains"),
      icon: <DomainsIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/dns", params: { orgId: orgId! } }),
    },
    {
      key: "environment-diff",
      label: gt("Env diff"),
      icon: <EnvironmentDiffIcon />,
      onClick: () =>
        void navigate({
          to: "/org/$orgId/environment-diff",
          params: { orgId: orgId! },
        }),
    },
    {
      key: "probes",
      label: gt("Probes"),
      icon: <ProbesIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/probes", params: { orgId: orgId! } }),
    },
    {
      key: "slos",
      label: gt("SLOs"),
      icon: <SlosIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/slos", params: { orgId: orgId! } }),
    },
    {
      key: "services",
      label: gt("Services"),
      icon: <ServicesIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/services", params: { orgId: orgId! } }),
    },
    {
      key: "delivery",
      label: gt("Delivery"),
      icon: <DeliveryIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/delivery", params: { orgId: orgId! } }),
    },
    ...(orgFeatures.includes("ci")
      ? [
          {
            key: "ci",
            label: gt("CI"),
            icon: <CiIcon />,
            onClick: () => void navigate({ to: "/org/$orgId/ci", params: { orgId: orgId! } }),
          },
        ]
      : []),
    {
      key: "status-pages",
      label: gt("Status pages"),
      icon: <StatusPagesIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/status-pages", params: { orgId: orgId! } }),
    },
    {
      key: "quotas",
      label: gt("Quotas"),
      icon: <QuotasIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/quotas", params: { orgId: orgId! } }),
    },
    {
      key: "price-catalog",
      label: gt("Price catalog"),
      icon: <PriceCatalogIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/price-catalog", params: { orgId: orgId! } }),
    },
    {
      key: "incidents",
      label: gt("Incidents"),
      icon: <IncidentsIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/incidents", params: { orgId: orgId! } }),
    },
    {
      key: "ssh-fanout",
      label: gt("Fan-out"),
      icon: <FanoutIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/ssh-fanout", params: { orgId: orgId! } }),
    },
    {
      key: "logs",
      label: gt("Logs"),
      icon: <LogsIcon />,
      onClick: () => void navigate({ to: "/org/$orgId/logs", params: { orgId: orgId! } }),
    },
  ];
  return withoutDisabledProducts(tools, disabledProducts);
}
