/**
 * Anomaly alerts scoped to a cost report: storage and evaluation.
 *
 * Org-wide detection (`anomaly-eval.ts`) judges every provider and service
 * against its own history and routes through the org's alert rules. A report
 * anomaly alert judges one thing instead: the report's filtered daily total, per
 * currency, at the alert's own sensitivity and floor, and sends to the
 * destinations stored on the alert. It runs from the same place (the end of an
 * org's anomaly pass, after cost collection), shares the detector maths
 * (`detectSpike` over a zero-filled 28-day baseline, the trailing three days
 * re-judged as they fill in) and the deliver-once arrangement (a unique row per
 * day plus `notified_at`, and a 7-day cooldown that counts only delivered rows).
 *
 * ## Routing
 *
 * Delivery goes through `routeAlert` with the alert's destinations as one
 * pinned leg: the same transports, de-duplication and email footer as a rule,
 * but no rule evaluation. That is the point: the owner of a report chose these
 * channels for this scope, and an org-wide rule somebody else maintains must
 * neither redirect nor swallow them. The org-wide anomaly rules are untouched
 * and still fire on their own breakdowns. Quiet hours belong to rules and do
 * not apply here.
 *
 * ## Scope
 *
 * The report's own filters, its saved filter (resolved at evaluation time, so
 * editing either moves the alert with it), and its cost basis, read inside the
 * cost visibility of the scoped member who configured it (`visibility_user_id`,
 * as on report schedules), so an alert can never report spend its owner cannot
 * see. Grouping, binning and display options do not apply: the alert watches
 * the report's total.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  COST_REPORT_ANOMALY_ALERT_LIMITS,
  type AlertDestination,
  type CostFilter,
  type CostGraphConfig,
  type CostReportAnomaly,
  type CostReportAnomalyAlert,
  type CostReportAnomalyAlertInput,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { costReportAnomalies, costReportAnomalyAlerts, costReports } from "../db/schema";
import { queryCosts } from "../clickhouse/cost-readers";
import { alertReached, routeAlert } from "../alerts/route";
import { orgAppUrl } from "../app-url";
import { resolveObjectCostVisibility } from "./visibility";
import { runWithCostVisibility } from "./visibility-context";
import { resolveSavedCostFilters } from "./saved-filters";
import { detectSpike, fillDailySeries, type AnomalyDetectionOptions } from "./anomaly-detect";
import { addDays, isoDay } from "./dates";

/** Same windows as org-wide detection, so the two read a day the same way. */
const BASELINE_DAYS = 28;
const EVALUATION_DAYS = 3;
const COOLDOWN_DAYS = 7;
/** A spike needs this many days with spend in its baseline (as org-wide). */
const MIN_BASELINE_DAYS = 7;

type AlertRow = typeof costReportAnomalyAlerts.$inferSelect;
type FindingRow = typeof costReportAnomalies.$inferSelect;

/** Invalid input or a missing report: routes map `status`. */
export class ReportAnomalyAlertError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "ReportAnomalyAlertError";
  }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

function toFinding(row: FindingRow): CostReportAnomaly {
  return {
    id: row.id,
    day: row.day,
    currency: row.currency,
    actual: row.actualAmount,
    baseline: row.baselineAmount,
    threshold: row.thresholdAmount,
    notifiedAt: row.notifiedAt ? row.notifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAlert(
  row: AlertRow,
  reportName: string,
  recent: CostReportAnomaly[],
): CostReportAnomalyAlert {
  return {
    id: row.id,
    reportId: row.costReportId,
    reportName,
    enabled: row.enabled,
    sigmas: row.sigmas,
    minDeltaCents: row.minDeltaCents,
    destinations: row.destinations,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastEvaluatedAt: row.lastEvaluatedAt ? row.lastEvaluatedAt.toISOString() : null,
    lastError: row.lastError,
    recent,
  };
}

async function recentFindings(alertIds: string[]): Promise<Map<string, CostReportAnomaly[]>> {
  const out = new Map<string, CostReportAnomaly[]>();
  if (alertIds.length === 0) return out;
  const rows = await db
    .select()
    .from(costReportAnomalies)
    .where(inArray(costReportAnomalies.alertId, alertIds))
    .orderBy(desc(costReportAnomalies.day), desc(costReportAnomalies.createdAt));
  for (const row of rows) {
    const list = out.get(row.alertId) ?? [];
    if (list.length < COST_REPORT_ANOMALY_ALERT_LIMITS.recentFindings) list.push(toFinding(row));
    out.set(row.alertId, list);
  }
  return out;
}

/** One report's alert, or null when it has none. */
export async function getReportAnomalyAlert(
  organizationId: string,
  reportId: string,
): Promise<CostReportAnomalyAlert | null> {
  const [row] = await db
    .select({ alert: costReportAnomalyAlerts, reportName: costReports.name })
    .from(costReportAnomalyAlerts)
    .innerJoin(costReports, eq(costReports.id, costReportAnomalyAlerts.costReportId))
    .where(
      and(
        eq(costReportAnomalyAlerts.organizationId, organizationId),
        eq(costReportAnomalyAlerts.costReportId, reportId),
        isNull(costReports.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const recent = await recentFindings([row.alert.id]);
  return toAlert(row.alert, row.reportName, recent.get(row.alert.id) ?? []);
}

/**
 * Every report alert in the org (deleted reports excluded), report name
 * order. The caller filters by object sharing; this is the org's whole list.
 */
export async function listReportAnomalyAlerts(
  organizationId: string,
): Promise<
  Array<
    CostReportAnomalyAlert & { reportCreatedByUserId: string | null; reportFolderId: string | null }
  >
> {
  const rows = await db
    .select({
      alert: costReportAnomalyAlerts,
      reportName: costReports.name,
      reportCreatedByUserId: costReports.createdByUserId,
      reportFolderId: costReports.folderId,
    })
    .from(costReportAnomalyAlerts)
    .innerJoin(costReports, eq(costReports.id, costReportAnomalyAlerts.costReportId))
    .where(
      and(
        eq(costReportAnomalyAlerts.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .orderBy(costReports.name);
  const recent = await recentFindings(rows.map((r) => r.alert.id));
  return rows.map((r) => ({
    ...toAlert(r.alert, r.reportName, recent.get(r.alert.id) ?? []),
    reportCreatedByUserId: r.reportCreatedByUserId,
    reportFolderId: r.reportFolderId,
  }));
}

/**
 * Create or replace a report's alert. The caller has validated the input
 * (`costReportAnomalyAlertProblem`, destination shape and ownership) and the
 * caller's access to the report. A whole replace, like the routing rules, so a
 * Terraform apply and the editor converge on the same row.
 */
export async function upsertReportAnomalyAlert(
  organizationId: string,
  reportId: string,
  input: CostReportAnomalyAlertInput,
  actor: { userId: string | null; visibilityUserId: string | null },
  now = new Date(),
): Promise<CostReportAnomalyAlert> {
  const [report] = await db
    .select({ id: costReports.id })
    .from(costReports)
    .where(
      and(
        eq(costReports.id, reportId),
        eq(costReports.organizationId, organizationId),
        isNull(costReports.deletedAt),
      ),
    )
    .limit(1);
  if (!report) throw new ReportAnomalyAlertError("Cost report not found", 404);

  const values = {
    enabled: input.enabled,
    sigmas: input.sigmas,
    minDeltaCents: input.minDeltaCents,
    destinations: input.destinations,
    visibilityUserId: actor.visibilityUserId,
    updatedAt: now,
    // A changed configuration is judged afresh: the old error described the
    // old one.
    lastError: null,
  };
  await db
    .insert(costReportAnomalyAlerts)
    .values({
      id: randomUUID(),
      organizationId,
      costReportId: reportId,
      createdByUserId: actor.userId,
      ...values,
    })
    .onConflictDoUpdate({ target: costReportAnomalyAlerts.costReportId, set: values });
  const saved = await getReportAnomalyAlert(organizationId, reportId);
  if (!saved) throw new Error("Failed to save report anomaly alert");
  return saved;
}

/** Remove a report's alert and its findings. False when it had none. */
export async function deleteReportAnomalyAlert(
  organizationId: string,
  reportId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(costReportAnomalyAlerts)
    .where(
      and(
        eq(costReportAnomalyAlerts.organizationId, organizationId),
        eq(costReportAnomalyAlerts.costReportId, reportId),
      ),
    )
    .returning({ id: costReportAnomalyAlerts.id });
  return deleted.length > 0;
}

/* ------------------------------------------------------------------ *
 * Detection (pure)
 * ------------------------------------------------------------------ */

export interface ReportAnomalyFinding {
  day: string;
  currency: string;
  actual: number;
  mean: number;
  threshold: number;
}

/**
 * Judge the evaluation days of one report's daily totals. `byCurrency` maps a
 * currency to its spend per day; days missing from a map spent nothing. Each
 * currency is judged on its own series (never added to another), with the
 * alert's floor in that currency's own units: the owner typed it for their
 * report, so it is not rescaled the way the org-wide USD floor is.
 */
export function findReportAnomalies(
  byCurrency: ReadonlyMap<string, ReadonlyMap<string, number>>,
  days: readonly string[],
  tuning: { sigmas: number; minDeltaCents: number },
): ReportAnomalyFinding[] {
  const options: AnomalyDetectionOptions = {
    sigmas: tuning.sigmas,
    minDeltaAbs: tuning.minDeltaCents / 100,
    minBaselineDays: MIN_BASELINE_DAYS,
    // Report alerts watch a scope's total, which has history by construction;
    // a scope that starts spending from zero is a spike against a zero
    // baseline only once it has a week of history, and before that the org's
    // own new-source detection covers it.
    minNewSourceAbs: Number.POSITIVE_INFINITY,
  };
  const findings: ReportAnomalyFinding[] = [];
  for (const [currency, byDay] of byCurrency) {
    for (const day of days) {
      const baseline = fillDailySeries(byDay, addDays(day, -BASELINE_DAYS), addDays(day, -1));
      const spike = detectSpike(baseline, byDay.get(day) ?? 0, options);
      if (spike) {
        findings.push({
          day,
          currency,
          actual: spike.actual,
          mean: spike.mean,
          threshold: spike.threshold,
        });
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ *
 * Evaluation (the poller, after an org's anomaly pass)
 * ------------------------------------------------------------------ */

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 10 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The report's daily totals per currency over `[from, to]`, in the alert's visibility. */
async function loadReportSeries(
  organizationId: string,
  config: CostGraphConfig,
  from: string,
  to: string,
): Promise<Map<string, Map<string, number>>> {
  const saved: CostFilter[] = config.savedFilterId
    ? await resolveSavedCostFilters(organizationId, config.savedFilterId)
    : [];
  const groups = await queryCosts(organizationId, {
    from,
    to,
    binning: "daily",
    groupBy: "none",
    filters: [...saved, ...(config.filters ?? [])],
    ...(config.costBasis ? { costBasis: config.costBasis } : {}),
  });
  const out = new Map<string, Map<string, number>>();
  for (const group of groups) {
    const byDay = out.get(group.currency) ?? new Map<string, number>();
    for (const p of group.points) byDay.set(p.bucket, (byDay.get(p.bucket) ?? 0) + p.amount);
    out.set(group.currency, byDay);
  }
  return out;
}

/** True when the same alert and currency was delivered within the cooldown. */
async function inCooldown(alertId: string, currency: string, day: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(costReportAnomalies)
    .where(
      and(
        eq(costReportAnomalies.alertId, alertId),
        eq(costReportAnomalies.currency, currency),
        isNotNull(costReportAnomalies.notifiedAt),
        gte(costReportAnomalies.day, addDays(day, -COOLDOWN_DAYS)),
        lt(costReportAnomalies.day, day),
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function evaluateOne(
  alert: AlertRow,
  report: { id: string; name: string; config: CostGraphConfig },
  days: string[],
): Promise<void> {
  const newest = days[days.length - 1]!;
  const from = addDays(days[0]!, -BASELINE_DAYS);
  const visibility = await resolveObjectCostVisibility(
    alert.organizationId,
    alert.visibilityUserId,
  );
  const series = await runWithCostVisibility(visibility, () =>
    loadReportSeries(alert.organizationId, report.config, from, newest),
  );
  const findings = findReportAnomalies(series, days, alert);

  for (const finding of findings) {
    const amounts = {
      actualAmount: finding.actual,
      baselineAmount: finding.mean,
      thresholdAmount: finding.threshold,
    };
    const [row] = await db
      .insert(costReportAnomalies)
      .values({
        id: randomUUID(),
        organizationId: alert.organizationId,
        alertId: alert.id,
        day: finding.day,
        currency: finding.currency,
        ...amounts,
      })
      .onConflictDoUpdate({
        target: [
          costReportAnomalies.alertId,
          costReportAnomalies.day,
          costReportAnomalies.currency,
        ],
        set: amounts,
      })
      .returning({ id: costReportAnomalies.id, notifiedAt: costReportAnomalies.notifiedAt });
    if (!row || row.notifiedAt) continue;
    if (await inCooldown(alert.id, finding.currency, finding.day)) continue;
    if (alert.destinations.length === 0) continue;

    const url = orgAppUrl(alert.organizationId, `cost-reports/${report.id}`);
    const actual = formatAmount(finding.actual, finding.currency);
    const mean = formatAmount(finding.mean, finding.currency);
    const title = `Cost anomaly in report "${report.name}"`;
    const body =
      `infrawrench spend anomaly: the scope of report "${report.name}" cost ${actual} on ` +
      `${finding.day}, against a ${mean}/day baseline over the prior ${BASELINE_DAYS} days ` +
      `(the alert fires above ${formatAmount(finding.threshold, finding.currency)}).`;
    const routed = await routeAlert(
      {
        organizationId: alert.organizationId,
        trigger: "anomalyAlerts",
        title,
        body,
        pushBody: `${report.name}: ${actual} on ${finding.day} against ${mean}/day.`,
        context: `${finding.day} · report anomaly alert`,
        url,
        pushData: {
          type: "cost_report_anomaly",
          orgId: alert.organizationId,
          reportId: report.id,
          day: finding.day,
        },
        facts: {
          amountCents: Math.round(finding.actual * 100),
          currency: finding.currency,
          key: report.name,
        },
        costVisibilityUserId: alert.visibilityUserId,
        finding: {
          sourceKind: "cost_anomaly",
          sourceId: row.id,
          title: `"${report.name}" spend spiked on ${finding.day}`,
          details: [
            { label: "Report", value: report.name },
            { label: "Day", value: finding.day },
            { label: "Spend", value: actual },
            { label: `Baseline (${BASELINE_DAYS}d mean)`, value: mean },
          ],
          appUrl: url,
        },
      },
      {
        // The alert's own destinations, as one leg that no rule can redirect,
        // swallow or hold for quiet hours (see the module note).
        pinnedLegs: [
          {
            ruleId: "default",
            ruleName: `anomaly alert on report "${report.name}"`,
            destinations: alert.destinations as AlertDestination[],
            escalation: null,
            holdUntil: null,
          },
        ],
        emailReason: `you are a destination of the anomaly alert on report "${report.name}"`,
        emailManageUrl: url,
      },
    );
    if (alertReached(routed)) {
      await db
        .update(costReportAnomalies)
        .set({ notifiedAt: new Date() })
        .where(eq(costReportAnomalies.id, row.id));
    }
  }
}

/**
 * Judge every enabled report alert in the org. Called at the end of the org's
 * anomaly pass, so it inherits that pass's cadence and its per-org rate limit.
 * Never throws: each alert records its own failure on its row and the rest
 * still run.
 */
export async function evaluateReportAnomalyAlertsForOrg(
  organizationId: string,
  now = new Date(),
): Promise<void> {
  let rows: Array<{ alert: AlertRow; reportName: string; config: unknown }>;
  try {
    rows = await db
      .select({
        alert: costReportAnomalyAlerts,
        reportName: costReports.name,
        config: costReports.config,
      })
      .from(costReportAnomalyAlerts)
      .innerJoin(costReports, eq(costReports.id, costReportAnomalyAlerts.costReportId))
      .where(
        and(
          eq(costReportAnomalyAlerts.organizationId, organizationId),
          eq(costReportAnomalyAlerts.enabled, true),
          isNull(costReports.deletedAt),
        ),
      );
  } catch (err) {
    console.error(`[report-anomaly] loading alerts failed for org ${organizationId}:`, err);
    return;
  }
  if (rows.length === 0) return;

  const newest = addDays(isoDay(now), -1);
  const days = Array.from({ length: EVALUATION_DAYS }, (_, i) =>
    addDays(newest, -(EVALUATION_DAYS - 1 - i)),
  );
  for (const { alert, reportName, config } of rows) {
    let lastError: string | null = null;
    try {
      await evaluateOne(
        alert,
        { id: alert.costReportId, name: reportName, config: config as CostGraphConfig },
        days,
      );
    } catch (err) {
      console.error(`[report-anomaly] alert ${alert.id} failed:`, err);
      lastError = err instanceof Error ? err.message : String(err);
    }
    await db
      .update(costReportAnomalyAlerts)
      .set({ lastEvaluatedAt: now, lastError })
      .where(eq(costReportAnomalyAlerts.id, alert.id))
      .catch((e: unknown) => console.error("[report-anomaly] recording outcome failed:", e));
  }
}
