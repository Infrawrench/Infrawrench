/**
 * The poller's network-flow pass.
 *
 * Structurally the credits/commitments pass: a side table doubles as the claim
 * lease, N replicas claim disjoint rows with `FOR UPDATE SKIP LOCKED`, and a
 * replica that dies mid-work simply lets the row come due again at lease
 * expiry. Two things differ, both because the work costs the *customer* money:
 *
 * - **The org's switch is in the claim predicate**, not only in the collector.
 *   An org that has not opted in is never claimed, so a bug in the collector
 *   can never run a billable query for them.
 * - **The batch is tiny.** `NETWORK_FLOWS_PER_TICK` accounts per tick, three
 *   days each. Cost collection can afford to be greedy because a Cost Explorer
 *   call is free; a Logs Insights scan is not.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client";
import { accountNetworkFlowPolls } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { NetworkFlowSetupError } from "@infrawrench/plugin-base";

import { collectAccountNetworkFlows } from "./collect";

/** Lease written into `next_poll_at` by the claim. Generous: days are slow. */
export const NETWORK_FLOW_LEASE_MS = 30 * 60 * 1000;
/** Nominal cadence — once a day, plus jitter so orgs don't stampede. */
export const NETWORK_FLOW_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const NETWORK_FLOW_JITTER_MS = 60 * 60 * 1000;
export const NETWORK_FLOW_BASE_BACKOFF_MS = 60 * 60 * 1000;
export const NETWORK_FLOW_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
/**
 * How long to wait after a *setup* failure — no flow logs, an unreadable
 * destination, a missing permission. Much longer than the transient backoff:
 * nothing about the account will change until a human changes it, and retrying
 * a setup gap hourly is a request the provider still charges to answer.
 */
export const NETWORK_FLOW_SETUP_BACKOFF_MS = 12 * 60 * 60 * 1000;
export const NETWORK_FLOWS_PER_TICK = 2;

export interface ClaimedNetworkFlowAccount {
  accountId: string;
  organizationId: string;
  failureCount: number;
}

/**
 * Claim due accounts. Only accounts whose plugin can report flows *and* whose
 * org has switched collection on are eligible.
 */
export async function claimDueNetworkFlowAccounts(
  limit: number,
  flowCapablePluginIds: string[],
): Promise<ClaimedNetworkFlowAccount[]> {
  if (flowCapablePluginIds.length === 0) return [];
  const rows = await db.execute(sql`
    INSERT INTO account_network_flow_polls (account_id, organization_id, next_poll_at)
    SELECT a.id, a.organization_id,
           now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond'
    FROM accounts a
    JOIN org_network_flow_settings s ON s.organization_id = a.organization_id
    LEFT JOIN account_network_flow_polls p ON p.account_id = a.id
    WHERE a.deleted_at IS NULL
      AND s.enabled = true
      -- IN, not = ANY(): the sql tag expands a JS array into a parenthesized
      -- placeholder list, which is what IN takes. See claimDueCostAccounts.
      AND a.plugin_id IN ${flowCapablePluginIds}
      AND (p.account_id IS NULL OR p.next_poll_at IS NULL OR p.next_poll_at <= now())
    ORDER BY p.last_polled_at ASC NULLS FIRST, a.id ASC
    LIMIT ${limit}
    ON CONFLICT (account_id) DO UPDATE
      SET next_poll_at = now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond'
    RETURNING account_id, organization_id, failure_count
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    accountId: String(r["account_id"]),
    organizationId: String(r["organization_id"]),
    failureCount: Number(r["failure_count"]),
  }));
}

function jittered(base: number, jitter: number): Date {
  return new Date(Date.now() + base + Math.floor(Math.random() * jitter));
}

async function runOne(claimed: ClaimedNetworkFlowAccount): Promise<void> {
  const where = and(
    eq(accountNetworkFlowPolls.accountId, claimed.accountId),
    eq(accountNetworkFlowPolls.organizationId, claimed.organizationId),
  );
  try {
    const result = await collectAccountNetworkFlows(claimed.accountId, claimed.organizationId);
    await db
      .update(accountNetworkFlowPolls)
      .set({
        lastPolledAt: new Date(),
        nextPollAt: jittered(NETWORK_FLOW_INTERVAL_MS, NETWORK_FLOW_JITTER_MS),
        failureCount: 0,
        lastError: null,
        lastErrorHelpUrl: null,
        lastSources: result.sources,
        lastQueryBytesScanned: Math.min(result.queryBytesScanned, 2_147_483_647),
      })
      .where(where);
    if (result.daysCollected > 0) {
      console.log(
        `[network-flow] account ${claimed.accountId}: ${result.daysCollected} day(s), ` +
          `${result.rowsWritten} row(s), ${result.droppedPairs} pair(s) below the cap` +
          (result.degraded ? " (degraded)" : ""),
      );
    }
  } catch (e) {
    const setup = e instanceof NetworkFlowSetupError;
    const message = e instanceof Error ? e.message : String(e);
    const failures = claimed.failureCount + 1;
    const backoff = setup
      ? NETWORK_FLOW_SETUP_BACKOFF_MS
      : Math.min(NETWORK_FLOW_BASE_BACKOFF_MS * 2 ** (failures - 1), NETWORK_FLOW_MAX_BACKOFF_MS);
    await db
      .update(accountNetworkFlowPolls)
      .set({
        lastPolledAt: new Date(),
        nextPollAt: jittered(backoff, NETWORK_FLOW_JITTER_MS),
        failureCount: failures,
        lastError: message.slice(0, 1000),
        lastErrorHelpUrl: setup ? ((e as NetworkFlowSetupError).helpUrl ?? null) : null,
      })
      .where(where);
    console.error(`[network-flow] account ${claimed.accountId} failed:`, message);
  }
}

/**
 * One network-flow tick. Every account is individually guarded — one failure
 * never blocks the rest of the batch, and nothing here throws into the tick.
 */
export async function runNetworkFlowPass(
  opts: { limit?: number } = {},
): Promise<{ claimed: number }> {
  const loaded = await loadPlugins();
  const flowCapable = loaded
    .filter((l) => l.plugin.manifest.networkFlows)
    .map((l) => l.plugin.manifest.id);
  const claimed = await claimDueNetworkFlowAccounts(
    opts.limit ?? NETWORK_FLOWS_PER_TICK,
    flowCapable,
  );
  if (claimed.length === 0) return { claimed: 0 };
  await Promise.allSettled(claimed.map((row) => runOne(row)));
  return { claimed: claimed.length };
}
