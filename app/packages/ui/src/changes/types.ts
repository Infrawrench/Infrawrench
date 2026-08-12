import type {
  ChangeCostImpactEntry,
  ResourceChangeEntry,
  RevertApplyResponse,
  RevertPreviewResponse,
} from "@infrawrench/client-core";

/**
 * The change-timeline contract lives in client-core so mobile (which doesn't
 * depend on this package) shares one definition; re-exported for web and
 * desktop the same way the orphan-finder types are.
 */
export type {
  ResourceChangeEntry,
  ResourceChangeKind,
  ResourceFieldChange,
  RevertPlan,
  RevertFieldPlan,
  RevertFieldStatus,
  RevertPreviewResponse,
  RevertApplyResponse,
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
  /**
   * Cost impact for the rows currently on screen — "what did this change do to
   * the run rate?". **Optional**: a host that has not wired it (or a build a
   * release ahead of its server) renders the feed with no cost column rather
   * than failing, the same rule the anomaly-settings editor follows.
   *
   * Batched deliberately: one request per page, not one per row.
   */
  costImpacts?(changeIds: string[]): Promise<ChangeCostImpactEntry[]>;
  /**
   * Pin one change's cost impact onto the cost charts as an annotation.
   * Optional for the same reason, and separately from `costImpacts` because
   * reading spend is `costs:read` and writing a note is `costs:write`.
   */
  annotateCostImpact?(changeId: string): Promise<void>;
  /**
   * Time-travel undo. Optional the same way `MetricAlertsPanel`'s write methods
   * are: a host that hasn't wired the revert endpoints simply renders no Revert
   * button, and the server enforces `resources:write` regardless.
   */
  revert?: ChangeRevertClient | undefined;
}

/**
 * The two halves of a revert — dry run, then apply. Kept as its own interface
 * because the per-resource Changes tab needs it without the feed's paging and
 * account lookup.
 */
export interface ChangeRevertClient {
  /** `GET /changes/{changeId}/revert` — the plan, computed against live fields. */
  preview(changeId: string): Promise<RevertPreviewResponse>;
  /** `POST /changes/{changeId}/revert` — apply it. */
  apply(changeId: string): Promise<RevertApplyResponse>;
}
