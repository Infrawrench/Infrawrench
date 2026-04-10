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

export function getWorkspaceNavigateArgs(target: WorkspaceTabTarget, replace = false): {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  replace?: boolean;
  hash?: string;
} {
  switch (target.kind) {
    case "dashboard":
      return { to: "/dashboard/$dashboardId", params: { dashboardId: target.dashboardId }, ...(replace ? { replace: true } : {}) };
    case "account":
      return { to: "/accounts/$accountId", params: { accountId: target.accountId }, ...(replace ? { replace: true } : {}) };
    case "resource": {
      const rid = normalizeResourceId(target.resourceId);
      const hash = target.view === "ssh" ? "ssh" : target.view === "sftp" ? "sftp" : undefined;
      if (target.pluginId && target.resourceTypeId) {
        return {
          to: "/resources/$pluginId/$resourceTypeId/$resourceId",
          params: { pluginId: target.pluginId, resourceTypeId: target.resourceTypeId, resourceId: rid },
          search: { accountId: target.accountId },
          ...(hash ? { hash } : {}),
          ...(replace ? { replace: true } : {}),
        };
      }
      return {
        to: "/accounts/$accountId",
        params: { accountId: target.accountId },
        ...(hash ? { hash } : {}),
        ...(replace ? { replace: true } : {}),
      };
    }
  }
}

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

  if (segments[0] === "dashboard" && segments[1]) {
    return dashboardTabTarget(segments[1]);
  }
  if (segments[0] === "accounts" && segments[1]) {
    return accountTabTarget(segments[1]);
  }
  if (segments[0] === "resources" && segments[1] && segments[2] && segments[3]) {
    const pluginId = decodeURIComponent(segments[1]);
    const resourceTypeId = decodeURIComponent(segments[2]);
    const resourceId = decodeURIComponent(segments[3]);
    const params = new URLSearchParams(window.location.search);
    const accountId = params.get("accountId") ?? resourceId.split(":")[0] ?? "";
    if (normalizedHash === "ssh") return resourceSshTabTarget(accountId, resourceId, pluginId, resourceTypeId);
    if (normalizedHash === "sftp") return resourceSftpTabTarget(accountId, resourceId, pluginId, resourceTypeId);
    return resourceTabTarget(accountId, resourceId, pluginId, resourceTypeId);
  }
  return null;
}
