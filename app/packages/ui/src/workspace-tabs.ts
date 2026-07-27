/**
 * Shared workspace tab target factory functions.
 * These create WorkspaceTabTarget objects used by both desktop and web apps.
 * The routing logic (getWorkspaceNavigateArgs) remains platform-specific
 * because desktop and web use different URL structures.
 */

import { normalizeResourceId, useUIStore, type WorkspaceTabTarget } from "./store/ui.store.js";

export interface RouteNavigator {
  (options: {
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
    replace?: boolean;
    hash?: string;
  }): Promise<void> | void;
}

export function dashboardTabTarget(dashboardId: string): WorkspaceTabTarget {
  return { kind: "dashboard", dashboardId };
}

export function accountTabTarget(accountId: string): WorkspaceTabTarget {
  return { kind: "account", accountId };
}

export function workflowsTabTarget(workflowId?: string): WorkspaceTabTarget {
  return { kind: "workflows", ...(workflowId ? { workflowId } : {}) };
}

export function agentsTabTarget(): WorkspaceTabTarget {
  return { kind: "agents" };
}

export function costsTabTarget(): WorkspaceTabTarget {
  return { kind: "costs" };
}

export function chatTabTarget(conversationId?: string): WorkspaceTabTarget {
  return { kind: "chat", ...(conversationId ? { conversationId } : {}) };
}

export function resourceTabTarget(
  accountId: string,
  resourceId: string,
  pluginId?: string,
  resourceTypeId?: string,
  parentResourceId?: string,
): WorkspaceTabTarget {
  return {
    kind: "resource",
    accountId,
    resourceId: normalizeResourceId(resourceId),
    view: "details",
    ...(pluginId ? { pluginId } : {}),
    ...(resourceTypeId ? { resourceTypeId } : {}),
    ...(parentResourceId ? { parentResourceId } : {}),
  };
}

export function resourceSshTabTarget(
  accountId: string,
  resourceId: string,
  pluginId?: string,
  resourceTypeId?: string,
  options?: {
    agentSessionId?: string;
    sshKeyId?: string;
    sshKeyName?: string;
    initialCommand?: string;
    initialCwd?: string;
  },
): WorkspaceTabTarget {
  return {
    kind: "resource",
    accountId,
    resourceId: normalizeResourceId(resourceId),
    view: "ssh",
    ...(pluginId ? { pluginId } : {}),
    ...(resourceTypeId ? { resourceTypeId } : {}),
    ...(options?.agentSessionId ? { agentSessionId: options.agentSessionId } : {}),
    ...(options?.sshKeyId ? { sshKeyId: options.sshKeyId } : {}),
    ...(options?.sshKeyName ? { sshKeyName: options.sshKeyName } : {}),
    ...(options?.initialCommand ? { initialCommand: options.initialCommand } : {}),
    ...(options?.initialCwd ? { initialCwd: options.initialCwd } : {}),
  };
}

export function resourceSftpTabTarget(
  accountId: string,
  resourceId: string,
  pluginId?: string,
  resourceTypeId?: string,
): WorkspaceTabTarget {
  return {
    kind: "resource",
    accountId,
    resourceId: normalizeResourceId(resourceId),
    view: "sftp",
    ...(pluginId ? { pluginId } : {}),
    ...(resourceTypeId ? { resourceTypeId } : {}),
  };
}

/**
 * Navigate to a workspace target, updating the store and routing.
 * Platform-specific `getNavigateArgs` must be curried in by each platform.
 * Note: each platform re-implements this thin wrapper to enable test mocking
 * of useUIStore at the import boundary.
 */
export function navigateToWorkspaceTarget(
  navigate: RouteNavigator,
  target: WorkspaceTabTarget,
  getNavigateArgs: (target: WorkspaceTabTarget, replace?: boolean) => Parameters<RouteNavigator>[0],
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
  return navigate(getNavigateArgs(target, options?.replace));
}
