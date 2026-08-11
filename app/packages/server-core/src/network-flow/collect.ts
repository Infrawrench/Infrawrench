/**
 * Collecting one account's network flows.
 *
 * The pass is **forward-only**: it collects whole closed UTC days, advances a
 * watermark past each one, and never comes back. Cost collection re-fetches a
 * trailing restatement window because providers restate billing data; flow logs
 * do not restate, and re-querying a settled day costs the customer another scan
 * of the same records for a byte-identical answer.
 *
 * A day is only collected once the day is *over*. Flow-log delivery lags real
 * time (AWS: ~5 minutes to CloudWatch Logs, ~10 to S3), so the last day we ever
 * ask about is yesterday, UTC. Asking about today returns a partial day that
 * would then be watermarked as complete.
 */
import {
  normalizeNetworkFlowResult,
  NetworkFlowSetupError,
  type NetworkFlowCapabilityDeclaration,
} from "@infrawrench/plugin-base";
import { and, eq } from "drizzle-orm";

import { insertNetworkFlowRows, toNetworkFlowRows } from "../clickhouse/network-flow-writers";
import { db } from "../db/client";
import { accountNetworkFlowPolls } from "../db/schema";
import { loadAccountClient } from "../sync-resources";
import { addDays, isoDay } from "../cost/dates";

import { aggregateNetworkFlows, DEFAULT_MAX_PAIRS } from "./aggregate";
import { getNetworkFlowSettings } from "./settings";

/**
 * Days collected in one pass.
 *
 * Small on purpose. Each day is one or more billable provider queries, and a
 * pass that tried to catch up thirty days at once would land thirty days of
 * scan charges on the customer in a single tick with no chance to notice. Three
 * days per daily pass still closes a week-long gap inside three days.
 */
export const MAX_DAYS_PER_PASS = 3;

export interface NetworkFlowCollectionResult {
  daysCollected: number;
  rowsWritten: number;
  /** Bytes the provider billed the customer for this pass's queries. */
  queryBytesScanned: number;
  /** Distinct pairs the host dropped below the storage cap, summed over days. */
  droppedPairs: number;
  /** True when at least one day came back flagged degraded by the plugin. */
  degraded: boolean;
  sources: ReturnType<typeof normalizeNetworkFlowResult>["sources"];
}

/**
 * Collect flows for one account. Throws on failure — the caller (the poller
 * pass) owns backoff and reschedule, exactly as `collectAccountCosts` does.
 */
export async function collectAccountNetworkFlows(
  accountId: string,
  organizationId: string,
  options: { now?: Date; maxPairs?: number } = {},
): Promise<NetworkFlowCollectionResult> {
  const settings = await getNetworkFlowSettings(organizationId);
  if (!settings.enabled) {
    // The claim query already filters on this, so reaching here means the org
    // turned collection off between the claim and the run. Stopping is the
    // right answer: the next thing this function does costs them money.
    return {
      daysCollected: 0,
      rowsWritten: 0,
      queryBytesScanned: 0,
      droppedPairs: 0,
      degraded: false,
      sources: [],
    };
  }

  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);
  const capability: NetworkFlowCapabilityDeclaration | undefined = plugin.manifest.networkFlows;
  if (!capability || !client.fetchNetworkFlows) {
    throw new NetworkFlowSetupError(
      `Plugin "${account.pluginId}" does not support network flow collection`,
    );
  }

  const now = options.now ?? new Date();
  const yesterday = addDays(isoDay(now), -1);

  const existing = await db
    .select({ collectedThrough: accountNetworkFlowPolls.collectedThrough })
    .from(accountNetworkFlowPolls)
    .where(eq(accountNetworkFlowPolls.accountId, accountId))
    .limit(1);

  // The oldest day we are willing to ask for: never further back than the
  // plugin says it can answer, because a query beyond the source's retention
  // still scans and still bills.
  const horizon = addDays(yesterday, -(capability.maxHistoryDays - 1));
  const watermark = existing[0]?.collectedThrough ?? null;
  let cursor = watermark
    ? addDays(String(watermark), 1)
    : addDays(yesterday, -(settings.initialLookbackDays - 1));
  if (cursor < horizon) cursor = horizon;

  const days: string[] = [];
  while (cursor <= yesterday && days.length < MAX_DAYS_PER_PASS) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const result: NetworkFlowCollectionResult = {
    daysCollected: 0,
    rowsWritten: 0,
    queryBytesScanned: 0,
    droppedPairs: 0,
    degraded: false,
    sources: [],
  };
  if (days.length === 0) return result;

  const maxPairs = Math.min(options.maxPairs ?? DEFAULT_MAX_PAIRS, capability.maxPairsPerDay);

  for (const day of days) {
    const answer = normalizeNetworkFlowResult(await client.fetchNetworkFlows(accountId, { day }));
    result.sources = answer.sources;
    if (answer.degraded) result.degraded = true;
    if (answer.queryBytesScanned) result.queryBytesScanned += answer.queryBytesScanned;

    const aggregated = aggregateNetworkFlows(
      day,
      { flows: answer.flows, totals: answer.totals, rates: capability.rates },
      { maxPairs },
    );
    result.droppedPairs += aggregated.droppedPairs;

    if (aggregated.rows.length > 0) {
      await insertNetworkFlowRows(
        toNetworkFlowRows(
          { organizationId, accountId, pluginId: account.pluginId },
          aggregated.rows,
        ),
      );
      result.rowsWritten += aggregated.rows.length;
    }

    // The watermark advances even for a day that produced no rows, and that is
    // the point of a watermark rather than a "last row written" check: a
    // genuinely quiet day is collected, and re-asking about it every tick
    // forever would bill the customer for the privilege of learning nothing
    // twice.
    await db
      .update(accountNetworkFlowPolls)
      .set({ collectedThrough: day })
      .where(
        and(
          eq(accountNetworkFlowPolls.accountId, accountId),
          eq(accountNetworkFlowPolls.organizationId, organizationId),
        ),
      );
    result.daysCollected += 1;
  }

  return result;
}
