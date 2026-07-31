/**
 * Pure batching, capping and rendering for resource-drift alerts.
 *
 * No I/O lives here so the volume rules — the part that decides whether a
 * notification is usable or a pager storm — are unit-testable without a
 * database. `alerts.ts` does the reads, the cooldown claim and the fan-out.
 *
 * The volume problem, and the three caps that answer it
 * ----------------------------------------------------
 * A single sync pass can record hundreds of `resource_changes` rows, and the
 * poller runs a pass per account every few minutes. One notification per change
 * would be unusable and would get the integration muted (or rate-limited by
 * Slack, which throttles ~1 message/second/channel). So drift never notifies
 * per change:
 *
 * 1. **Message count** is capped by the cooldown claim in `alerts.ts`, not by
 *    anything here: at most one drift message per org per `cooldownMinutes`
 *    (default 60), no matter how many accounts synced or how many rows landed.
 *    That is the hard ceiling — 24 messages a day in the worst case.
 * 2. **Read size** is capped by {@link MAX_SCANNED_CHANGES}: the window query
 *    asks for at most one row beyond it, so a pathological window is reported
 *    as "500+ changes" instead of loading an unbounded result set.
 * 3. **Message size** is capped by {@link MAX_LISTED_CHANGES} lines, each with
 *    at most {@link MAX_DIFF_FIELDS} named fields. Everything else collapses
 *    into a trailing "…and N more" that points at the change timeline.
 *
 * On top of the caps the org filters what counts as drift at all
 * (`org_drift_alert_settings`): which change kinds, which accounts, and a
 * minimum number of changes per window.
 */

/** Hard ceiling on rows the window query reads for one notification. */
export const MAX_SCANNED_CHANGES = 500;

/** Hard ceiling on individual changes named in the message body. */
export const MAX_LISTED_CHANGES = 12;

/** Hard ceiling on fields named on one "updated" line. */
export const MAX_DIFF_FIELDS = 4;

export type DriftChangeKind = "created" | "updated" | "deleted";

/** Which kinds and accounts an org considers drift worth notifying about. */
export interface DriftFilter {
  notifyCreated: boolean;
  notifyUpdated: boolean;
  notifyDeleted: boolean;
  /** Account ids to alert on. Empty means every account. */
  accountIds: string[];
}

/** True when the org's filter would notify about a change of this kind. */
export function kindEnabled(filter: DriftFilter, kind: DriftChangeKind): boolean {
  if (kind === "created") return filter.notifyCreated;
  if (kind === "deleted") return filter.notifyDeleted;
  return filter.notifyUpdated;
}

/** The change kinds the org's filter admits, for the window query's `IN`. */
export function enabledKinds(filter: DriftFilter): DriftChangeKind[] {
  return (["created", "updated", "deleted"] as const).filter((k) => kindEnabled(filter, k));
}

/** True when the org's filter would notify about changes in this account. */
export function accountEnabled(filter: DriftFilter, accountId: string): boolean {
  return filter.accountIds.length === 0 || filter.accountIds.includes(accountId);
}

/** One `resource_changes` row, as the summary needs it. */
export interface DriftChangeRow {
  accountId: string;
  /** Account display name; null when the account row is gone. */
  accountName: string | null;
  resourceTypeId: string;
  displayName: string;
  changeKind: DriftChangeKind;
  /** Changed field names for "updated" rows; empty otherwise. */
  fields: string[];
}

export interface DriftSummary {
  /** Changes read for this window, capped at {@link MAX_SCANNED_CHANGES}. */
  total: number;
  /** True when the window held more than {@link MAX_SCANNED_CHANGES}. */
  truncated: boolean;
  created: number;
  updated: number;
  deleted: number;
  /** Distinct account ids represented, in first-seen order. */
  accountIds: string[];
  /** The single account's display name, when the window covers exactly one. */
  soleAccountName: string | null;
  /** The changes named in the body, capped at {@link MAX_LISTED_CHANGES}. */
  items: DriftChangeRow[];
  /** How many changes the body does not name. */
  omitted: number;
  /** Start of the window the summary covers. */
  since: Date;
}

/**
 * Fold a window's rows into the message the transports render.
 *
 * `rows` may hold one row beyond {@link MAX_SCANNED_CHANGES} — that extra row
 * is how the caller signals "there were more", and it is dropped here rather
 * than counted, so `total` never overstates what was actually read.
 */
export function summarizeDrift(rows: DriftChangeRow[], since: Date): DriftSummary {
  const truncated = rows.length > MAX_SCANNED_CHANGES;
  const scanned = truncated ? rows.slice(0, MAX_SCANNED_CHANGES) : rows;

  let created = 0;
  let updated = 0;
  let deleted = 0;
  const accountIds: string[] = [];
  const accountNames = new Map<string, string | null>();
  for (const row of scanned) {
    if (row.changeKind === "created") created++;
    else if (row.changeKind === "deleted") deleted++;
    else updated++;
    if (!accountNames.has(row.accountId)) {
      accountNames.set(row.accountId, row.accountName);
      accountIds.push(row.accountId);
    }
  }

  // Creations and deletions lead: a resource appearing or disappearing is the
  // change someone reading a drift alert is looking for, and burying it under a
  // page of field updates is exactly the failure mode the caps exist to avoid.
  const rank = { created: 0, deleted: 1, updated: 2 } as const;
  const ordered = scanned
    .map((row, i) => ({ row, i }))
    .sort((a, b) => rank[a.row.changeKind] - rank[b.row.changeKind] || a.i - b.i)
    .map((e) => e.row);

  const items = ordered.slice(0, MAX_LISTED_CHANGES);
  // "in prod-aws" is only true if we saw the whole window. Past the read cap
  // the unread rows may belong to other accounts, so the claim is dropped
  // rather than guessed at.
  const soleAccountId = !truncated && accountIds.length === 1 ? accountIds[0] : undefined;

  return {
    total: scanned.length,
    truncated,
    created,
    updated,
    deleted,
    accountIds,
    soleAccountName: soleAccountId ? (accountNames.get(soleAccountId) ?? null) : null,
    items,
    omitted: scanned.length - items.length,
    since,
  };
}

/** "500+" once the window overflowed the read cap, else the exact count. */
function countText(summary: DriftSummary): string {
  return summary.truncated ? `${summary.total}+` : String(summary.total);
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Message headline. Names the account when the window covers only one. */
export function driftTitle(summary: DriftSummary): string {
  const where = summary.soleAccountName ? ` in ${summary.soleAccountName}` : "";
  return `Infrastructure drift: ${countText(summary)} change${
    summary.total === 1 && !summary.truncated ? "" : "s"
  }${where}`;
}

function itemLine(row: DriftChangeRow, includeAccount: boolean): string {
  const where = includeAccount ? ` (${row.accountName ?? row.accountId})` : "";
  const base = `${row.changeKind} · ${row.resourceTypeId} "${row.displayName}"${where}`;
  if (row.changeKind !== "updated" || row.fields.length === 0) return `• ${base}`;
  const named = row.fields.slice(0, MAX_DIFF_FIELDS).join(", ");
  const rest = row.fields.length - MAX_DIFF_FIELDS;
  return `• ${base}: ${named}${rest > 0 ? ` +${rest} more` : ""}`;
}

/**
 * The body as plain-text lines, shared by every transport — the same split the
 * weekly digest uses. `bold` wraps a fragment in the transport's bold markup,
 * or returns it unchanged for plain text (the Teams Adaptive Card escaper turns
 * `*` into a literal asterisk, so Teams must not receive mrkdwn).
 */
export function driftLines(summary: DriftSummary, bold: (s: string) => string): string[] {
  const scope =
    summary.accountIds.length === 1
      ? (summary.soleAccountName ?? "1 account")
      : `${summary.accountIds.length} accounts`;
  const sinceText = summary.since.toISOString().replace("T", " ").slice(0, 16);

  const lines: string[] = [
    `${bold(`${countText(summary)} change${summary.total === 1 && !summary.truncated ? "" : "s"}`)} across ${scope} since ${sinceText} UTC`,
    `${summary.created} created · ${summary.updated} updated · ${summary.deleted} deleted`,
  ];
  if (summary.items.length > 0) {
    lines.push("");
    const includeAccount = summary.accountIds.length > 1;
    for (const row of summary.items) lines.push(itemLine(row, includeAccount));
  }
  if (summary.omitted > 0 || summary.truncated) {
    const more = summary.truncated
      ? "…and more — open the change timeline for the full window"
      : `…and ${plural(summary.omitted, "more change")} in the change timeline`;
    lines.push(more);
  }
  return lines;
}

/** Slack mrkdwn body. `slack.ts` escapes `&<>` and leaves `*bold*` intact. */
export function formatDriftSlackBody(summary: DriftSummary): string {
  return driftLines(summary, (s) => `*${s}*`).join("\n");
}

/** Teams plain-text body — the Adaptive Card escaper strips markdown anyway. */
export function formatDriftTeamsBody(summary: DriftSummary): string {
  return driftLines(summary, (s) => s).join("\n\n");
}

/**
 * Mobile push body. A notification banner shows two or three lines, so it gets
 * the counts only — the deep link carries the reader to the full timeline.
 */
export function formatDriftPushBody(summary: DriftSummary): string {
  const scope =
    summary.accountIds.length === 1
      ? (summary.soleAccountName ?? "1 account")
      : `${summary.accountIds.length} accounts`;
  return (
    `${countText(summary)} resource change${summary.total === 1 && !summary.truncated ? "" : "s"} ` +
    `across ${scope}: ${summary.created} created, ${summary.updated} updated, ${summary.deleted} deleted`
  );
}

/** Slack/Teams context line. */
export function driftContext(summary: DriftSummary): string {
  return `${summary.accountIds.length} account${summary.accountIds.length === 1 ? "" : "s"} · since ${summary.since.toISOString()}`;
}
