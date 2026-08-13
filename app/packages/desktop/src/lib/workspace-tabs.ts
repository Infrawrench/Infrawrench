import {
  normalizeResourceId,
  useUIStore,
  dashboardTabTarget,
  accountTabTarget,
  agentsTabTarget,
  costsTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  graphTabTarget,
  logsTabTarget,
  changesTabTarget,
  expiringTabTarget,
  postureTabTarget,
  accessReviewTabTarget,
  backupsTabTarget,
  dnsTabTarget,
  iacTabTarget,
  environmentDiffTabTarget,
  environmentsTabTarget,
  sshFanoutTabTarget,
  metricAlertsTabTarget,
  probesTabTarget,
  statusPagesTabTarget,
  quotasTabTarget,
  incidentsTabTarget,
  chatTabTarget,
  workflowsTabTarget,
  deploymentsTabTarget,
  settingsTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  type WorkspaceTabTarget,
  type RouteNavigator,
} from "@infrawrench/ui";

// Re-export shared target factories
export {
  dashboardTabTarget,
  accountTabTarget,
  agentsTabTarget,
  costsTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  graphTabTarget,
  logsTabTarget,
  changesTabTarget,
  expiringTabTarget,
  postureTabTarget,
  accessReviewTabTarget,
  backupsTabTarget,
  dnsTabTarget,
  iacTabTarget,
  environmentDiffTabTarget,
  environmentsTabTarget,
  sshFanoutTabTarget,
  metricAlertsTabTarget,
  probesTabTarget,
  statusPagesTabTarget,
  quotasTabTarget,
  incidentsTabTarget,
  chatTabTarget,
  workflowsTabTarget,
  deploymentsTabTarget,
  settingsTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
};

export function getWorkspaceNavigateArgs(
  target: WorkspaceTabTarget,
  replace = false,
): {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  replace?: boolean;
  hash?: string;
} {
  switch (target.kind) {
    case "dashboard":
      return {
        to: "/dashboard/$dashboardId",
        params: { dashboardId: target.dashboardId },
        ...(replace ? { replace: true } : {}),
      };
    case "account":
      return {
        to: "/accounts/$accountId",
        params: { accountId: target.accountId },
        ...(replace ? { replace: true } : {}),
      };
    case "agents":
      return { to: "/agents", ...(replace ? { replace: true } : {}) };
    case "workflows":
      // Search passed explicitly, the settings/chat rule: navigating from a
      // workflow back to the list must CLEAR ?workflow= or the route resolves
      // straight back into the workflow somebody just left.
      return {
        to: "/workflows",
        search: target.workflowId ? { workflow: target.workflowId } : {},
        ...(replace ? { replace: true } : {}),
      };
    case "deployments":
      return {
        to: "/deployments",
        ...(target.repo ? { search: { repo: target.repo } } : {}),
        ...(replace ? { replace: true } : {}),
      };
    case "costs":
      return { to: "/costs", ...(replace ? { replace: true } : {}) };
    // Like chat and settings: the search object is always passed, so navigating
    // from a report back to the list CLEARS ?report= instead of resolving
    // straight back into the report.
    case "cost-reports":
      return {
        to: "/cost-reports",
        search: target.reportId ? { report: target.reportId } : {},
        ...(replace ? { replace: true } : {}),
      };
    // Same always-pass-`search` rule as Cost reports: omitting the key makes
    // TanStack retain ?invoice= when navigating from an invoice to the list.
    case "invoices":
      return {
        to: "/invoices",
        search: target.invoiceId ? { invoice: target.invoiceId } : {},
        ...(replace ? { replace: true } : {}),
      };
    case "graph":
      return { to: "/graph", ...(replace ? { replace: true } : {}) };
    case "logs":
      return { to: "/logs", ...(replace ? { replace: true } : {}) };
    case "changes":
      return { to: "/changes", ...(replace ? { replace: true } : {}) };
    case "expiring":
      return { to: "/expiring", ...(replace ? { replace: true } : {}) };
    case "posture":
      return { to: "/posture", ...(replace ? { replace: true } : {}) };
    case "access-review":
      return { to: "/access-review", ...(replace ? { replace: true } : {}) };
    case "backups":
      return { to: "/backups", ...(replace ? { replace: true } : {}) };
    case "dns":
      return { to: "/dns", ...(replace ? { replace: true } : {}) };
    case "iac":
      return { to: "/iac", ...(replace ? { replace: true } : {}) };
    // The two accounts ride as query parameters rather than path segments:
    // they are a pair of optional ids, not a hierarchy, and the panel is
    // reachable with neither of them chosen.
    case "environment-diff": {
      const search: Record<string, string> = {};
      if (target.a) search["a"] = target.a;
      if (target.b) search["b"] = target.b;
      return {
        to: "/environment-diff",
        ...(Object.keys(search).length > 0 ? { search } : {}),
        ...(replace ? { replace: true } : {}),
      };
    }
    case "environments":
      return { to: "/environments", ...(replace ? { replace: true } : {}) };
    case "ssh-fanout":
      return { to: "/ssh-fanout", ...(replace ? { replace: true } : {}) };
    case "metric-alerts":
      return { to: "/metric-alerts", ...(replace ? { replace: true } : {}) };
    case "probes":
      return { to: "/probes", ...(replace ? { replace: true } : {}) };
    case "status-pages":
      return { to: "/status-pages", ...(replace ? { replace: true } : {}) };
    case "quotas":
      return { to: "/quotas", ...(replace ? { replace: true } : {}) };
    case "incidents":
      // Search passed explicitly, the settings/chat rule: navigating from an
      // incident back to the list must CLEAR ?incident= or the route resolves
      // straight back into the incident somebody just left.
      return {
        to: "/incidents",
        search: target.incidentId ? { incident: target.incidentId } : {},
        ...(replace ? { replace: true } : {}),
      };
    case "settings":
      // Like chat: search passed explicitly so navigating back to the General
      // section CLEARS the ?section= param instead of resolving back to it.
      return {
        to: "/settings",
        search: target.section ? { section: target.section } : {},
        ...(replace ? { replace: true } : {}),
      };
    case "chat":
      // Always pass search explicitly: navigating from a conversation
      // (?conversation=x) to the list must CLEAR the param, or the route
      // resolves straight back to the conversation.
      return {
        to: "/chat",
        search: target.conversationId ? { conversation: target.conversationId } : {},
        ...(replace ? { replace: true } : {}),
      };
    case "resource": {
      const search: Record<string, string> = {};
      if (target.pluginId) search["plugin"] = target.pluginId;
      if (target.resourceTypeId) search["type"] = target.resourceTypeId;
      if (target.parentResourceId) search["parent"] = target.parentResourceId;
      if (target.agentSessionId) search["agentSession"] = target.agentSessionId;
      if (target.sshKeyId) search["sshKeyId"] = target.sshKeyId;
      if (target.sshKeyName) search["sshKeyName"] = target.sshKeyName;
      return {
        to: "/resource/$accountId/$resourceId",
        params: {
          accountId: target.accountId,
          resourceId: encodeURIComponent(normalizeResourceId(target.resourceId)),
        },
        ...(Object.keys(search).length > 0 ? { search } : {}),
        ...(target.view === "ssh"
          ? { hash: "ssh" }
          : target.view === "sftp"
            ? { hash: "sftp" }
            : {}),
        ...(replace ? { replace: true } : {}),
      };
    }
  }
  throw new Error(`Unsupported workspace tab target: ${JSON.stringify(target)}`);
}

// Note: each platform re-implements this thin wrapper to enable test mocking
// of useUIStore at the import boundary.
export function navigateToWorkspaceTarget(
  navigate: RouteNavigator,
  target: WorkspaceTabTarget,
  options?: { label?: string; replace?: boolean; mode?: "reuse-active" | "pin" },
): Promise<void> | void {
  const mode = options?.mode ?? "reuse-active";
  if (mode === "pin") {
    if (options?.label) useUIStore.getState().pinWorkspaceTab(target, options.label);
    else useUIStore.getState().pinWorkspaceTab(target);
  } else {
    if (options?.label) useUIStore.getState().openInActiveWorkspaceTab(target, options.label);
    else useUIStore.getState().openInActiveWorkspaceTab(target);
  }
  return navigate(getWorkspaceNavigateArgs(target, options?.replace));
}

export function syncWorkspaceRouteFromPath(
  pathname: string,
  hash?: string,
  // The router's search string (ParsedLocation.searchStr). The desktop app
  // runs on createHashHistory, so the real URL is `…#/path?query#view` and
  // window.location.search is always empty — callers must pass the search
  // string from router state instead of relying on window.location.
  search?: string,
): WorkspaceTabTarget | null {
  if (pathname === "/") return null;
  const normalizedHash = hash?.replace(/^#/, "");
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "workflows") {
    const params = new URLSearchParams(search ?? "");
    return workflowsTabTarget(params.get("workflow") ?? undefined);
  }
  if (segments[0] === "deployments") {
    const params = new URLSearchParams(search ?? "");
    return deploymentsTabTarget(params.get("repo") ?? undefined);
  }
  if (segments[0] === "agents") {
    return agentsTabTarget();
  }
  // /savings was the standalone potential-savings page; it is now a section of
  // Costs. Old links keep working by landing on the tab that carries the
  // content.
  if (segments[0] === "costs" || segments[0] === "savings") {
    return costsTabTarget();
  }
  if (segments[0] === "cost-reports") {
    const params = new URLSearchParams(search ?? "");
    return costReportsTabTarget(params.get("report") ?? undefined);
  }
  if (segments[0] === "invoices") {
    const params = new URLSearchParams(search ?? "");
    return invoicesTabTarget(params.get("invoice") ?? undefined);
  }
  if (segments[0] === "graph") {
    return graphTabTarget();
  }
  if (segments[0] === "logs") {
    return logsTabTarget();
  }
  if (segments[0] === "changes") {
    return changesTabTarget();
  }
  if (segments[0] === "expiring") {
    return expiringTabTarget();
  }
  if (segments[0] === "posture") {
    return postureTabTarget();
  }
  if (segments[0] === "access-review") {
    return accessReviewTabTarget();
  }
  if (segments[0] === "backups") {
    return backupsTabTarget();
  }
  if (segments[0] === "dns") {
    return dnsTabTarget();
  }
  if (segments[0] === "iac") {
    return iacTabTarget();
  }
  if (segments[0] === "environment-diff") {
    const params = new URLSearchParams(search ?? "");
    return environmentDiffTabTarget(params.get("a") ?? undefined, params.get("b") ?? undefined);
  }
  if (segments[0] === "environments") {
    return environmentsTabTarget();
  }
  if (segments[0] === "ssh-fanout") {
    return sshFanoutTabTarget();
  }
  if (segments[0] === "metric-alerts") {
    return metricAlertsTabTarget();
  }
  if (segments[0] === "probes") {
    return probesTabTarget();
  }
  if (segments[0] === "status-pages") {
    return statusPagesTabTarget();
  }
  if (segments[0] === "quotas") {
    return quotasTabTarget();
  }
  if (segments[0] === "incidents") {
    const params = new URLSearchParams(search ?? "");
    return incidentsTabTarget(params.get("incident") ?? undefined);
  }
  if (segments[0] === "chat") {
    const params = new URLSearchParams(search ?? "");
    return chatTabTarget(params.get("conversation") ?? undefined);
  }
  if (segments[0] === "settings") {
    const params = new URLSearchParams(search ?? "");
    return settingsTabTarget(params.get("section") ?? undefined);
  }
  if (segments[0] === "dashboard" && segments[1]) {
    return dashboardTabTarget(segments[1]);
  }
  if (segments[0] === "accounts" && segments[1]) {
    return accountTabTarget(segments[1]);
  }
  if (segments[0] === "resource" && segments[1] && segments[2]) {
    const params = new URLSearchParams(search ?? "");
    const agentSessionId = params.get("agentSession") ?? undefined;
    const sshKeyId = params.get("sshKeyId") ?? undefined;
    const sshKeyName = params.get("sshKeyName") ?? undefined;
    if (normalizedHash === "ssh")
      return resourceSshTabTarget(segments[1], segments.slice(2).join("/"), undefined, undefined, {
        ...(agentSessionId ? { agentSessionId } : {}),
        ...(sshKeyId ? { sshKeyId } : {}),
        ...(sshKeyName ? { sshKeyName } : {}),
      });
    if (normalizedHash === "sftp")
      return resourceSftpTabTarget(segments[1], segments.slice(2).join("/"));
    return resourceTabTarget(segments[1], segments.slice(2).join("/"));
  }
  return null;
}

/**
 * Document title for *plain* routes — pages that render outside the
 * workspace-tab system, where `syncWorkspaceRouteFromPath` returns null and
 * the active tab's title would therefore go stale in the window title.
 * Labels match the sidebar tiles the pages are opened from. Returns null on
 * tab routes (the tab title applies) and on unknown paths.
 */
export function plainRouteDocumentTitle(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  switch (segments[0]) {
    case "moment":
      return "Moment";
    default:
      return null;
  }
}
