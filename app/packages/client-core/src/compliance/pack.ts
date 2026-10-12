/**
 * Evidence packs: periods, the manifest contract, CSV encoding, fix targets,
 * and the pack schedule contract.
 *
 * A pack is a ZIP the server assembles for one framework and one period: a
 * PDF summary, `controls.csv`/`controls.json`, one CSV and one JSON file per
 * control, one CSV and one JSON file per evidence source, and
 * `manifest.json`, which lists every other file with its SHA-256. The
 * manifest cannot hash itself, so `SHA256SUMS` beside it carries the
 * manifest's own digest in `sha256sum -c` format.
 */
import type { ReportNotification, ReportNotificationStatus } from "../report-notifications";
import type { CompliancePeriod, ComplianceStatusCounts } from "./status";

/* ------------------------------------------------------------------ *
 * Periods
 * ------------------------------------------------------------------ */

/** The status screen's default window, in days ending today. */
export const DEFAULT_COMPLIANCE_PERIOD_DAYS = 90;

/** Longest period a status read or a pack may cover. */
export const MAX_COMPLIANCE_PERIOD_DAYS = 400;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayToUtc(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Inclusive day count of a period. */
export function compliancePeriodDays(period: CompliancePeriod): number {
  return Math.round((dayToUtc(period.to) - dayToUtc(period.from)) / 86_400_000) + 1;
}

/** The last {@link DEFAULT_COMPLIANCE_PERIOD_DAYS} days, ending on `now`'s UTC date. */
export function defaultCompliancePeriod(now: Date = new Date()): CompliancePeriod {
  const to = utcDay(now);
  const from = utcDay(new Date(dayToUtc(to) - (DEFAULT_COMPLIANCE_PERIOD_DAYS - 1) * 86_400_000));
  return { from, to };
}

/**
 * Parse `from`/`to` query values. Absent values take the default window; a
 * present but malformed one is an error, not a silent fallback, because the
 * period is printed on every page of the pack.
 */
export function parseCompliancePeriod(
  from: string | undefined | null,
  to: string | undefined | null,
  now: Date = new Date(),
): CompliancePeriod | { error: string } {
  const fallback = defaultCompliancePeriod(now);
  const f = from && from !== "" ? from : null;
  const t = to && to !== "" ? to : null;
  if (f !== null && (!ISO_DAY.test(f) || Number.isNaN(dayToUtc(f)))) {
    return { error: "from must be a date (YYYY-MM-DD)" };
  }
  if (t !== null && (!ISO_DAY.test(t) || Number.isNaN(dayToUtc(t)))) {
    return { error: "to must be a date (YYYY-MM-DD)" };
  }
  const period = { from: f ?? fallback.from, to: t ?? fallback.to };
  if (f === null && t !== null) {
    period.from = utcDay(new Date(dayToUtc(t) - (DEFAULT_COMPLIANCE_PERIOD_DAYS - 1) * 86_400_000));
  }
  if (period.from > period.to) return { error: "from must be on or before to" };
  if (compliancePeriodDays(period) > MAX_COMPLIANCE_PERIOD_DAYS) {
    return { error: `A period can cover at most ${MAX_COMPLIANCE_PERIOD_DAYS} days` };
  }
  return period;
}

/** The UTC instant range `[start, endExclusive)` a period covers. */
export function compliancePeriodBounds(period: CompliancePeriod): { start: Date; end: Date } {
  return {
    start: new Date(dayToUtc(period.from)),
    end: new Date(dayToUtc(period.to) + 86_400_000),
  };
}

/* ------------------------------------------------------------------ *
 * Pack schedules
 * ------------------------------------------------------------------ */

export const COMPLIANCE_PACK_CADENCES = ["monthly", "quarterly"] as const;
export type CompliancePackCadence = (typeof COMPLIANCE_PACK_CADENCES)[number];

export const COMPLIANCE_PACK_CADENCE_LABELS: Record<CompliancePackCadence, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
};

/**
 * The period a scheduled pack covers when it fires on civil date `today`
 * (in the schedule's zone): the previous calendar month, or the previous
 * calendar quarter. A pack that fires on the 3rd of April therefore covers
 * January to March, which is what "the Q1 pack" means.
 */
export function compliancePackPeriodFor(
  cadence: CompliancePackCadence,
  today: string,
): CompliancePeriod {
  const year = Number.parseInt(today.slice(0, 4), 10);
  const month = Number.parseInt(today.slice(5, 7), 10); // 1-12
  let startYear: number;
  let startMonth: number; // 1-12
  let months: number;
  if (cadence === "monthly") {
    startYear = month === 1 ? year - 1 : year;
    startMonth = month === 1 ? 12 : month - 1;
    months = 1;
  } else {
    const quarterStart = Math.floor((month - 1) / 3) * 3 + 1; // 1, 4, 7, 10
    startYear = quarterStart === 1 ? year - 1 : year;
    startMonth = quarterStart === 1 ? 10 : quarterStart - 3;
    months = 3;
  }
  const from = `${startYear}-${String(startMonth).padStart(2, "0")}-01`;
  // Day 0 of the month after the last covered month is its last day.
  const last = new Date(Date.UTC(startYear, startMonth - 1 + months, 0));
  return { from, to: utcDay(last) };
}

/** Bounds the API enforces for pack schedules (the report ones, reused). */
export const COMPLIANCE_PACK_SCHEDULE_LIMITS = {
  maxEmailRecipients: 20,
  maxSlackChannels: 20,
  maxTeamsWebhooks: 20,
  /** Schedules per framework. */
  maxPerFramework: 10,
} as const;

/** Create/update payload. A full replace, like every delivery schedule. */
export interface CompliancePackScheduleInput {
  frameworkId: string;
  cadence: CompliancePackCadence;
  /** Day of month (1-31), clamped to month end. Quarterly fires in Jan, Apr, Jul and Oct. */
  sendDayOfMonth?: number | undefined;
  hour: number;
  timezone: string;
  emailRecipients: string[];
  slackChannelIds?: string[] | undefined;
  teamsWebhookIds?: string[] | undefined;
  enabled: boolean;
}

/** A pack schedule as returned by the API: a `report_notifications` row targeting a framework. */
export interface CompliancePackSchedule extends Omit<
  ReportNotification,
  "costReportId" | "cadence" | "sendDay"
> {
  frameworkId: string;
  cadence: CompliancePackCadence;
  lastStatus: ReportNotificationStatus | null;
}

/** `"Quarterly · day 3 08:00 Europe/Berlin"`. */
export function describeCompliancePackSchedule(s: {
  cadence: CompliancePackCadence;
  sendDayOfMonth: number;
  hour: number;
  timezone: string;
}): string {
  const hour = `${String(s.hour).padStart(2, "0")}:00`;
  return `${COMPLIANCE_PACK_CADENCE_LABELS[s.cadence]} · day ${s.sendDayOfMonth} ${hour} ${s.timezone}`;
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

export const EVIDENCE_PACK_FORMAT = "infrawrench-evidence-pack";
export const EVIDENCE_PACK_FORMAT_VERSION = 1;

export interface EvidencePackFile {
  path: string;
  sha256: string;
  bytes: number;
  description: string;
}

export interface EvidencePackManifest {
  format: typeof EVIDENCE_PACK_FORMAT;
  formatVersion: number;
  organization: { id: string; name: string };
  framework: { id: string; name: string; version: string };
  period: CompliancePeriod;
  generatedAt: string;
  /** Who asked: a member's name, or `Scheduled delivery`. */
  generatedBy: string;
  counts: ComplianceStatusCounts;
  /**
   * Snapshot sources describe the org at `generatedAt`, not on every day of
   * the period. Listed so nobody reads a current posture scan as a
   * historical attestation.
   */
  snapshotSources: string[];
  files: EvidencePackFile[];
}

/** `soc2-evidence-2026-07-01-to-2026-09-30.zip`. */
export function evidencePackFileName(frameworkId: string, period: CompliancePeriod): string {
  return `${frameworkId}-evidence-${period.from}-to-${period.to}.zip`;
}

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

/**
 * RFC 4180, every cell quoted, and a leading `=`/`+`/`-`/`@` prefixed with a
 * tab: the access review export's rule, for the same reason (names in these
 * files come from customers' clouds, and an evidence file must not execute).
 */
export function complianceCsvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** A header row plus data rows, CRLF-terminated. */
export function toComplianceCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [header.map(complianceCsvCell).join(",")];
  for (const row of rows) lines.push(row.map(complianceCsvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/* ------------------------------------------------------------------ *
 * Vulnerability fix targets
 * ------------------------------------------------------------------ */

/**
 * Days an open finding may stay open before the vulnerability-management
 * evidence counts it as overdue. Common remediation targets, not a
 * framework requirement; printed beside the figures so a reader can apply
 * their own.
 */
export const VULNERABILITY_FIX_TARGET_DAYS = {
  critical: 15,
  high: 30,
  medium: 90,
  low: 180,
} as const;
