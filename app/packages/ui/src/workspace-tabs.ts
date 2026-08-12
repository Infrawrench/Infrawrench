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

export function logsTabTarget(): WorkspaceTabTarget {
  return { kind: "logs" };
}

export function changesTabTarget(): WorkspaceTabTarget {
  return { kind: "changes" };
}

export function expiringTabTarget(): WorkspaceTabTarget {
  return { kind: "expiring" };
}

export function postureTabTarget(): WorkspaceTabTarget {
  return { kind: "posture" };
}

/**
 * The cross-cloud access review — the principals inside the customer's clouds.
 * A single-instance tab like Posture: the staleness window is a control on the
 * page, not part of the tab's identity.
 */
export function accessReviewTabTarget(): WorkspaceTabTarget {
  return { kind: "access-review" };
}

/** Backup & restore coverage — "what is your actual RPO?". */
export function backupsTabTarget(): WorkspaceTabTarget {
  return { kind: "backups" };
}

export function dnsTabTarget(): WorkspaceTabTarget {
  return { kind: "dns" };
}

/** Infrastructure as Code — the IaC reconciliation page (the ClickOps detector). */
export function iacTabTarget(): WorkspaceTabTarget {
  return { kind: "iac" };
}

/**
 * Environment diff. The two account ids are optional: opened from the sidebar
 * the panel asks which environments to compare, and opening it again with a
 * pair retargets the same tab.
 */
export function environmentDiffTabTarget(a?: string, b?: string): WorkspaceTabTarget {
  return { kind: "environment-diff", ...(a ? { a } : {}), ...(b ? { b } : {}) };
}

export function sshFanoutTabTarget(): WorkspaceTabTarget {
  return { kind: "ssh-fanout" };
}

export function metricAlertsTabTarget(): WorkspaceTabTarget {
  return { kind: "metric-alerts" };
}

export function probesTabTarget(): WorkspaceTabTarget {
  return { kind: "probes" };
}

export function quotasTabTarget(): WorkspaceTabTarget {
  return { kind: "quotas" };
}

/**
 * Incident mode. One tab, optionally remembering which incident it was on —
 * during an incident people flip between the timeline and everything else, and
 * a tab per incident would bury the tab strip exactly when it is least
 * convenient to tidy.
 */
export function incidentsTabTarget(incidentId?: string): WorkspaceTabTarget {
  return { kind: "incidents", ...(incidentId ? { incidentId } : {}) };
}

export function deploymentsTabTarget(repo?: string): WorkspaceTabTarget {
  return { kind: "deployments", ...(repo ? { repo } : {}) };
}

export function agentsTabTarget(): WorkspaceTabTarget {
  return { kind: "agents" };
}

export function settingsTabTarget(section?: string): WorkspaceTabTarget {
  return { kind: "settings", ...(section ? { section } : {}) };
}

export function costsTabTarget(): WorkspaceTabTarget {
  return { kind: "costs" };
}

/**
 * The Cost reports page. With a `reportId` it opens that report's detail view;
 * without one it opens the list. One tab either way — the id is remembered
 * state, not a second tab (see `getWorkspaceTabId`).
 */
export function costReportsTabTarget(reportId?: string): WorkspaceTabTarget {
  return { kind: "cost-reports", ...(reportId ? { reportId } : {}) };
}

/**
 * The Invoices page — managed accounts and the invoices raised against them.
 * With an `invoiceId` it opens that invoice; without one it opens the list.
 * One tab either way, like Cost reports.
 */
export function invoicesTabTarget(invoiceId?: string): WorkspaceTabTarget {
  return { kind: "invoices", ...(invoiceId ? { invoiceId } : {}) };
}

export function graphTabTarget(): WorkspaceTabTarget {
  return { kind: "graph" };
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
