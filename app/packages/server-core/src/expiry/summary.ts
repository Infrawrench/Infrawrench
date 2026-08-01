/**
 * Pure capping and rendering for expiry alerts. No I/O lives here so the
 * message shape is unit-testable without a database — the same split as
 * `drift/summary.ts`. `alerts.ts` does the claim, the feed read and the
 * fan-out.
 *
 * Volume is structurally bounded before this module runs: the cooldown claim
 * caps the message rate at one per org per 24h, and the feed itself is one
 * bounded computation over stored rows. What this module bounds is the *body*
 * — at most {@link MAX_LISTED_DEADLINES} named deadlines, soonest first, with
 * the rest collapsed into a trailing count.
 */
import type { ExpiryItem, ExpirySeverity } from "@infrawrench/client-core";

/** Hard ceiling on individual deadlines named in the message body. */
export const MAX_LISTED_DEADLINES = 8;

/** The alertable severities, most urgent first. `ok` never reaches a message. */
export const ALERT_SEVERITIES = ["expired", "critical", "warning", "upcoming"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface ExpiryAlertSummary {
  /** Deadlines inside the org's lead time (severity != "ok"). */
  total: number;
  /** Count per alertable severity; every bucket present, zeros included. */
  counts: Record<AlertSeverity, number>;
  /** The deadlines named in the body — the soonest, capped. */
  items: ExpiryItem[];
  /** How many deadlines the body does not name. */
  omitted: number;
  /** The lead time the feed was computed against. */
  leadDays: number;
}

/**
 * Fold the alertable items into the message the transports render. `items`
 * must already exclude `ok` (see `itemsWithinLead`) and be sorted soonest
 * first, which is the feed's own order.
 */
export function summarizeExpiry(items: ExpiryItem[], leadDays: number): ExpiryAlertSummary {
  const counts: Record<AlertSeverity, number> = {
    expired: 0,
    critical: 0,
    warning: 0,
    upcoming: 0,
  };
  for (const item of items) {
    if (item.severity !== "ok") counts[item.severity as AlertSeverity] += 1;
  }
  return {
    total: items.length,
    counts,
    items: items.slice(0, MAX_LISTED_DEADLINES),
    omitted: Math.max(0, items.length - MAX_LISTED_DEADLINES),
    leadDays,
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Message headline. */
export function expiryTitle(summary: ExpiryAlertSummary): string {
  if (summary.counts.expired > 0) {
    return `Expiry radar: ${plural(summary.counts.expired, "deadline")} passed, ${
      summary.total - summary.counts.expired
    } approaching`;
  }
  return `Expiry radar: ${plural(summary.total, "deadline")} within ${summary.leadDays} days`;
}

/** `"<name> — <label> in 12d"` / `"<name> — <label> expired 3d ago"`. */
export function expiryItemLine(item: ExpiryItem): string {
  const when =
    item.daysRemaining < 0 ? `expired ${-item.daysRemaining}d ago` : `in ${item.daysRemaining}d`;
  return `${item.displayName} — ${item.label} ${when}`;
}

function countsLine(summary: ExpiryAlertSummary): string {
  return ALERT_SEVERITIES.map((s) => `${summary.counts[s]} ${s}`).join(" · ");
}

/**
 * The body as plain-text lines, shared by every transport — the same split the
 * drift and weekly-digest bodies use. `bold` wraps a fragment in the
 * transport's bold markup, or returns it unchanged for plain text (the Teams
 * Adaptive Card escaper turns `*` into a literal asterisk, so Teams must not
 * receive mrkdwn).
 */
export function expiryLines(summary: ExpiryAlertSummary, bold: (s: string) => string): string[] {
  const lines: string[] = [
    `${bold(plural(summary.total, "deadline"))} within your ${summary.leadDays}-day lead time`,
    countsLine(summary),
  ];
  if (summary.items.length > 0) {
    lines.push("");
    for (const item of summary.items) lines.push(`• ${expiryItemLine(item)}`);
  }
  if (summary.omitted > 0) {
    lines.push(`…and ${plural(summary.omitted, "more deadline")} on the expiry radar`);
  }
  return lines;
}

/** Slack mrkdwn body. `slack.ts` escapes `&<>` and leaves `*bold*` intact. */
export function formatExpirySlackBody(summary: ExpiryAlertSummary): string {
  return expiryLines(summary, (s) => `*${s}*`).join("\n");
}

/** Teams plain-text body — the Adaptive Card escaper strips markdown anyway. */
export function formatExpiryTeamsBody(summary: ExpiryAlertSummary): string {
  return expiryLines(summary, (s) => s).join("\n\n");
}

/**
 * Mobile push body. A notification banner shows two or three lines, so it gets
 * the counts and the single soonest deadline — the deep link carries the
 * reader to the full radar.
 */
export function formatExpiryPushBody(summary: ExpiryAlertSummary): string {
  const first = summary.items[0];
  const lead = first ? `${expiryItemLine(first)}. ` : "";
  return `${lead}${countsLine(summary)}`;
}

/** Slack/Teams context line. */
export function expiryContext(summary: ExpiryAlertSummary): string {
  return `${summary.leadDays}-day lead time · deadlines from synced resources`;
}

/** Type used by tests to keep the severity math honest. */
export type { ExpirySeverity };
