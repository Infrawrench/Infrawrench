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
  type NetworkFlowFetchResult,
  type NetworkFlowRecord,
} from "@infrawrench/plugin-base";
import { and, eq } from "drizzle-orm";

import { insertNetworkFlowRows, toNetworkFlowRows } from "../clickhouse/network-flow-writers";
import { db } from "../db/client";
import { accountNetworkFlowPolls } from "../db/schema";
import { loadAccountClient } from "../sync-resources";
import { addDays, isoDay } from "../cost/dates";

import { aggregateNetworkFlows, DEFAULT_MAX_PAIRS } from "./aggregate";
import type { NetworkFlowLeaseGate } from "./lease";
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
 *
 * `lease`, when supplied, is the claim that entitles this process to spend the
 * customer's money. It is consulted immediately before each day's provider
 * query rather than once at the start, *and* travels into the query itself, so
 * that a day which outlives the entitlement it began under stops rather than
 * finishing on somebody else's claim. See `./lease.ts`; the pass always
 * supplies one, and callers that are not the pass (tests, one-off backfills)
 * can leave it out and run unguarded because nothing else is competing for the
 * account.
 */
export async function collectAccountNetworkFlows(
  accountId: string,
  organizationId: string,
  options: { now?: Date; maxPairs?: number; lease?: NetworkFlowLeaseGate } = {},
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
    // The gate in front of the money. Every iteration of this loop is at least
    // one provider query the customer is billed for, and `MAX_DAYS_PER_PASS`
    // bounds how many of them there are but not how long they take — a day is a
    // serial walk over every usable flow log on the account, each one a query
    // with its own multi-minute timeout, so a single day can outlast the lease
    // it was started under. Asking here means the lease is re-asserted against
    // the database immediately before each spend, and answered against the last
    // deadline the database actually acknowledged: a pass that is out of
    // authorized time — its runtime budget spent, or its lease no longer
    // confirmed far enough ahead — stops with its watermark intact and the rest
    // of the backlog waits for the next pass, and a pass that has lost the
    // lease outright throws rather than scanning days a second replica is
    // already scanning.
    if (options.lease && !(await options.lease.checkpoint())) {
      console.log(
        `[network-flow] account ${accountId}: out of authorized time after ` +
          `${result.daysCollected} day(s), ${days.length - result.daysCollected} left for next time`,
      );
      break;
    }

    // And the gate that travels with the money: a day is not a bounded unit, so
    // the entitlement is handed to the plugin rather than only checked before
    // it. It is withdrawn if the lease is lost, or if the last deadline this
    // process could confirm is about to pass — see `./lease.ts`.
    let fetched: NetworkFlowRecord[] | NetworkFlowFetchResult;
    try {
      fetched = await client.fetchNetworkFlows(accountId, {
        day,
        ...(options.lease ? { signal: options.lease.signal } : {}),
      });
    } catch (e) {
      // A day we cut short is not a failing account, so it must not be reported
      // as one: no backoff, no `last_error`, nothing counted against it. The
      // pass simply ends here.
      if (!options.lease?.signal.aborted) throw e;
      console.log(
        `[network-flow] account ${accountId}: authorization withdrawn during ${day}, ` +
          `stopping after ${result.daysCollected} complete day(s)`,
      );
      break;
    }

    // A plugin that swallowed the abort and answered anyway has answered from a
    // partial scan, and a partial day recorded as collected is permanent: the
    // watermark moves past it and this pass is forward-only, so the missing
    // bytes are never asked for again. Dropping the answer costs whatever the
    // interrupted scan cost; keeping it costs a number that is quietly wrong
    // forever.
    if (options.lease?.signal.aborted) {
      console.warn(
        `[network-flow] account ${accountId}: discarding ${day} — the plugin answered after ` +
          `authorization was withdrawn, so the day is incomplete`,
      );
      break;
    }

    const answer = normalizeNetworkFlowResult(fetched);
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
