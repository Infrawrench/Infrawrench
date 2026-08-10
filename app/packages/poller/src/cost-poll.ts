import { eq } from "drizzle-orm";
import { db } from "@infrawrench/server-core/db/client";
import { accounts } from "@infrawrench/server-core/db/schema";
import { collectAccountCosts, describeCostFailure } from "@infrawrench/server-core/cost/collect";
import { evaluateBudgetsForOrg } from "@infrawrench/server-core/cost/budget-eval";
import { detectCostAnomaliesForOrg } from "@infrawrench/server-core/cost/anomaly-eval";
import { evaluateCostChangeAlertsForOrg } from "@infrawrench/server-core/cost/change-eval";
import { evaluateCommitmentAlertsForOrg } from "@infrawrench/server-core/commitments/alert-eval";
import { evaluateUnitCostRegressionsForOrg } from "@infrawrench/server-core/cost/unit-cost-regression-eval";
import type { PollAccountRow } from "./poll-account";

/**
 * Cost collection runs roughly once a day per account — provider billing
 * APIs refresh daily at best and some charge per request (AWS Cost Explorer).
 * Jitter spreads the fleet so a restart doesn't stampede every account onto
 * the same tick a day later.
 */
const COST_INTERVAL_MS = 24 * 60 * 60 * 1000;
const COST_JITTER_MS = 60 * 60 * 1000;
const COST_BASE_BACKOFF_MS = 60 * 60 * 1000;
const COST_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export async function pollAccountCosts(account: PollAccountRow): Promise<void> {
  try {
    const result = await collectAccountCosts(account.id, account.organizationId);
    if (result.backfilled) {
      console.log(
        `[poller] cost backfill for ${account.id} (${account.pluginId}) ingested ${result.rowCount} rows`,
      );
    }
    const jitter = Math.floor(Math.random() * COST_JITTER_MS);
    await db
      .update(accounts)
      .set({
        costLastPolledAt: new Date(),
        costNextPollAt: new Date(Date.now() + COST_INTERVAL_MS + jitter),
        costPollFailureCount: 0,
        costPollError: null,
        costPollErrorHelpLabel: null,
        costPollErrorHelpUrl: null,
      })
      .where(eq(accounts.id, account.id));

    // Fresh cost data may cross budget thresholds — evaluate now (its own
    // errors are swallowed; it never fails the collection).
    await evaluateBudgetsForOrg(account.organizationId);

    // Same trigger point for anomaly detection: cost data only changes when
    // collection runs. This fires once per account, so for a multi-account org
    // most calls are redundant — the ClickHouse reads are the expensive half
    // and the row dedup does nothing to avoid them. detectCostAnomaliesForOrg
    // rate-limits itself per org and returns immediately when called again
    // inside that window.
    await detectCostAnomaliesForOrg(account.organizationId);

    // Change-based cost alerts ride the same trigger: configured relative
    // change on a chosen scope and cadence (vs budgets' absolute monthly
    // total and anomalies' unconfigured statistical outliers). Also
    // rate-limited per org internally, and its errors are swallowed too.
    await evaluateCostChangeAlertsForOrg(account.organizationId);

    // The two commitment alerts ride the same trigger point, for the same
    // reason: derived utilization is computed from the cost rows that just
    // landed, and the collected inventory is refreshed on the same cadence.
    // Expiry needs no cost data at all, but running it here keeps all five
    // cost alert families on one clock rather than inventing a sixth.
    // Rate-limited per org internally; its errors are swallowed too.
    await evaluateCommitmentAlertsForOrg(account.organizationId);

    // Unit-cost regressions: the numerator is the spend just collected, the
    // denominator is whatever the org has reported into `business_metric_values`.
    await evaluateUnitCostRegressionsForOrg(account.organizationId);
  } catch (e) {
    console.error(`[poller] cost collection for ${account.id} (${account.pluginId}) failed:`, e);
    const failures = account.pollFailureCount + 1;
    const backoff = Math.min(COST_BASE_BACKOFF_MS * Math.pow(2, failures - 1), COST_MAX_BACKOFF_MS);
    const { message, helpLink } = describeCostFailure(e);
    await db
      .update(accounts)
      .set({
        costLastPolledAt: new Date(),
        costNextPollAt: new Date(Date.now() + backoff),
        costPollFailureCount: failures,
        costPollError: message,
        costPollErrorHelpLabel: helpLink?.label ?? null,
        costPollErrorHelpUrl: helpLink?.url ?? null,
      })
      .where(eq(accounts.id, account.id));
  }
}
