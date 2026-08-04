/**
 * Expiry radar — one cross-provider countdown of everything with a clock on
 * it: TLS certs, domain registrations, API tokens, access-key age, K8s certs,
 * SSH keys, secret versions.
 *
 * The classification is declarative: plugins mark fields their listers
 * already sync with `expiryFields` on the resource type definition
 * (`ExpiryFieldRule` in `@infrawrench/plugin-base`), and this module is the
 * shared pure half that turns stored rows + those declarations into the feed
 * every surface renders — the web/desktop/mobile screens, the
 * `infrawrench expiring` CLI, the `list_expiring` MCP tool and the poller's
 * expiry alerts. Rows in, items out: no plugin client, no credentials, no
 * provider API calls, ever — exactly the `orphanRule` contract.
 *
 * The plugin-base import is type-only on purpose: this module must stay free
 * of a *runtime* dependency on plugin-base so the mobile bundle doesn't pull
 * in zod for the sake of two interfaces.
 */
import type { ExpiryFieldRule, ExpiryKind } from "@infrawrench/plugin-base";

import type { CloudFetch } from "./fetch";

export type { ExpiryFieldRule, ExpiryKind } from "@infrawrench/plugin-base";

/**
 * How close the deadline is:
 * - `"expired"` — the date is in the past.
 * - `"critical"` — due within 7 days.
 * - `"warning"` — due within 30 days.
 * - `"upcoming"` — due within the org's lead time.
 * - `"ok"` — tracked, but further out than the lead time.
 */
export type ExpirySeverity = "expired" | "critical" | "warning" | "upcoming" | "ok";

/** Severities in escalation order, most urgent first. */
export const EXPIRY_SEVERITIES: readonly ExpirySeverity[] = [
  "expired",
  "critical",
  "warning",
  "upcoming",
  "ok",
];

/** Days before the deadline at which an item turns `critical`. */
export const EXPIRY_CRITICAL_DAYS = 7;
/** Days before the deadline at which an item turns `warning`. */
export const EXPIRY_WARNING_DAYS = 30;
/** Default org lead time when `org_expiry_settings` has no row. */
export const DEFAULT_EXPIRY_LEAD_DAYS = 60;

/**
 * Default age budgets for `from: "created"` rules, per kind, in days. A rule
 * may override with `maxAgeDays`; kinds that only ever appear as absolute
 * expiries still get an entry so a declaration is never silently dropped.
 */
export const DEFAULT_MAX_AGE_DAYS: Record<ExpiryKind, number> = {
  "access-key": 90,
  "api-token": 90,
  "secret-version": 90,
  "ssh-key": 365,
  "k8s-cert": 365,
  "tls-cert": 365,
  domain: 365,
  // Leases always carry an absolute `expires_at`, so age-derivation never
  // applies to them; the entry exists only because every kind needs one.
  lease: 365,
  other: 365,
};

/** Human labels for the kind buckets, shared by every surface. */
export const EXPIRY_KIND_LABELS: Record<ExpiryKind, string> = {
  "tls-cert": "TLS certificates",
  domain: "Domains",
  "api-token": "API tokens",
  "access-key": "Access keys",
  "k8s-cert": "Kubernetes certificates",
  "ssh-key": "SSH keys",
  "secret-version": "Secret versions",
  lease: "Leases",
  other: "Other",
};

/** One deadline on one resource. A resource can carry several. */
export interface ExpiryItem {
  /** Infrawrench resource id. */
  resourceId: string;
  pluginId: string;
  /** Plugin display name, e.g. "Cloudflare". */
  pluginName: string;
  resourceTypeId: string;
  /** Display name of the resource type, e.g. "ACM Certificate". */
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  displayName: string;
  /** Provider-native id, when known. */
  externalId: string | null;
  /** The declared field the deadline came from. */
  fieldKey: string;
  kind: ExpiryKind;
  /** Plugin-authored caption, e.g. "Certificate expires". */
  label: string;
  /**
   * `"expiry"` — the field held the deadline itself; `"age"` — the deadline
   * was derived from a creation/rotation date plus an age budget.
   */
  basis: "expiry" | "age";
  /** The deadline, ISO 8601. */
  dueAt: string;
  /**
   * Whole days until `dueAt` (floor); negative once expired. Day boundaries
   * are relative to the scan instant, not calendar midnight, so the value is
   * timezone-stable.
   */
  daysRemaining: number;
  severity: ExpirySeverity;
  /**
   * Present only on `kind: "lease"` items: true when the lease opted into
   * auto-delete, so surfaces can badge "this one will actually be deleted"
   * distinctly from a nag-only lease. Absent on every plugin-declared item.
   */
  leaseAutoDelete?: boolean;
}

/** Wire shape of `GET /api/org/:orgId/expiring` and the local CLI assembly. */
export interface ExpiryListResponse {
  /** All tracked deadlines, soonest first (`ok` items included). */
  items: ExpiryItem[];
  totalCount: number;
  /** Item count per severity; every bucket present, zeros included. */
  counts: Record<ExpirySeverity, number>;
  /** The lead time the `upcoming` bucket was computed against. */
  leadDays: number;
  generatedAt: string;
}

/** The part of a resource type definition the scan reads. */
export interface ExpiryScanResourceType {
  id: string;
  displayName: string;
  expiryFields?: readonly ExpiryFieldRule[] | undefined;
}

/** The part of a loaded plugin the scan reads. */
export interface ExpiryScanPlugin {
  id: string;
  displayName: string;
  resourceTypes: readonly ExpiryScanResourceType[];
}

/** The part of an account row the scan reads. */
export interface ExpiryScanAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/**
 * The part of a stored resource row the scan reads. Hosts map their own store
 * onto this — Postgres jsonb, SQLite TEXT bags — so the computation never
 * learns which database it is looking at.
 */
export interface ExpiryScanResource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  /** The instance's stored `fields` bag; a missing/!object bag yields nothing. */
  fields: unknown;
}

export interface ExpiryScanInput {
  plugins: readonly ExpiryScanPlugin[];
  accounts: readonly ExpiryScanAccount[];
  resources: readonly ExpiryScanResource[];
}

export interface ExpiryFeedOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /** Org lead time for the `upcoming` bucket; defaults to {@link DEFAULT_EXPIRY_LEAD_DAYS}. */
  leadDays?: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Parse a stored field value as a point in time, epoch milliseconds.
 *
 * Accepts ISO 8601 (with or without time), RFC 2822, and unix epochs in
 * seconds or milliseconds, as either numbers or numeric strings — the formats
 * provider listers actually store. Returns null for anything else: an
 * unparseable value must drop the item, never alarm on it. Small numbers
 * (< 1e8, i.e. before ~1973 as seconds) are rejected rather than guessed at,
 * so a port number or a count can never read as a date.
 */
export function parseExpiryInstant(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 1e8) return null;
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseExpiryInstant(Number(trimmed));
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) return parsed;
  // Go-style timestamps ("2038-01-18 00:00:00 +0000 UTC", Cloudflare origin
  // certs) carry a zone name after the numeric offset that Date.parse rejects.
  const goStyle = trimmed.replace(/ [A-Z]{3,4}$/, "");
  if (goStyle !== trimmed) {
    const reparsed = Date.parse(goStyle);
    if (!Number.isNaN(reparsed)) return reparsed;
  }
  return null;
}

/** Bucket a deadline relative to the scan instant. */
export function expirySeverity(daysRemaining: number, leadDays: number): ExpirySeverity {
  if (daysRemaining < 0) return "expired";
  if (daysRemaining < EXPIRY_CRITICAL_DAYS) return "critical";
  if (daysRemaining < EXPIRY_WARNING_DAYS) return "warning";
  if (daysRemaining <= leadDays) return "upcoming";
  return "ok";
}

/**
 * Compute the expiry feed for a workspace: every declared deadline on every
 * stored resource, soonest first.
 *
 * Pure and deterministic — two hosts reading the same rows render the same
 * feed. Resources whose account is missing from `accounts` are skipped
 * (soft-deleted account, not a deadline worth alarming on), as is any field
 * value that fails to parse as a date.
 */
export function computeExpiryFeed(
  input: ExpiryScanInput,
  options: ExpiryFeedOptions = {},
): ExpiryListResponse {
  const now = options.now ?? Date.now();
  const leadDays = options.leadDays ?? DEFAULT_EXPIRY_LEAD_DAYS;

  // pluginId → { pluginName, types: typeId → { typeName, rules } }
  const ruleIndex = new Map<
    string,
    {
      pluginName: string;
      types: Map<string, { typeName: string; rules: readonly ExpiryFieldRule[] }>;
    }
  >();
  for (const plugin of input.plugins) {
    const types = new Map<string, { typeName: string; rules: readonly ExpiryFieldRule[] }>();
    for (const type of plugin.resourceTypes) {
      if (type.expiryFields && type.expiryFields.length > 0)
        types.set(type.id, { typeName: type.displayName, rules: type.expiryFields });
    }
    if (types.size > 0) ruleIndex.set(plugin.id, { pluginName: plugin.displayName, types });
  }

  const accountMap = new Map(input.accounts.map((a) => [a.id, a]));
  const items: ExpiryItem[] = [];

  if (ruleIndex.size > 0) {
    for (const r of input.resources) {
      const pluginEntry = ruleIndex.get(r.pluginId);
      const typeEntry = pluginEntry?.types.get(r.resourceTypeId);
      if (!pluginEntry || !typeEntry) continue;
      const account = accountMap.get(r.accountId);
      if (!account) continue;
      const fields =
        r.fields && typeof r.fields === "object" && !Array.isArray(r.fields)
          ? (r.fields as Record<string, unknown>)
          : undefined;
      if (!fields) continue;

      for (const rule of typeEntry.rules) {
        let instant = parseExpiryInstant(fields[rule.fieldKey]);
        // Age-budget rules may fall back to a secondary field when the primary
        // is empty (never-rotated Secrets Manager secrets → createdDate).
        if (
          instant === null &&
          rule.from === "created" &&
          rule.fallbackFieldKey &&
          rule.fallbackFieldKey !== rule.fieldKey
        ) {
          instant = parseExpiryInstant(fields[rule.fallbackFieldKey]);
        }
        if (instant === null) continue;
        const dueMs =
          rule.from === "created"
            ? instant + (rule.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS[rule.kind]) * MS_PER_DAY
            : instant;
        const daysRemaining = Math.floor((dueMs - now) / MS_PER_DAY);
        items.push({
          resourceId: r.id,
          pluginId: r.pluginId,
          pluginName: pluginEntry.pluginName,
          resourceTypeId: r.resourceTypeId,
          resourceTypeName: typeEntry.typeName,
          accountId: r.accountId,
          accountName: account.displayName,
          displayName: r.displayName,
          externalId: r.externalId,
          fieldKey: rule.fieldKey,
          kind: rule.kind,
          label: rule.label,
          basis: rule.from === "created" ? "age" : "expiry",
          dueAt: new Date(dueMs).toISOString(),
          daysRemaining,
          severity: expirySeverity(daysRemaining, leadDays),
        });
      }
    }
  }

  items.sort(
    (a, b) =>
      a.dueAt.localeCompare(b.dueAt) ||
      a.displayName.localeCompare(b.displayName) ||
      a.fieldKey.localeCompare(b.fieldKey),
  );

  const counts: Record<ExpirySeverity, number> = {
    expired: 0,
    critical: 0,
    warning: 0,
    upcoming: 0,
    ok: 0,
  };
  for (const item of items) counts[item.severity] += 1;

  return {
    items,
    totalCount: items.length,
    counts,
    leadDays,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Merge host-injected items (resource leases) into a computed feed, keeping
 * the feed's contract intact: one sort order (due date, then display name,
 * then field key — the exact comparator `computeExpiryFeed` uses) and counts
 * that cover every item. Returns a new response; neither input is mutated.
 */
export function mergeExpiryItems(
  feed: ExpiryListResponse,
  extra: ExpiryItem[],
): ExpiryListResponse {
  if (extra.length === 0) return feed;
  const items = [...feed.items, ...extra];
  items.sort(
    (a, b) =>
      a.dueAt.localeCompare(b.dueAt) ||
      a.displayName.localeCompare(b.displayName) ||
      a.fieldKey.localeCompare(b.fieldKey),
  );
  const counts: Record<ExpirySeverity, number> = {
    expired: 0,
    critical: 0,
    warning: 0,
    upcoming: 0,
    ok: 0,
  };
  for (const item of items) counts[item.severity] += 1;
  return { ...feed, items, totalCount: items.length, counts };
}

/** Items at or past the org's lead time — what the poller alerts on. */
export function itemsWithinLead(feed: ExpiryListResponse): ExpiryItem[] {
  return feed.items.filter((i) => i.severity !== "ok");
}

/**
 * Org-level expiry alert settings — the wire shape of
 * `GET|PUT /api/org/:orgId/expiring/settings` (permission `org:settings:write`).
 * Shaped like the drift alert settings: the lead time feeds both the feed's
 * `upcoming` bucket and the poller's alert pass.
 */
export interface ExpirySettings {
  /** Whether the poller sends expiry alerts for this org at all. */
  enabled: boolean;
  /** Days of lead time before a deadline counts as `upcoming` and alertable. */
  leadDays: number;
  /** When the org was last notified; null before the first alert. */
  lastNotifiedAt: string | null;
}

export interface ExpirySettingsPatch {
  enabled?: boolean;
  leadDays?: number;
}

/** Read the org's expiry alert settings. */
export async function getExpirySettings(api: CloudFetch, orgId: string): Promise<ExpirySettings> {
  const res = await api.org<ExpirySettings>(orgId, "/expiring/settings");
  return res ?? { enabled: true, leadDays: DEFAULT_EXPIRY_LEAD_DAYS, lastNotifiedAt: null };
}

/** Update the org's expiry alert settings. */
export async function updateExpirySettings(
  api: CloudFetch,
  orgId: string,
  patch: ExpirySettingsPatch,
): Promise<ExpirySettings> {
  const res = await api.org<ExpirySettings>(orgId, "/expiring/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  return res ?? { enabled: true, leadDays: DEFAULT_EXPIRY_LEAD_DAYS, lastNotifiedAt: null };
}

/**
 * Read `GET /api/org/:orgId/expiring` (permission `resources:read`).
 *
 * Cheap and side-effect free: the server computes the feed over rows it
 * already synced and makes no provider API calls.
 */
export async function fetchExpiring(api: CloudFetch, orgId: string): Promise<ExpiryListResponse> {
  const res = await api.org<ExpiryListResponse>(orgId, "/expiring");
  return (
    res ?? {
      items: [],
      totalCount: 0,
      counts: { expired: 0, critical: 0, warning: 0, upcoming: 0, ok: 0 },
      leadDays: DEFAULT_EXPIRY_LEAD_DAYS,
      generatedAt: new Date().toISOString(),
    }
  );
}
