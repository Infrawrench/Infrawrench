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

export function resourceTabTarget(accountId: string, resourceId: string): WorkspaceTabTarget {
  return { kind: "resource", accountId, resourceId: normalizeResourceId(resourceId), view: "details" };
}

export function resourceSshTabTarget(accountId: string, resourceId: string): WorkspaceTabTarget {
  return { kind: "resource", accountId, resourceId: normalizeResourceId(resourceId), view: "ssh" };
}

export function resourceSftpTabTarget(accountId: string, resourceId: string): WorkspaceTabTarget {
  return { kind: "resource", accountId, resourceId: normalizeResourceId(resourceId), view: "sftp" };
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
      return {
        to: "/accounts/$accountId",
        params: { accountId: target.accountId },
        ...(target.view === "ssh" ? { hash: "ssh" } : target.view === "sftp" ? { hash: "sftp" } : {}),
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
    const resourceId = decodeURIComponent(segments[3]);
    const params = new URLSearchParams(window.location.search);
    const accountId = params.get("accountId") ?? resourceId.split(":")[0] ?? "";
    if (normalizedHash === "ssh") return resourceSshTabTarget(accountId, resourceId);
    if (normalizedHash === "sftp") return resourceSftpTabTarget(accountId, resourceId);
    return resourceTabTarget(accountId, resourceId);
  }
  return null;
}
