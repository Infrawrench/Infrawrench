import { normalizeResourceId, useUIStore, type WorkspaceTabTarget } from "@infrawrench/ui";

export interface RouteNavigator {
  (options: { to: string; params?: Record<string, string>; replace?: boolean; hash?: string }): Promise<void> | void;
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
  replace?: boolean;
  hash?: string;
} {
  switch (target.kind) {
    case "dashboard":
      return { to: "/dashboard/$dashboardId", params: { dashboardId: target.dashboardId }, ...(replace ? { replace: true } : {}) };
    case "account":
      return { to: "/accounts/$accountId", params: { accountId: target.accountId }, ...(replace ? { replace: true } : {}) };
    case "resource":
      return {
        to: "/resource/$accountId/$resourceId",
        params: { accountId: target.accountId, resourceId: encodeURIComponent(normalizeResourceId(target.resourceId)) },
        ...(target.view === "ssh" ? { hash: "ssh" } : target.view === "sftp" ? { hash: "sftp" } : {}),
        ...(replace ? { replace: true } : {}),
      };
  }
  throw new Error(`Unsupported workspace tab target: ${JSON.stringify(target)}`);
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
  if (pathname === "/") return null;
  const normalizedHash = hash?.replace(/^#/, "");
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "dashboard" && segments[1]) {
    return dashboardTabTarget(segments[1]);
  }
  if (segments[0] === "accounts" && segments[1]) {
    return accountTabTarget(segments[1]);
  }
  if (segments[0] === "resource" && segments[1] && segments[2]) {
    if (normalizedHash === "ssh") return resourceSshTabTarget(segments[1], segments.slice(2).join("/"));
    if (normalizedHash === "sftp") return resourceSftpTabTarget(segments[1], segments.slice(2).join("/"));
    return resourceTabTarget(segments[1], segments.slice(2).join("/"));
  }
  return null;
}
