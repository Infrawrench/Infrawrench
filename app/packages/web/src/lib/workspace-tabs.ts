import {
  normalizeResourceId,
  useUIStore,
  dashboardTabTarget,
  accountTabTarget,
  resourceTabTarget,
  resourceSshTabTarget,
  resourceSftpTabTarget,
  type WorkspaceTabTarget,
  type RouteNavigator,
} from "@infrawrench/ui";

// Re-export shared target factories
export { dashboardTabTarget, accountTabTarget, resourceTabTarget, resourceSshTabTarget, resourceSftpTabTarget };

function getCurrentOrgId(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.pathname.match(/^\/org\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

export function getWorkspaceNavigateArgs(target: WorkspaceTabTarget, replace = false): {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  replace?: boolean;
  hash?: string;
} {
  const orgId = getCurrentOrgId();
  switch (target.kind) {
    case "dashboard":
      return { to: "/org/$orgId/dashboard/$dashboardId", params: { orgId, dashboardId: target.dashboardId }, ...(replace ? { replace: true } : {}) };
    case "account":
      return { to: "/org/$orgId/accounts/$accountId", params: { orgId, accountId: target.accountId }, ...(replace ? { replace: true } : {}) };
    case "resource": {
      const rid = normalizeResourceId(target.resourceId);
      const hash = target.view === "ssh" ? "ssh" : target.view === "sftp" ? "sftp" : undefined;
      if (target.pluginId && target.resourceTypeId) {
        return {
          to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
          params: { orgId, pluginId: target.pluginId, resourceTypeId: target.resourceTypeId, resourceId: rid },
          search: { accountId: target.accountId },
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

export function syncWorkspaceRouteFromPath(pathname: string, hash?: string): WorkspaceTabTarget | null {
  const normalizedHash = hash?.replace(/^#/, "");
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) return null;

  // Strip /org/{orgId} prefix
  let offset = 0;
  if (segments[0] === "org" && segments[1]) {
    offset = 2;
  }

  const s = segments.slice(offset);

  if (s[0] === "dashboard" && s[1]) {
    return dashboardTabTarget(s[1]);
  }
  if (s[0] === "accounts" && s[1]) {
    return accountTabTarget(s[1]);
  }
  if (s[0] === "resources" && s[1] && s[2] && s[3]) {
    const pluginId = decodeURIComponent(s[1]);
    const resourceTypeId = decodeURIComponent(s[2]);
    const resourceId = decodeURIComponent(s[3]);
    const params = new URLSearchParams(window.location.search);
    const accountId = params.get("accountId") ?? resourceId.split(":")[0] ?? "";
    if (normalizedHash === "ssh") return resourceSshTabTarget(accountId, resourceId, pluginId, resourceTypeId);
    if (normalizedHash === "sftp") return resourceSftpTabTarget(accountId, resourceId, pluginId, resourceTypeId);
    return resourceTabTarget(accountId, resourceId, pluginId, resourceTypeId);
  }
  return null;
}
