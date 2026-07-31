/**
 * Change-timeline contract + pure formatting helpers, shared by every host
 * that renders the drift feed (web today; desktop/mobile follow-ups). Lives
 * here rather than in `@infrawrench/ui` per the client-core rule: anything
 * more than one surface must agree on that isn't a React component.
 */

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
