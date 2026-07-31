import type { ResourceChangeEntry } from "@infrawrench/client-core";

/**
 * The change-timeline contract lives in client-core so mobile (which doesn't
 * depend on this package) shares one definition; re-exported for web and
 * desktop the same way the orphan-finder types are.
 */
export type {
  ResourceChangeEntry,
  ResourceChangeKind,
  ResourceFieldChange,
} from "@infrawrench/client-core";

/** Filters the org feed accepts — one per query parameter the endpoint has. */
export interface ChangeFeedQuery {
  page: number;
  pageSize: number;
  /** Restrict to one account; omitted means every account in the org. */
  accountId?: string | undefined;
  /** Restrict to one of created/updated/deleted. */
  kind?: string | undefined;
}

export interface ChangeFeedPage {
  entries: ResourceChangeEntry[];
  /** Row count matching the filter, for paging — not the page's length. */
  total: number;
}

/** One account as the feed's filter dropdown needs it. */
export interface ChangeFeedAccount {
  id: string;
  displayName: string;
}

/**
 * Host-injected data access for the change feed. Web wraps `apiGet`; desktop
 * (cloud mode) wraps its cloud IPC — the panel stays platform-agnostic, the
 * same arrangement as `OrphansClient` and `CostsClient`.
 */
export interface ChangesClient {
  listChanges(query: ChangeFeedQuery): Promise<ChangeFeedPage>;
  /** Populates the account filter. A failure leaves the filter empty, never blocks the feed. */
  listAccounts(): Promise<ChangeFeedAccount[]>;
}
