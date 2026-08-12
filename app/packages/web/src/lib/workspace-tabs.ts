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
  dnsTabTarget,
  environmentDiffTabTarget,
  sshFanoutTabTarget,
  metricAlertsTabTarget,
  probesTabTarget,
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
  chatTabTarget,
  incidentsTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
};

function getCurrentOrgId(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^\/org\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

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
  const orgId = getCurrentOrgId();
  switch (target.kind) {
    case "dashboard":
      return {
        to: "/org/$orgId/dashboard/$dashboardId",
        params: { orgId, dashboardId: target.dashboardId },
        ...(replace ? { replace: true } : {}),
      };
    case "account":
      return {
        to: "/org/$orgId/accounts/$accountId",
        params: { orgId, accountId: target.accountId },
        ...(replace ? { replace: true } : {}),
      };
    case "agents":
      return {
        to: "/org/$orgId/agents",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "workflows":
      return {
        to: "/org/$orgId/workflows",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "deployments":
      return {
        to: "/org/$orgId/deployments",
        params: { orgId },
        ...(target.repo ? { search: { repo: target.repo } } : {}),
        ...(replace ? { replace: true } : {}),
      };
    case "costs":
      return {
        to: "/org/$orgId/costs",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    // Web addresses a report by path segment; desktop uses a ?report= query
    // param. Both map to the same single Cost reports tab.
    case "cost-reports":
      return target.reportId
        ? {
            to: "/org/$orgId/cost-reports/$reportId",
            params: { orgId, reportId: target.reportId },
            ...(replace ? { replace: true } : {}),
          }
        : {
            to: "/org/$orgId/cost-reports",
            params: { orgId },
            ...(replace ? { replace: true } : {}),
          };
    // Same shape as Cost reports: web addresses one invoice by path segment,
    // desktop by ?invoice=. Both map to the single Invoices tab.
    case "invoices":
      return target.invoiceId
        ? {
            to: "/org/$orgId/invoices/$invoiceId",
            params: { orgId, invoiceId: target.invoiceId },
            ...(replace ? { replace: true } : {}),
          }
        : {
            to: "/org/$orgId/invoices",
            params: { orgId },
            ...(replace ? { replace: true } : {}),
          };
    case "graph":
      return {
        to: "/org/$orgId/graph",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "logs":
      return {
        to: "/org/$orgId/logs",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "changes":
      return {
        to: "/org/$orgId/changes",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "expiring":
      return {
        to: "/org/$orgId/expiring",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "posture":
      return {
        to: "/org/$orgId/posture",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "dns":
      return {
        to: "/org/$orgId/dns",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    // The two accounts ride as query parameters rather than path segments:
    // they are a pair of optional ids, not a hierarchy, and the panel is
    // reachable with neither of them chosen.
    case "environment-diff": {
      const search: Record<string, string> = {};
      if (target.a) search["a"] = target.a;
      if (target.b) search["b"] = target.b;
      return {
        to: "/org/$orgId/environment-diff",
        params: { orgId },
        ...(Object.keys(search).length > 0 ? { search } : {}),
        ...(replace ? { replace: true } : {}),
      };
    }
    case "ssh-fanout":
      return {
        to: "/org/$orgId/ssh-fanout",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "metric-alerts":
      return {
        to: "/org/$orgId/metric-alerts",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "probes":
      return {
        to: "/org/$orgId/probes",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "quotas":
      return {
        to: "/org/$orgId/quotas",
        params: { orgId },
        ...(replace ? { replace: true } : {}),
      };
    case "incidents":
      // The incident id is a path segment rather than a search param, so an
      // incident link reads as a place: /org/{org}/incidents/{id}.
      return target.incidentId
        ? {
            to: "/org/$orgId/incidents/$incidentId",
            params: { orgId, incidentId: target.incidentId },
            ...(replace ? { replace: true } : {}),
          }
        : {
            to: "/org/$orgId/incidents",
            params: { orgId },
            ...(replace ? { replace: true } : {}),
          };
    // The section is a static child route, not a path param, so the path is
    // built concretely rather than through `params`.
    case "settings":
      return {
        to: `/org/${orgId}/settings${target.section ? `/${target.section}` : ""}`,
        ...(replace ? { replace: true } : {}),
      };
    // Web addresses conversations by path segment; desktop uses a
    // ?conversation= query param. Both map to the same chat tab target.
    case "chat":
      return target.conversationId
        ? {
            to: "/org/$orgId/chat/$conversationId",
            params: { orgId, conversationId: target.conversationId },
            ...(replace ? { replace: true } : {}),
          }
        : {
            to: "/org/$orgId/chat",
            params: { orgId },
            ...(replace ? { replace: true } : {}),
          };
    case "resource": {
      const rid = normalizeResourceId(target.resourceId);
      const hash = target.view === "ssh" ? "ssh" : target.view === "sftp" ? "sftp" : undefined;
      if (target.pluginId && target.resourceTypeId) {
        const search: Record<string, string> = { accountId: target.accountId };
        if (target.parentResourceId) search["parent"] = target.parentResourceId;
        if (target.agentSessionId) search["agentSession"] = target.agentSessionId;
        if (target.sshKeyId) search["sshKeyId"] = target.sshKeyId;
        if (target.sshKeyName) search["sshKeyName"] = target.sshKeyName;
        return {
          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
          params: {
            orgId,
            pluginId: target.pluginId,
            resourceTypeId: target.resourceTypeId,
            resourceId: rid,
          },
          search,
          ...(hash ? { hash } : {}),
          ...(replace ? { replace: true } : {}),
        };
      }
      return {
        to: "/org/$orgId/accounts/$accountId",
        params: { orgId, accountId: target.accountId },
        ...(hash ? { hash } : {}),
        ...(replace ? { replace: true } : {}),
      };
    }
  }
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

/**
 * True when the Settings router subtree — not `WorkspaceTabsViewport` — is
 * rendering this tab's panel.
 *
 * Settings is the one workspace tab on web whose content is route-rendered:
 * `/org/$orgId/settings/*` draws the section nav and the section itself into
 * `__root`'s `<Outlet />`, a sibling of the viewport, so the viewport hides
 * every panel (`showActive === false`) while the Settings tab still reads as
 * selected in the strip. Left alone that means an `aria-selected` tab whose
 * `role="tabpanel"` is empty and `display: none` — present in the DOM but
 * absent from the accessibility tree, and unrelated to the settings UI the
 * user is actually looking at.
 *
 * So the settings layout route spreads `workspaceTabPanelProps` onto its own
 * container (making it the panel) and the viewport skips the tab. Both halves
 * are driven from this one predicate: the moment the URL leaves settings, the
 * layout route unmounts and the viewport must render the panel element again,
 * or the tab — still in the strip — controls nothing.
 *
 * Desktop needs no equivalent: its `/settings` route is a no-op stub and
 * `DesktopSettingsPanel` renders inside the viewport's panel like every other
 * tab kind.
 */
export function isRouteHostedTabPanel(
  routeTarget: WorkspaceTabTarget | null,
  tab: { target: WorkspaceTabTarget },
): boolean {
  return tab.target.kind === "settings" && routeTarget?.kind === "settings";
}

export function syncWorkspaceRouteFromPath(
  pathname: string,
  hash?: string,
  // Optional router search string (ParsedLocation.searchStr). The web app
  // runs on browser history, so window.location.search is a valid fallback
  // when the caller doesn't pass one (unlike desktop's hash history).
  search?: string,
): WorkspaceTabTarget | null {
  const normalizedHash = hash?.replace(/^#/, "");
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  // Strip /org/{orgId} prefix
  let offset = 0;
  if (segments[0] === "org" && segments[1]) {
    offset = 2;
  }

  const s = segments.slice(offset);

  if (s[0] === "workflows") {
    return workflowsTabTarget();
  }
  if (s[0] === "deployments") {
    // `?repo=owner/name` arrives from a /deploy/... hotlink.
    const params = new URLSearchParams(
      search ?? (typeof window === "undefined" ? "" : window.location.search),
    );
    return deploymentsTabTarget(params.get("repo") ?? undefined);
  }
  if (s[0] === "agents") {
    return agentsTabTarget();
  }
  // /savings was the standalone potential-savings page; it is now a section of
  // Costs. Old bookmarks and links keep working by landing on the tab that
  // carries the content.
  if (s[0] === "costs" || s[0] === "savings") {
    return costsTabTarget();
  }
  if (s[0] === "cost-reports") {
    // /cost-reports is the list; /cost-reports/{id} is one report. Both are the
    // same tab — the id is remembered state, not a second tab.
    return costReportsTabTarget(s[1] ? decodeURIComponent(s[1]) : undefined);
  }
  if (s[0] === "invoices") {
    // /invoices is the list; /invoices/{id} is one invoice. Both are the same
    // tab — the id is remembered state, not a second tab.
    return invoicesTabTarget(s[1] ? decodeURIComponent(s[1]) : undefined);
  }
  if (s[0] === "graph") {
    return graphTabTarget();
  }
  if (s[0] === "logs") {
    return logsTabTarget();
  }
  if (s[0] === "changes") {
    return changesTabTarget();
  }
  if (s[0] === "expiring") {
    return expiringTabTarget();
  }
  if (s[0] === "posture") {
    return postureTabTarget();
  }
  if (s[0] === "dns") {
    return dnsTabTarget();
  }
  if (s[0] === "environment-diff") {
    const params = new URLSearchParams(
      search ?? (typeof window === "undefined" ? "" : window.location.search),
    );
    return environmentDiffTabTarget(params.get("a") ?? undefined, params.get("b") ?? undefined);
  }
  if (s[0] === "ssh-fanout") {
    return sshFanoutTabTarget();
  }
  if (s[0] === "metric-alerts") {
    return metricAlertsTabTarget();
  }
  if (s[0] === "probes") {
    return probesTabTarget();
  }
  if (s[0] === "quotas") {
    return quotasTabTarget();
  }
  if (s[0] === "incidents") {
    return incidentsTabTarget(s[1] ? decodeURIComponent(s[1]) : undefined);
  }
  if (s[0] === "settings") {
    return settingsTabTarget(s.slice(1).join("/") || undefined);
  }
  if (s[0] === "chat") {
    // /chat is the conversation list; /chat/{id} is one conversation. Each
    // gets its own tab, same as desktop.
    return chatTabTarget(s[1] ? decodeURIComponent(s[1]) : undefined);
  }
  if (s[0] === "dashboard" && s[1]) {
    return dashboardTabTarget(s[1]);
  }
  if (s[0] === "accounts" && s[1]) {
    return accountTabTarget(s[1]);
  }
  if (s[0] === "resources" && s[1] && s[2] && s[3]) {
    const pluginId = decodeURIComponent(s[1]);
    const resourceTypeId = decodeURIComponent(s[2]);
    // Pass the raw path segment through — the shared target factories decode
    // it exactly once via normalizeResourceId (decoding here too would
    // double-decode IDs containing literal %-sequences).
    const resourceId = s[3];
    const params = new URLSearchParams(
      search ?? (typeof window === "undefined" ? "" : window.location.search),
    );
    const accountId =
      params.get("accountId") ?? normalizeResourceId(resourceId).split(":")[0] ?? "";
    const agentSessionId = params.get("agentSession") ?? undefined;
    const sshKeyId = params.get("sshKeyId") ?? undefined;
    const sshKeyName = params.get("sshKeyName") ?? undefined;
    if (normalizedHash === "ssh")
      return resourceSshTabTarget(accountId, resourceId, pluginId, resourceTypeId, {
        ...(agentSessionId ? { agentSessionId } : {}),
        ...(sshKeyId ? { sshKeyId } : {}),
        ...(sshKeyName ? { sshKeyName } : {}),
      });
    if (normalizedHash === "sftp")
      return resourceSftpTabTarget(accountId, resourceId, pluginId, resourceTypeId);
    return resourceTabTarget(accountId, resourceId, pluginId, resourceTypeId);
  }
  return null;
}

/**
 * Document title for *plain* routes — pages that render outside the
 * workspace-tab system, where `syncWorkspaceRouteFromPath` returns null and
 * the active tab's title would therefore go stale in the browser tab.
 * Labels match the sidebar tiles the pages are opened from. Returns null on
 * tab routes (the tab title applies) and on unknown paths.
 */
export function plainRouteDocumentTitle(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const s = segments[0] === "org" && segments[1] ? segments.slice(2) : segments;
  switch (s[0]) {
    case "moment":
      return "Moment";
    case "admin":
      return "Admin";
    default:
      return null;
  }
}
