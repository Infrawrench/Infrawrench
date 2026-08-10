/**
 * Scheduled cost-report delivery — composition and schedule arithmetic. Pure
 * functions only, exactly like `digest/compose.ts`: data in, data out, so the
 * message a schedule sends and the instant it next fires are both unit-testable
 * without a database, a clock, or a network.
 *
 * **This feature follows the digest pattern, not the alert-routing one.** A
 * scheduled report delivery is a composed, recurring summary sent to
 * destinations the schedule itself names — like the weekly digest — and it is
 * *not* an alert: it has no severity, no quiet hours, no escalation, and it
 * must not be routed through `alerts/route.ts`. Do not "fix" that later; the
 * routing table answers "where do alerts of this kind go", which is a
 * different question from "who asked for this report, when".
 *
 * No chart images, deliberately: the digest ships none either, and a rendering
 * pipeline (headless browser, image hosting, dark-mode variants) is a feature
 * of its own, not a side effect of this one. The message carries the numbers
 * and a deep link to the live chart.
 */
import type { CostConversion } from "@infrawrench/client-core";
import {
  addDays,
  civilMoment,
  conversionCaveat,
  formatAmount,
  isValidTimeZone,
  type DigestLine,
} from "../digest/compose";
import { zonedInstant } from "../cost-exports/periods";

export type ReportNotificationCadence = "daily" | "weekly" | "monthly";

/** What the last attempt for a schedule did. Same vocabulary as the digest. */
export type ReportDeliveryStatus = "pending" | "succeeded" | "partial" | "failed" | "no_targets";

// --- Schedule arithmetic ---
//
// Same civil-date discipline as the digest and the cost exports: day stepping
// on Y/M/D triples, with `zonedInstant` turning the chosen local (date, hour)
// into a UTC instant only at the very end. DST changes therefore keep the
// delivery at the hour the user chose, and the spring-forward gap lands an
// hour later rather than being skipped.

export interface ReportSchedule {
  cadence: ReportNotificationCadence;
  /** ISO day of week (1 = Monday … 7 = Sunday); read only for `weekly`. */
  sendDay: number;
  /** Day of month (1–31); read only for `monthly`. Clamped to month end. */
  sendDayOfMonth: number;
  /** Local hour, 0–23. */
  hour: number;
  /** IANA zone. Invalid zones fall back to UTC — this runs in the poller. */
  timezone: string;
}

/** Days in the civil month containing `isoDate`. Pure calendar math. */
function daysInMonthOf(isoDate: string): number {
  const [y, m] = isoDate.split("-").map((n) => Number.parseInt(n, 10));
  // Day 0 of the next month is the last day of this one; Date.UTC is used as a
  // calendar calculator only, no instant is derived from it.
  return new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a civil date. */
function isoDowOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map((n) => Number.parseInt(n, 10));
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Whether `isoDate` is a day this schedule fires on (ignoring the hour). */
function firesOn(schedule: ReportSchedule, isoDate: string): boolean {
  switch (schedule.cadence) {
    case "daily":
      return true;
    case "weekly":
      return isoDowOf(isoDate) === Math.min(7, Math.max(1, Math.trunc(schedule.sendDay) || 1));
    case "monthly": {
      // "The 31st" clamps to the month's last day rather than skipping the
      // month: someone who scheduled day 31 asked for month end, and a
      // schedule that silently fires 7 times a year is worse than one that
      // fires on the 30th of April.
      const wanted = Math.min(31, Math.max(1, Math.trunc(schedule.sendDayOfMonth) || 1));
      const day = Number.parseInt(isoDate.slice(8, 10), 10);
      return day === Math.min(wanted, daysInMonthOf(isoDate));
    }
  }
}

/**
 * When this schedule next fires, strictly after `from`.
 *
 * Walks local days forward (like `nextCostExportRunAt`) and takes the first
 * firing day whose local `hour` is still ahead. 62 iterations covers the
 * longest possible gap — a monthly schedule checked the day after it fired —
 * with slack; the fallback is a day, never a throw, because the poller calls
 * this.
 */
export function nextReportSendAt(schedule: ReportSchedule, from: Date): Date {
  const tz = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
  const hour = Math.min(23, Math.max(0, Math.trunc(schedule.hour) || 0));
  const start = civilMoment(from, tz).date;
  for (let i = 0; i <= 62; i++) {
    const date = addDays(start, i);
    if (!firesOn(schedule, date)) continue;
    const instant = zonedInstant(date, hour, tz);
    if (instant.getTime() > from.getTime()) return instant;
  }
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

// --- Message composition ---

/** One currency's period total, with the previous period's when known. */
export interface ReportDeliveryTotal {
  currency: string;
  currentAmount: number;
  /** Null when the previous period was not queried or had no rows. */
  previousAmount: number | null;
}

/** One of the report's top groups, already labelled and converted. */
export interface ReportDeliveryGroup {
  label: string;
  currency: string;
  amount: number;
}

/** Everything the renderers need — produced by `deliver.ts`, consumed here. */
export interface ReportDeliveryData {
  reportName: string;
  description: string | null;
  /** Inclusive YYYY-MM-DD window the report's date range resolved to. */
  from: string;
  to: string;
  /** What the report groups by, for the movers heading; null when ungrouped. */
  groupLabel: string | null;
  /** One entry per currency, largest current spend first. Empty = no spend. */
  totals: ReportDeliveryTotal[];
  /** Top groups by current-period spend, in the primary currency. */
  topGroups: ReportDeliveryGroup[];
  /** Set when the totals were converted into the org's display currency. */
  conversion?: CostConversion | undefined;
  /** Deep link to the report's own page; null when APP_URL is unset. */
  url: string | null;
}

/** How many groups a message quotes. Bounded — a message is not a spreadsheet. */
export const MAX_DELIVERY_GROUPS = 5;

/** `Monthly spend by service · Jul 1 – Jul 31` */
export function reportDeliveryTitle(data: ReportDeliveryData): string {
  const fmt = (day: string) =>
    new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${data.reportName} · ${fmt(data.from)} – ${fmt(data.to)}`;
}

function formatDelta(delta: number, currency: string): string {
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${formatAmount(delta, currency)}`;
}

function formatPct(current: number, previous: number): string {
  if (previous === 0) return "new";
  const pct = ((current - previous) / previous) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

const plain = (text: string): DigestLine => [{ text, bold: false }];
const strong = (text: string): DigestLine => [{ text, bold: true }];
const BLANK: DigestLine = [];

/**
 * The delivery body as the digest's structured lines, shared by every
 * transport so Slack, Teams and email can never drift in what they report.
 *
 * An empty result is a message, not a skip: "no spend" and "the schedule
 * silently broke" are indistinguishable from the receiving end, so the empty
 * case says out loud that the delivery ran and found nothing.
 */
export function reportDeliverySegments(data: ReportDeliveryData): DigestLine[] {
  const lines: DigestLine[] = [];

  if (data.description) {
    lines.push(plain(data.description));
    lines.push(BLANK);
  }

  if (data.totals.length === 0) {
    lines.push(
      plain(
        "No spend was recorded in this period for this report's scope. " +
          "This scheduled delivery still sends on an empty result, so a quiet " +
          "period never looks the same as a broken schedule.",
      ),
    );
    return lines;
  }

  for (const t of data.totals) {
    const suffix = data.totals.length > 1 ? ` (${t.currency})` : "";
    const head = {
      text: `Total${suffix}: ${formatAmount(t.currentAmount, t.currency)}`,
      bold: true,
    };
    if (t.previousAmount === null) {
      lines.push([head]);
    } else {
      const delta = t.currentAmount - t.previousAmount;
      lines.push([
        head,
        {
          text: ` — ${formatDelta(delta, t.currency)} (${formatPct(t.currentAmount, t.previousAmount)}) vs ${formatAmount(t.previousAmount, t.currency)} the period before`,
          bold: false,
        },
      ]);
    }
  }

  // The conversion caveat sits directly under the totals it qualifies: a
  // converted number that does not say so is worse than the several numbers
  // it replaced.
  const caveat = conversionCaveat(data.conversion);
  if (caveat) lines.push(plain(caveat));

  if (data.topGroups.length > 0) {
    lines.push(BLANK);
    lines.push(strong(data.groupLabel ? `Top ${data.groupLabel}s` : "Top groups"));
    for (const g of data.topGroups.slice(0, MAX_DELIVERY_GROUPS)) {
      lines.push(plain(`• ${g.label}: ${formatAmount(g.amount, g.currency)}`));
    }
  }

  return lines;
}

/** Flattened lines with a transport-specific bold wrapper — the digest's trick. */
function deliveryLines(data: ReportDeliveryData, bold: (s: string) => string): string[] {
  return reportDeliverySegments(data).map((line) =>
    line.map((seg) => (seg.bold ? bold(seg.text) : seg.text)).join(""),
  );
}

/** Slack mrkdwn body; `slack.ts` escapes `&<>` wholesale on the way out. */
export function formatReportSlackBody(data: ReportDeliveryData): string {
  return deliveryLines(data, (s) => `*${s}*`).join("\n");
}

/** Teams plain body; `msteams.ts` escapes card markdown wholesale. */
export function formatReportTeamsBody(data: ReportDeliveryData): string {
  return deliveryLines(data, (s) => s).join("\n\n");
}

/** The email plain-text part. */
export function formatReportEmailText(data: ReportDeliveryData): string {
  const lines = [reportDeliveryTitle(data), "", ...deliveryLines(data, (s) => s)];
  if (data.url) {
    lines.push("");
    lines.push(`View in Infrawrench: ${data.url}`);
  }
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The email HTML part — same hand-rolled inline-style shape as the digest's,
 * built from the segments so text and markup never mix in one string.
 */
export function formatReportEmailHtml(data: ReportDeliveryData): string {
  const body = reportDeliverySegments(data)
    .filter((line) => line.length > 0)
    .map((line) => {
      const html = line
        .map((seg) =>
          seg.bold ? `<strong>${escapeHtml(seg.text)}</strong>` : escapeHtml(seg.text),
        )
        .join("");
      const bullet = line[0]?.text.startsWith("•") ?? false;
      return `<p style="margin:0 0 8px;${bullet ? "padding-left:12px;" : ""}">${html}</p>`;
    })
    .join("\n");

  const button = data.url
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(data.url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">View in Infrawrench</a></p>`
    : "";

  return [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;max-width:640px;">`,
    `<h1 style="font-size:18px;margin:0 0 16px;">${escapeHtml(reportDeliveryTitle(data))}</h1>`,
    body,
    button,
    `</div>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

// --- Delivery classification and retry backoff (the digest's conventions) ---

export interface ReportDeliveryResult {
  attempted: number;
  succeeded: number;
  slack: { attempted: number; succeeded: number };
  teams: { attempted: number; succeeded: number };
  email: { attempted: number; succeeded: number };
}

/** Attempts one occurrence gets in total, including the first. */
export const MAX_REPORT_DELIVERY_ATTEMPTS = 3;

/** Backoff before attempt 2 and attempt 3, in minutes — the digest's values. */
export const REPORT_DELIVERY_RETRY_BACKOFF_MINUTES = [15, 60] as const;

/**
 * Classify a delivery. Identical logic to the digest's `classifyDelivery`,
 * and for the identical reason: only a *total* failure is retryable, because
 * Slack and Teams have no idempotency and a retry after a partial success
 * would post the report twice where it already landed.
 */
export function classifyReportDelivery(result: ReportDeliveryResult): {
  status: ReportDeliveryStatus;
  error: string | null;
  retryable: boolean;
} {
  if (result.attempted === 0) {
    return {
      status: "no_targets",
      error:
        "This schedule has no live destinations. Pick a Slack channel or Teams webhook, or add an email recipient.",
      retryable: false,
    };
  }
  if (result.succeeded === 0) {
    return {
      status: "failed",
      error: `All ${result.attempted} deliveries failed. See the poller logs for the per-destination errors.`,
      retryable: true,
    };
  }
  if (result.succeeded < result.attempted) {
    return {
      status: "partial",
      error: `Delivered to ${result.succeeded} of ${result.attempted} destinations; the rest failed. Not retried automatically — a retry would post the report twice where it already landed. Use “Send now” once the failing destination is fixed.`,
      retryable: false,
    };
  }
  return { status: "succeeded", error: null, retryable: false };
}

/**
 * When the next attempt for the current occurrence may run, or null when its
 * attempts are spent. `attemptCount` includes the attempt that just failed.
 */
export function nextReportDeliveryAttemptAt(now: Date, attemptCount: number): Date | null {
  if (attemptCount >= MAX_REPORT_DELIVERY_ATTEMPTS) return null;
  const minutes =
    REPORT_DELIVERY_RETRY_BACKOFF_MINUTES[attemptCount - 1] ??
    REPORT_DELIVERY_RETRY_BACKOFF_MINUTES.at(-1) ??
    60;
  return new Date(now.getTime() + minutes * 60 * 1000);
}
