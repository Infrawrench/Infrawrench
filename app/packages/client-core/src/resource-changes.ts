/**
 * Change-timeline contract + pure formatting helpers, shared by every host
 * that renders the drift feed (web, desktop and mobile). Lives here rather
 * than in `@infrawrench/ui` per the client-core rule: anything more than one
 * surface must agree on that isn't a React component.
 *
 * The Bearer readers at the bottom (`fetchOrgChanges`, `fetchResourceChanges`)
 * are for hosts that talk to the cloud API directly — mobile today. Web and
 * desktop inject their own transport into `ChangesPanel` instead (`apiGet` and
 * a cloud IPC channel respectively), which is why `@infrawrench/ui` keeps its
 * own narrower `ChangeFeedQuery`/`ChangesClient` pair; these are the same
 * endpoints reached the other way.
 */

import type { CloudFetch } from "./fetch";

export type ResourceChangeKind = "created" | "updated" | "deleted";

export interface ResourceFieldChange {
  /** Top-level field key. Resolved-output keys are prefixed `outputs.`. */
  field: string;
  from: unknown;
  to: unknown;
}

/** One event as returned by `GET /api/org/{orgId}/changes[/resource]`. */
export interface ResourceChangeEntry {
  id: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /** Display name at the time of the change — survives deletion. */
  displayName: string;
  changeKind: ResourceChangeKind;
  /** Changed fields for "updated" events; empty for created/deleted. */
  diff: ResourceFieldChange[];
  createdAt: string;
  /** Present on org-feed entries (joined server-side); absent per-resource. */
  accountName?: string | null;
}

export const CHANGE_KIND_LABELS: Record<ResourceChangeKind, string> = {
  created: "Appeared",
  updated: "Changed",
  deleted: "Disappeared",
};

const MAX_VALUE_LENGTH = 120;

/**
 * Render a diff value for a feed row. Objects/arrays JSON-stringify; null and
 * absent values render as an em dash so "field was added" reads naturally.
 */
export function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  let text: string;
  if (typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  if (text.length > MAX_VALUE_LENGTH) return `${text.slice(0, MAX_VALUE_LENGTH - 1)}…`;
  return text;
}

/**
 * One-line summary for a feed row: the change kind for created/deleted, or
 * the changed field names (capped) for updates.
 */
export function summarizeChange(entry: Pick<ResourceChangeEntry, "changeKind" | "diff">): string {
  if (entry.changeKind !== "updated" || entry.diff.length === 0) {
    return CHANGE_KIND_LABELS[entry.changeKind];
  }
  const names = entry.diff.map((d) => d.field);
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const base = shown.join(", ");
  return rest > 0 ? `${base} and ${rest} more` : base;
}

/* ------------------------------------------------------------------ *
 * Reading the feed (Bearer hosts)
 * ------------------------------------------------------------------ */

/**
 * Every filter `GET /api/org/{orgId}/changes` reads — one field per query
 * parameter in web's `api/routes/resource-changes.ts`. All optional: the bare
 * request is page 1 of the whole org's feed, newest first.
 */
export interface ChangeFeedRequest {
  /** 1-based. Below 1 the server clamps to 1. */
  page?: number | undefined;
  /** Server default 50, hard ceiling 200. */
  pageSize?: number | undefined;
  kind?: ResourceChangeKind | undefined;
  accountId?: string | undefined;
  /** Narrow the org feed to one resource's rows. */
  resourceId?: string | undefined;
  /**
   * ISO timestamp — the server compares `createdAt >= from`, so a change
   * recorded exactly on the boundary is included.
   */
  from?: string | undefined;
  /** ISO timestamp — `createdAt <= to`. */
  to?: string | undefined;
}

/** One page of the org feed. `total` is the filter's row count, not the page's. */
export interface ChangeFeedResult {
  entries: ResourceChangeEntry[];
  total: number;
}

/**
 * Query string for a feed request, without the leading `?`.
 *
 * Empty and non-finite values are dropped rather than sent: the route parses
 * `page`/`pageSize` with `parseInt` and feeds `from`/`to` straight into
 * `new Date(...)`, so an empty string or a NaN would either be silently
 * clamped or turn the whole `where` clause into a comparison against an
 * Invalid Date. Filtering here keeps a half-filled filter UI honest.
 */
export function changeFeedSearchParams(request: ChangeFeedRequest): string {
  const params = new URLSearchParams();
  const num = (key: string, value: number | undefined) => {
    if (typeof value === "number" && Number.isFinite(value)) params.set(key, String(value));
  };
  const date = (key: string, value: string | undefined) => {
    if (value && !Number.isNaN(Date.parse(value))) params.set(key, value);
  };
  num("page", request.page);
  num("pageSize", request.pageSize);
  if (request.kind) params.set("kind", request.kind);
  if (request.accountId) params.set("accountId", request.accountId);
  if (request.resourceId) params.set("resourceId", request.resourceId);
  date("from", request.from);
  date("to", request.to);
  return params.toString();
}

/** One page of the org-wide change feed. */
export async function fetchOrgChanges(
  api: CloudFetch,
  orgId: string,
  request: ChangeFeedRequest = {},
): Promise<ChangeFeedResult> {
  const query = changeFeedSearchParams(request);
  const result = await api.org<ChangeFeedResult>(orgId, query ? `/changes?${query}` : "/changes");
  return result ?? { entries: [], total: 0 };
}

/**
 * One resource's slice of the timeline —
 * `GET /api/org/{orgId}/changes/resource?resourceId=…`. The id rides in a
 * query parameter because composite resource ids contain slashes and colons
 * that don't survive as a path segment. Unpaginated; `limit` caps at 200.
 */
export async function fetchResourceChanges(
  api: CloudFetch,
  orgId: string,
  resourceId: string,
  limit?: number,
): Promise<ResourceChangeEntry[]> {
  const params = new URLSearchParams({ resourceId });
  if (typeof limit === "number" && Number.isFinite(limit)) params.set("limit", String(limit));
  const result = await api.org<{ entries: ResourceChangeEntry[] }>(
    orgId,
    `/changes/resource?${params.toString()}`,
  );
  return result?.entries ?? [];
}

/* ------------------------------------------------------------------ *
 * Drift alert settings
 * ------------------------------------------------------------------ */

/**
 * Per-org filtering and throttling for resource-drift notifications. Server
 * contract: `GET|PUT /api/org/:orgId/changes/alert-settings` (web
 * `api/routes/resource-changes.ts`), backed by `org_drift_alert_settings`.
 *
 * The trigger itself is opted into per channel and per device (the
 * `resourceDrift` flag on Slack channels, Teams webhooks and push
 * preferences); this is the filter that decides what counts as drift worth
 * notifying about at all, and how often.
 */
export interface DriftAlertSettings {
  /** Alert on resources that appeared. */
  notifyCreated: boolean;
  /** Alert on field-level updates. Off by default — the noisy kind. */
  notifyUpdated: boolean;
  /** Alert on resources that disappeared. */
  notifyDeleted: boolean;
  /** Least time between drift notifications for this org. */
  cooldownMinutes: number;
  /** Fewest matching changes in a window worth notifying about. */
  minChanges: number;
  /** Account ids to alert on; empty means every account. */
  accountIds: string[];
  /** When this org last had a drift digest delivered; null if never. */
  lastNotifiedAt: string | null;
}

export type DriftAlertSettingsPatch = Partial<Omit<DriftAlertSettings, "lastNotifiedAt">>;

/** Bounds the API enforces. Mirrors server-core `drift/settings.ts`. */
export const DRIFT_ALERT_LIMITS = {
  cooldownMinutes: { min: 5, max: 24 * 60 },
  minChanges: { min: 1, max: 1000 },
  maxAccountIds: 200,
} as const;

export const DEFAULT_DRIFT_ALERT_SETTINGS: DriftAlertSettings = {
  notifyCreated: true,
  notifyUpdated: false,
  notifyDeleted: true,
  cooldownMinutes: 60,
  minChanges: 1,
  accountIds: [],
  lastNotifiedAt: null,
};
