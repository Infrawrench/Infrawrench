/**
 * Pure capping and rendering for extended-support alerts, the
 * `posture/summary.ts` split: no I/O, so the message shape is unit-testable.
 *
 * Only billable findings reach a message (`alertableExtendedSupport`:
 * paying a surcharge now, or past the end of support). Upcoming surcharges
 * are deadlines, and the expiry radar already alerts on deadlines.
 */
import {
  formatExtendedSupportMoney,
  type ExtendedSupportFinding,
  type ExtendedSupportTotal,
} from "@infrawrench/client-core";
import { escapeMrkdwnFragment } from "../slack-escape";

/** Hard ceiling on individual findings named in the message body. */
export const MAX_LISTED_EXTENDED_SUPPORT = 8;

export interface ExtendedSupportAlertSummary {
  total: number;
  surcharged: number;
  endOfLife: number;
  /** Monthly surcharge across the alertable findings, per currency. */
  monthly: ExtendedSupportTotal[];
  /** The named findings: the feed's order (most urgent, then largest). */
  findings: ExtendedSupportFinding[];
  omitted: number;
}

export function summarizeExtendedSupport(
  findings: ExtendedSupportFinding[],
): ExtendedSupportAlertSummary {
  const sums = new Map<string, number>();
  for (const f of findings) {
    if (f.monthlySurcharge === null || f.currency === null) continue;
    sums.set(f.currency, (sums.get(f.currency) ?? 0) + f.monthlySurcharge);
  }
  return {
    total: findings.length,
    surcharged: findings.filter((f) => f.status === "surcharged").length,
    endOfLife: findings.filter((f) => f.status === "end-of-life").length,
    monthly: [...sums.entries()]
      .map(([currency, monthly]) => ({ currency, monthly: Math.round(monthly * 100) / 100 }))
      .sort((a, b) => b.monthly - a.monthly),
    findings: findings.slice(0, MAX_LISTED_EXTENDED_SUPPORT),
    omitted: Math.max(0, findings.length - MAX_LISTED_EXTENDED_SUPPORT),
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

function moneyLine(totals: ExtendedSupportTotal[]): string {
  return totals.map((t) => `${formatExtendedSupportMoney(t.monthly, t.currency)}/mo`).join(" + ");
}

export function extendedSupportTitle(summary: ExtendedSupportAlertSummary): string {
  const money = moneyLine(summary.monthly);
  return money
    ? `Extended support: ${money} in surcharges an upgrade would remove`
    : `Extended support: ${plural(summary.total, "resource")} past standard support`;
}

/** `"<name>: Amazon EKS 1.30 → 1.35, $365/mo (billed)"`. */
export function extendedSupportFindingLine(
  f: ExtendedSupportFinding,
  escape: (s: string) => string = (s) => s,
): string {
  const cost =
    f.monthlySurcharge !== null && f.currency !== null
      ? `, ${formatExtendedSupportMoney(f.monthlySurcharge, f.currency)}/mo${
          f.costBasis === "list-price" ? " at list price" : ""
        }`
      : "";
  const state = f.status === "end-of-life" ? " (past end of support)" : "";
  return `${escape(f.displayName)}: ${escape(f.product)} ${escape(f.currentVersion)} → ${escape(
    f.targetVersion,
  )}${cost}${state}`;
}

export function extendedSupportLines(
  summary: ExtendedSupportAlertSummary,
  bold: (s: string) => string,
  escape: (s: string) => string = (s) => s,
): string[] {
  const parts = [
    summary.surcharged > 0 ? `${summary.surcharged} paying extended support` : "",
    summary.endOfLife > 0 ? `${summary.endOfLife} past end of support` : "",
  ].filter(Boolean);
  const lines = [`${bold(plural(summary.total, "resource"))} on old versions`, parts.join(" · ")];
  if (summary.findings.length > 0) {
    lines.push("");
    for (const f of summary.findings) lines.push(`• ${extendedSupportFindingLine(f, escape)}`);
  }
  if (summary.omitted > 0) {
    lines.push(`…and ${plural(summary.omitted, "more resource")} in Costs → Extended support`);
  }
  return lines;
}

export function formatExtendedSupportSlackBody(summary: ExtendedSupportAlertSummary): string {
  return extendedSupportLines(summary, (s) => `*${s}*`, escapeMrkdwnFragment).join("\n");
}

export function formatExtendedSupportTeamsBody(summary: ExtendedSupportAlertSummary): string {
  return extendedSupportLines(summary, (s) => s)
    .filter((line) => line !== "")
    .join("\n\n");
}

export function formatExtendedSupportPushBody(summary: ExtendedSupportAlertSummary): string {
  const first = summary.findings[0];
  const rest = summary.total > 1 ? ` (+${summary.total - 1} more)` : "";
  return first ? `${extendedSupportFindingLine(first)}${rest}` : "";
}

export function extendedSupportContext(): string {
  return "weekly · provider support calendars over synced versions";
}
