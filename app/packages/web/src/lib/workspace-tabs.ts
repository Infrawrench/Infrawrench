import { normalizeResourceId, useUIStore, type WorkspaceTabTarget } from "@infrawrench/ui";

export interface RouteNavigator {
  (options: { to: string; params?: Record<string, string>; search?: Record<string, string>; replace?: boolean; hash?: string }): Promise<void> | void;
}

export function dashboardTabTarget(dashboardId: string): WorkspaceTabTarget {
  return { kind: "dashboard", dashboardId };
}

export function accountTabTarget(accountId: string): WorkspaceTabTarget {
  return { kind: "account", accountId };
}

export function resourceTabTarget(accountId: string, resourceId: string, pluginId?: string, resourceTypeId?: string): WorkspaceTabTarget {
  return { kind: "resource", accountId, resourceId: normalizeResourceId(resourceId), view: "details", ...(pluginId ? { pluginId } : {}), ...(resourceTypeId ? { resourceTypeId } : {}) };
}

export function resourceSshTabTarget(accountId: string, resourceId: string, pluginId?: string, resourceTypeId?: string): WorkspaceTabTarget {
  return { kind: "resource", accountId, resourceId: normalizeResourceId(resourceId), view: "ssh", ...(pluginId ? { pluginId } : {}), ...(resourceTypeId ? { resourceTypeId } : {}) };
}

export function resourceSftpTabTarget(accountId: string, resourceId: string, pluginId?: string, resourceTypeId?: string): WorkspaceTabTarget {
  return { kind: "resource", accountId, resourceId: normalizeResourceId(resourceId), view: "sftp", ...(pluginId ? { pluginId } : {}), ...(resourceTypeId ? { resourceTypeId } : {}) };
}

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
      // If we have pluginId + resourceTypeId, navigate to the resource detail route
      if (target.pluginId && target.resourceTypeId) {
        return {
          to: "/resources/$pluginId/$resourceTypeId/$resourceId",
          params: { pluginId: target.pluginId, resourceTypeId: target.resourceTypeId, resourceId: rid },
          search: { accountId: target.accountId },
          ...(hash ? { hash } : {}),
          ...(replace ? { replace: true } : {}),
        };
      }
      // Fallback: navigate to account page
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

  // "/" — default dashboard (handled separately by the caller which fetches the real ID)
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
