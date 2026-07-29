import {
  normalizeResourceId,
  useUIStore,
  dashboardTabTarget,
  accountTabTarget,
  agentsTabTarget,
  costsTabTarget,
  chatTabTarget,
  workflowsTabTarget,
  deploymentsTabTarget,
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
  chatTabTarget,
  workflowsTabTarget,
  deploymentsTabTarget,
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
      return { to: "/workflows", ...(replace ? { replace: true } : {}) };
    case "deployments":
      return {
        to: "/deployments",
        ...(target.repo ? { search: { repo: target.repo } } : {}),
        ...(replace ? { replace: true } : {}),
      };
    case "costs":
      return { to: "/costs", ...(replace ? { replace: true } : {}) };
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
    return workflowsTabTarget();
  }
  if (segments[0] === "deployments") {
    const params = new URLSearchParams(search ?? "");
    return deploymentsTabTarget(params.get("repo") ?? undefined);
  }
  if (segments[0] === "agents") {
    return agentsTabTarget();
  }
  if (segments[0] === "costs") {
    return costsTabTarget();
  }
  if (segments[0] === "chat") {
    const params = new URLSearchParams(search ?? "");
    return chatTabTarget(params.get("conversation") ?? undefined);
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
