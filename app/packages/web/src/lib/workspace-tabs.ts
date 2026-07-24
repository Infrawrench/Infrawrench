import {
  normalizeResourceId,
  useUIStore,
  dashboardTabTarget,
  accountTabTarget,
  agentsTabTarget,
  workflowsTabTarget,
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
    // Chat is not a workspace tab on web — it routes like a normal page — but
    // the shared target union includes it (desktop renders chat as a tab).
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
  if (s[0] === "agents") {
    return agentsTabTarget();
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
