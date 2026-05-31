import {
  normalizeResourceId,
  useUIStore,
  dashboardTabTarget,
  accountTabTarget,
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
  workflowsTabTarget,
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
    case "workflows":
      return { to: "/workflows", ...(replace ? { replace: true } : {}) };
    case "resource": {
      const search: Record<string, string> = {};
      if (target.pluginId) search["plugin"] = target.pluginId;
      if (target.resourceTypeId) search["type"] = target.resourceTypeId;
      if (target.parentResourceId) search["parent"] = target.parentResourceId;
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
): WorkspaceTabTarget | null {
  if (pathname === "/") return null;
  const normalizedHash = hash?.replace(/^#/, "");
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "workflows") {
    return workflowsTabTarget();
  }
  if (segments[0] === "dashboard" && segments[1]) {
    return dashboardTabTarget(segments[1]);
  }
  if (segments[0] === "accounts" && segments[1]) {
    return accountTabTarget(segments[1]);
  }
  if (segments[0] === "resource" && segments[1] && segments[2]) {
    if (normalizedHash === "ssh")
      return resourceSshTabTarget(segments[1], segments.slice(2).join("/"));
    if (normalizedHash === "sftp")
      return resourceSftpTabTarget(segments[1], segments.slice(2).join("/"));
    return resourceTabTarget(segments[1], segments.slice(2).join("/"));
  }
  return null;
}
