/**
 * The poller's network-flow pass.
 *
 * Structurally the credits/commitments pass: a side table doubles as the claim
 * lease, N replicas claim disjoint rows — here by writing the lease only if the
 * row is still due, see `claimDueNetworkFlowAccounts` — and a replica that dies
 * mid-work simply lets the row come due again at lease expiry. Three things
 * differ, all because the work costs the *customer* money:
 *
 * - **The org's switch is in the claim predicate**, not only in the collector.
 *   An org that has not opted in is never claimed, so a bug in the collector
 *   can never run a billable query for them.
 * - **The batch is tiny.** `NETWORK_FLOWS_PER_TICK` accounts per tick, three
 *   days each. Cost collection can afford to be greedy because a Cost Explorer
 *   call is free; a Logs Insights scan is not.
 * - **The lease is held for as long as the collection runs, not for a fixed
 *   window.** Every other pass here sizes its lease at a guess of the
 *   worst-case run and accepts that an overrun means someone else redoing the
 *   work; the worst case for this one is hours, and redoing the work is a
 *   charge on the customer's bill. See `./lease.ts` — a renewing lease is what
 *   makes the exclusivity below mean anything past the first thirty minutes.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client";
import { accountNetworkFlowPolls } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { NetworkFlowSetupError } from "@infrawrench/plugin-base";

import { collectAccountNetworkFlows, type NetworkFlowCollectionResult } from "./collect";
import { NETWORK_FLOW_LEASE_MS, NetworkFlowLeaseLostError, startNetworkFlowLease } from "./lease";

export {
  NETWORK_FLOW_HEARTBEAT_MS,
  NETWORK_FLOW_LEASE_MS,
  NETWORK_FLOW_MAX_RUNTIME_MS,
} from "./lease";

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
  /**
   * The lease deadline this claim wrote, to the millisecond.
   *
   * Not decoration: it is the token every renewal compares against, so a holder
   * whose lease lapsed can tell "still mine" from "somebody else's now" rather
   * than blindly pushing the column forward. Null only if the claim's
   * `RETURNING` lost the column, which the claim test pins against.
   */
  leaseExpiresAt: Date | undefined;
}

/**
 * Claim due accounts. Only accounts whose plugin can report flows *and* whose
 * org has switched collection on are eligible.
 *
 * **The claim is exclusive, and that is the whole point of the predicate on the
 * conflict.** The `SELECT` half reads a snapshot, so two replicas ticking at the
 * same moment both see the same account as due and both reach the upsert. An
 * unconditional `DO UPDATE` would then re-lease and *return* the row to both of
 * them, and each would run the flow-log query — which the provider bills to the
 * customer's own account, per gigabyte scanned. Postgres re-checks the
 * `DO UPDATE`'s `WHERE` against the latest committed version of the conflicting
 * row while holding a lock on it, so the loser of the race sees the winner's
 * lease, updates nothing, and therefore returns nothing.
 *
 * **The winner is handed the deadline it wrote**, because exclusivity at the
 * moment of the claim is only half of it: the collection that follows outlives
 * a fixed lease easily, and the same predicate that keeps a second replica out
 * now will let it in the moment the lease lapses. `./lease.ts` renews against
 * that deadline for as long as the collection runs. `date_trunc` to
 * milliseconds so the value survives the round trip through a JS `Date`, and
 * the epoch-millisecond alias so it is read back on the same clock and calendar
 * as drizzle would map it, whatever the connection's time zone.
 */
export async function claimDueNetworkFlowAccounts(
  limit: number,
  flowCapablePluginIds: string[],
): Promise<ClaimedNetworkFlowAccount[]> {
  if (flowCapablePluginIds.length === 0) return [];
  const rows = await db.execute(sql`
    INSERT INTO account_network_flow_polls (account_id, organization_id, next_poll_at)
    SELECT a.id, a.organization_id,
           date_trunc('milliseconds', now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond')
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
      SET next_poll_at = date_trunc('milliseconds', now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond')
      -- Re-checked against the row as it stands now, not as the SELECT saw it.
      -- Without this the update is unconditional and a racing replica gets the
      -- same account back — see the doc comment.
      WHERE account_network_flow_polls.next_poll_at IS NULL
         OR account_network_flow_polls.next_poll_at <= now()
    RETURNING account_id, organization_id, failure_count,
              floor(extract(epoch from next_poll_at) * 1000) AS next_poll_at_ms
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => {
    const ms = r["next_poll_at_ms"];
    return {
      accountId: String(r["account_id"]),
      organizationId: String(r["organization_id"]),
      failureCount: Number(r["failure_count"]),
      leaseExpiresAt: ms === null || ms === undefined ? undefined : new Date(Number(ms)),
    };
  });
}

function jittered(base: number, jitter: number): Date {
  return new Date(Date.now() + base + Math.floor(Math.random() * jitter));
}

/**
 * The pass's terminal write, addressed so that it can only land on a row this
 * replica still holds.
 *
 * The lease deadline is the fence. A collection that overran badly enough to
 * lose the lease — the heartbeat could not reach the database for a whole lease
 * period, say — would otherwise finish and write its reschedule over the top of
 * whichever replica has the account now, releasing a lease that is not ours to
 * release. Matching zero rows is the correct outcome there: the new holder
 * records the run it actually performed.
 *
 * `expiresAt` is null only when the claim did not hand back a deadline, in
 * which case there is nothing to fence with and the write is unconditional,
 * exactly as it was before renewal existed.
 */
function fencedWhere(claimed: ClaimedNetworkFlowAccount, expiresAt: Date | null) {
  const where = and(
    eq(accountNetworkFlowPolls.accountId, claimed.accountId),
    eq(accountNetworkFlowPolls.organizationId, claimed.organizationId),
  );
  if (!expiresAt) return where;
  return and(where, eq(accountNetworkFlowPolls.nextPollAt, expiresAt));
}

async function runOne(claimed: ClaimedNetworkFlowAccount): Promise<void> {
  const lease = startNetworkFlowLease(
    claimed.accountId,
    claimed.organizationId,
    claimed.leaseExpiresAt ?? null,
  );

  let result: NetworkFlowCollectionResult;
  try {
    result = await collectAccountNetworkFlows(claimed.accountId, claimed.organizationId, { lease });
  } catch (e) {
    // Before anything else: the heartbeat must not outlive the work it was
    // guarding, and the fence below has to read a deadline that has stopped
    // moving.
    lease.stop();
    if (e instanceof NetworkFlowLeaseLostError) {
      // Deliberately no write at all. The row belongs to whichever replica
      // claimed it after our lease lapsed; recording a failure here would
      // clobber its lease and count a collision against the account's backoff.
      console.warn(`[network-flow] ${e.message}`);
      return;
    }
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
      .where(fencedWhere(claimed, lease.expiresAt));
    console.error(`[network-flow] account ${claimed.accountId} failed:`, message);
    return;
  }

  lease.stop();
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
    .where(fencedWhere(claimed, lease.expiresAt));
  if (result.daysCollected > 0) {
    console.log(
      `[network-flow] account ${claimed.accountId}: ${result.daysCollected} day(s), ` +
        `${result.rowsWritten} row(s), ${result.droppedPairs} pair(s) below the cap` +
        (result.degraded ? " (degraded)" : ""),
    );
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
