/**
 * Read side of the three efficiency detectors: the poller writes
 * `commitment_expiry_events`, `commitment_idle_events` and
 * `unit_cost_regression_events` (server-core `commitments/alert-eval.ts` and
 * `cost/unit-cost-regression-eval.ts`); this folds them into the one feed the
 * Costs panel, the mobile app and the HTTP API render.
 *
 * Three tables, one wire type. They are separate tables because their dedup
 * keys are genuinely different (a horizon, a month, and a sliding window)
 * and forcing one events table to carry all three would mean a nullable
 * discriminated key that no unique index could enforce. They are one wire type
 * because every surface shows them in one list, and the five facts a reader
 * needs (what, when, how much, how far off, was anyone told) are the same
 * five for all three.
 *
 * The union is done in application code rather than SQL. Three small
 * `limit`-ed reads and a merge sort beat a `UNION ALL` over heterogeneous
 * column sets that would need casts on almost every column, and each table
 * already has its own `(organization_id, fired_at)` index to serve its own
 * slice.
 */
import { withholdOrgWideFindings } from "./cost-visibility-filter";
import { and, desc, eq } from "drizzle-orm";
import {
  formatUnitCostValue,
  toUnitCostScale,
  unitCostUnitLabel,
  type EfficiencyAlertEvent,
  type EfficiencyAlertKind,
} from "@infrawrench/client-core";
import { resolveRemediationCommands, type CommitmentKind } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { loadPlugins } from "../plugins/loader";
import {
  accountCommitments,
  accounts,
  businessMetrics,
  commitmentExpiryEvents,
  commitmentIdleEvents,
  unitCostRegressionEvents,
  unitCostThresholdEvents,
} from "../db/schema";

export interface ListEfficiencyAlertsOptions {
  kind?: EfficiencyAlertKind | undefined;
  limit: number;
}

/**
 * The most recent efficiency alerts, newest first.
 *
 * Each detector is read up to `limit` rows deep and the three are merged, so
 * asking for 50 always returns the 50 most recent *overall* rather than the
 * most recent of whichever detector happens to be chattiest.
 */
export async function listEfficiencyAlerts(
  organizationId: string,
  options: ListEfficiencyAlertsOptions,
): Promise<EfficiencyAlertEvent[]> {
  // Commitment and unit-cost findings are computed org-wide; withheld from a
  // cost-scoped caller for the same reason as anomalies.
  if (withholdOrgWideFindings(organizationId)) return [];
  const { kind, limit } = options;
  const wants = (k: EfficiencyAlertKind): boolean => kind === undefined || kind === k;

  const [expiry, idle, regression, threshold] = await Promise.all([
    wants("commitment_expiry")
      ? db
          .select({
            id: commitmentExpiryEvents.id,
            accountId: commitmentExpiryEvents.accountId,
            accountName: accounts.displayName,
            description: commitmentExpiryEvents.description,
            termEndDay: commitmentExpiryEvents.termEndDay,
            horizonDays: commitmentExpiryEvents.horizonDays,
            currency: commitmentExpiryEvents.currency,
            hourlyCommitmentAmount: commitmentExpiryEvents.hourlyCommitmentAmount,
            onDemandMonthlyAmount: commitmentExpiryEvents.onDemandMonthlyAmount,
            firedAt: commitmentExpiryEvents.firedAt,
            notifiedAt: commitmentExpiryEvents.notifiedAt,
          })
          .from(commitmentExpiryEvents)
          .leftJoin(accounts, eq(accounts.id, commitmentExpiryEvents.accountId))
          .where(eq(commitmentExpiryEvents.organizationId, organizationId))
          .orderBy(desc(commitmentExpiryEvents.firedAt))
          .limit(limit)
      : Promise.resolve([]),
    wants("commitment_idle")
      ? db
          .select({
            id: commitmentIdleEvents.id,
            accountId: commitmentIdleEvents.accountId,
            commitmentId: commitmentIdleEvents.commitmentId,
            accountName: accounts.displayName,
            pluginId: accountCommitments.pluginId,
            commitmentKind: accountCommitments.kind,
            commitmentScope: accountCommitments.scope,
            commitmentRegion: accountCommitments.region,
            description: commitmentIdleEvents.description,
            periodKey: commitmentIdleEvents.periodKey,
            windowFrom: commitmentIdleEvents.windowFrom,
            windowTo: commitmentIdleEvents.windowTo,
            currency: commitmentIdleEvents.currency,
            utilization: commitmentIdleEvents.utilization,
            obligationAmount: commitmentIdleEvents.obligationAmount,
            wastedAmount: commitmentIdleEvents.wastedAmount,
            measuredDays: commitmentIdleEvents.measuredDays,
            missingDays: commitmentIdleEvents.missingDays,
            firedAt: commitmentIdleEvents.firedAt,
            notifiedAt: commitmentIdleEvents.notifiedAt,
          })
          .from(commitmentIdleEvents)
          .leftJoin(accounts, eq(accounts.id, commitmentIdleEvents.accountId))
          .leftJoin(
            accountCommitments,
            and(
              eq(accountCommitments.accountId, commitmentIdleEvents.accountId),
              eq(accountCommitments.commitmentId, commitmentIdleEvents.commitmentId),
            ),
          )
          .where(eq(commitmentIdleEvents.organizationId, organizationId))
          .orderBy(desc(commitmentIdleEvents.firedAt))
          .limit(limit)
      : Promise.resolve([]),
    wants("unit_cost_regression")
      ? db
          .select({
            id: unitCostRegressionEvents.id,
            metricName: businessMetrics.name,
            metricUnit: businessMetrics.unit,
            currency: unitCostRegressionEvents.currency,
            windowFrom: unitCostRegressionEvents.windowFrom,
            windowTo: unitCostRegressionEvents.windowTo,
            previousFrom: unitCostRegressionEvents.previousFrom,
            previousTo: unitCostRegressionEvents.previousTo,
            previousUnitCost: unitCostRegressionEvents.previousUnitCost,
            currentUnitCost: unitCostRegressionEvents.currentUnitCost,
            changePercent: unitCostRegressionEvents.changePercent,
            currentSpend: unitCostRegressionEvents.currentSpend,
            firedAt: unitCostRegressionEvents.firedAt,
            notifiedAt: unitCostRegressionEvents.notifiedAt,
          })
          .from(unitCostRegressionEvents)
          .leftJoin(businessMetrics, eq(businessMetrics.id, unitCostRegressionEvents.metricId))
          .where(and(eq(unitCostRegressionEvents.organizationId, organizationId)))
          .orderBy(desc(unitCostRegressionEvents.firedAt))
          .limit(limit)
      : Promise.resolve([]),
    wants("unit_cost_threshold")
      ? db
          .select({
            id: unitCostThresholdEvents.id,
            metricName: businessMetrics.name,
            metricUnit: businessMetrics.unit,
            mode: unitCostThresholdEvents.mode,
            direction: unitCostThresholdEvents.direction,
            thresholdValue: unitCostThresholdEvents.thresholdValue,
            scale: unitCostThresholdEvents.scale,
            labelKey: unitCostThresholdEvents.labelKey,
            labelValue: unitCostThresholdEvents.labelValue,
            currency: unitCostThresholdEvents.currency,
            windowFrom: unitCostThresholdEvents.windowFrom,
            windowTo: unitCostThresholdEvents.windowTo,
            observedValue: unitCostThresholdEvents.observedValue,
            windowSpend: unitCostThresholdEvents.windowSpend,
            firedAt: unitCostThresholdEvents.firedAt,
            notifiedAt: unitCostThresholdEvents.notifiedAt,
          })
          .from(unitCostThresholdEvents)
          .leftJoin(businessMetrics, eq(businessMetrics.id, unitCostThresholdEvents.metricId))
          .where(eq(unitCostThresholdEvents.organizationId, organizationId))
          .orderBy(desc(unitCostThresholdEvents.firedAt))
          .limit(limit)
      : Promise.resolve([]),
  ]);

  // Idle commitments carry the owning plugin's commitment commands (inspect,
  // exchange, list for sale, change scope: whatever that provider offers).
  const pluginById =
    idle.length > 0
      ? new Map((await loadPlugins()).map(({ plugin }) => [plugin.manifest.id, plugin]))
      : new Map();

  const events: EfficiencyAlertEvent[] = [
    ...expiry.map((r) => ({
      id: r.id,
      kind: "commitment_expiry" as const,
      subject: r.description,
      accountId: r.accountId,
      accountName: r.accountName ?? null,
      currency: r.currency,
      // The exposure, falling back to the commitment's own monthly price. Both
      // may be absent (a unit-denominated CUD states no money at all) and
      // null renders as "not reported" rather than as free.
      amount:
        r.onDemandMonthlyAmount ??
        (r.hourlyCommitmentAmount !== null ? r.hourlyCommitmentAmount * 24 * 30.4 : null),
      detail: {
        termEndDay: r.termEndDay,
        horizonDays: r.horizonDays,
        hourlyCommitmentAmount: r.hourlyCommitmentAmount,
        onDemandMonthlyAmount: r.onDemandMonthlyAmount,
      },
      firedAt: r.firedAt.toISOString(),
      notifiedAt: r.notifiedAt?.toISOString() ?? null,
    })),
    ...idle.map((r) => ({
      id: r.id,
      kind: "commitment_idle" as const,
      subject: r.description,
      accountId: r.accountId,
      accountName: r.accountName ?? null,
      currency: r.currency,
      amount: r.wastedAmount,
      detail: {
        periodKey: r.periodKey,
        windowFrom: r.windowFrom,
        windowTo: r.windowTo,
        utilizationPercent: Math.round(r.utilization * 100),
        obligationAmount: r.obligationAmount,
        measuredDays: r.measuredDays,
        missingDays: r.missingDays,
      },
      firedAt: r.firedAt.toISOString(),
      notifiedAt: r.notifiedAt?.toISOString() ?? null,
      remediation:
        r.pluginId && r.commitmentKind
          ? resolveRemediationCommands(pluginById.get(r.pluginId), {
              kind: "idle-commitment",
              commitment: {
                id: r.commitmentId,
                kind: r.commitmentKind as CommitmentKind,
                description: r.description,
                scope: r.commitmentScope,
                region: r.commitmentRegion,
              },
            })
          : null,
    })),
    ...regression.map((r) => ({
      id: r.id,
      kind: "unit_cost_regression" as const,
      // The metric is cascade-deleted with its events, so a null name here can
      // only mean a row read mid-delete; naming it rather than dropping the
      // row keeps the list stable.
      subject: r.metricName ?? "(deleted metric)",
      accountId: null,
      accountName: null,
      currency: r.currency,
      amount: r.currentSpend,
      detail: {
        unit: r.metricUnit ?? null,
        windowFrom: r.windowFrom,
        windowTo: r.windowTo,
        previousFrom: r.previousFrom,
        previousTo: r.previousTo,
        previousUnitCost: r.previousUnitCost,
        currentUnitCost: r.currentUnitCost,
        changePercent: r.changePercent,
      },
      firedAt: r.firedAt.toISOString(),
      notifiedAt: r.notifiedAt?.toISOString() ?? null,
    })),
    ...threshold.map((r) => {
      const unit = r.metricUnit || "unit";
      const scale = toUnitCostScale(r.scale);
      const isMargin = r.mode === "margin";
      const display = (value: number): string =>
        isMargin
          ? `${value.toFixed(1)}%`
          : `${formatUnitCostValue(value, "unit_cost")} ${unitCostUnitLabel({ unit }, "unit_cost", r.currency, scale)}`;
      return {
        id: r.id,
        kind: "unit_cost_threshold" as const,
        subject: r.metricName ?? "(deleted metric)",
        accountId: null,
        accountName: null,
        currency: r.currency,
        amount: r.windowSpend,
        detail: {
          mode: r.mode,
          direction: r.direction,
          unit,
          scale,
          thresholdValue: r.thresholdValue,
          observedValue: r.observedValue,
          // Pre-formatted so every surface (web, desktop, mobile, CLI) states the
          // limit and the reading in the same words and the same precision.
          thresholdDisplay: display(r.thresholdValue),
          observedDisplay: display(r.observedValue),
          labelKey: r.labelKey || null,
          labelValue: r.labelKey ? r.labelValue : null,
          windowFrom: r.windowFrom,
          windowTo: r.windowTo,
        },
        firedAt: r.firedAt.toISOString(),
        notifiedAt: r.notifiedAt?.toISOString() ?? null,
      };
    }),
  ];

  events.sort((a, b) => b.firedAt.localeCompare(a.firedAt) || a.id.localeCompare(b.id));
  return events.slice(0, limit);
}
