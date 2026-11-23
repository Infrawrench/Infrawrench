/**
 * Pure capping and rendering for capacity runway alerts, the
 * `quotas/summary.ts` split: no I/O, so the message shape is testable without
 * a database. The lines ride the quota radar's daily digest
 * (`quotas/alerts.ts`), under the same trigger and the same claim.
 */
import { formatRunwayAmount, formatRunwayDays, type RunwayRow } from "@infrawrench/client-core";

/** Hard ceiling on individual usages named in the message body. */
export const MAX_LISTED_RUNWAY = 8;

export interface RunwayAlertSummary {
  /** Usages at their limit or running out (status `full` or `critical`). */
  total: number;
  full: number;
  /** Runway rows inside the org's day threshold. */
  runningOut: number;
  /** Monthly allowances over the threshold or projected past their limit. */
  allowances: number;
  /** The usages named in the body: soonest first, capped. */
  rows: RunwayRow[];
  omitted: number;
  runwayDays: number;
  allowanceThreshold: number;
}

/**
 * Fold the alertable rows into the message. `rows` must already be the feed's
 * alertable subset, in its soonest-first order.
 */
export function summarizeRunway(
  rows: RunwayRow[],
  settings: { runwayDays: number; allowanceThreshold: number },
): RunwayAlertSummary {
  let full = 0;
  let runningOut = 0;
  let allowances = 0;
  for (const row of rows) {
    if (row.status === "full") full += 1;
    else if (row.kind === "allowance") allowances += 1;
    else runningOut += 1;
  }
  return {
    total: rows.length,
    full,
    runningOut,
    allowances,
    rows: rows.slice(0, MAX_LISTED_RUNWAY),
    omitted: Math.max(0, rows.length - MAX_LISTED_RUNWAY),
    runwayDays: settings.runwayDays,
    allowanceThreshold: settings.allowanceThreshold,
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Headline when the digest carries runway rows only. Full leads, always. */
export function runwayTitle(summary: RunwayAlertSummary): string {
  if (summary.full > 0) {
    return `Capacity runway: ${plural(summary.full, "resource limit")} reached, ${
      summary.total - summary.full
    } running out`;
  }
  return `Capacity runway: ${plural(summary.total, "resource limit")} running out`;
}

/**
 * `"prod · orders-db · Storage: 9.2 GiB of 10 GiB, full in 6 days"`, or for
 * an allowance `"…, 410 of 500 hours, 640 by Dec 1"`. The absolute figures
 * ride along for the quota radar's reason: a percentage alone does not say
 * whether the fix is a resize or a cleanup.
 */
export function runwayRowLine(row: RunwayRow): string {
  const amounts = `${formatRunwayAmount(row.used, row.unit)} of ${formatRunwayAmount(
    row.limit,
    row.unit,
  )}`;
  let trailer = "";
  if (row.status === "full") {
    trailer = ", at the limit";
  } else if (row.kind === "allowance" && row.cycle) {
    const resets = row.cycle.end.slice(0, 10);
    trailer =
      row.cycle.projectedUsed !== null
        ? `, ${formatRunwayAmount(row.cycle.projectedUsed, row.unit)} projected by ${resets}`
        : `, resets ${resets}`;
  } else if (row.forecast.daysLeft !== null) {
    trailer = `, full ${formatRunwayDays(row.forecast.daysLeft)}`;
  }
  const plan = row.limitSource === "plan" && row.plan ? ` (${row.plan} plan)` : "";
  return `${row.accountName} · ${row.resourceName} · ${row.label}: ${amounts}${plan}${trailer}`;
}

/** The runway half of the digest body, as plain lines shared by every transport. */
export function runwayLines(summary: RunwayAlertSummary, bold: (s: string) => string): string[] {
  const counts = [
    summary.full > 0 ? `${summary.full} at the limit` : null,
    summary.runningOut > 0 ? `${summary.runningOut} within ${summary.runwayDays} days` : null,
    summary.allowances > 0
      ? `${plural(summary.allowances, "monthly allowance")} running out`
      : null,
  ].filter((s): s is string => s !== null);
  const lines = [
    `${bold(plural(summary.total, "resource limit"))} at or heading for capacity`,
    counts.join(" · "),
    "",
  ];
  for (const row of summary.rows) lines.push(`• ${runwayRowLine(row)}`);
  if (summary.omitted > 0) lines.push(`…and ${summary.omitted} more on the runway list`);
  return lines;
}
