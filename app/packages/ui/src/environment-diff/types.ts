import type { EnvironmentDiffResponse } from "@infrawrench/client-core";

/**
 * The environment diff contract lives in client-core so the CLI and any
 * future host share one definition; re-exported here because web and desktop
 * import shared pieces from this package.
 */
export type {
  EnvironmentDiffEntry,
  EnvironmentDiffFieldChange,
  EnvironmentDiffResourceRef,
  EnvironmentDiffResponse,
  EnvironmentDiffSideSummary,
  EnvironmentDiffStatus,
  EnvironmentDiffTotals,
  EnvironmentDiffTypeSummary,
  EnvironmentDiffUnavailableType,
} from "@infrawrench/client-core";

/**
 * A resource the panel can link through to. The wire shape carries only what
 * identifies the resource within its account; the plugin and type come from
 * the diff around it, and the host needs all four to open a resource tab.
 */
export interface EnvironmentDiffResourceTarget {
  resourceId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  pluginId: string;
  resourceTypeId: string;
}

/** One account as the environment pickers need it. */
export interface EnvironmentDiffAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

export interface EnvironmentDiffQuery {
  a: string;
  b: string;
  /** Compare the identity/timestamp fields the diff normally filters out. */
  includeIdentityFields: boolean;
}

/**
 * Host-injected data access. Web wraps `apiGet`; desktop wraps its cloud IPC
 * in cloud mode and the local SQLite scan otherwise — the panel stays
 * platform-agnostic, the same arrangement as `ChangesClient` and
 * `OrphansClient`.
 */
export interface EnvironmentDiffClient {
  /** Populates the two environment pickers. */
  listAccounts(): Promise<EnvironmentDiffAccount[]>;
  compare(query: EnvironmentDiffQuery): Promise<EnvironmentDiffResponse>;
}
