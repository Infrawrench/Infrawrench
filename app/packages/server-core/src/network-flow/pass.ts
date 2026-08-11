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
 *   window, and the collection spends only against the part of it the database
 *   has acknowledged.** Every other pass here sizes its lease at a guess of the
 *   worst-case run and accepts that an overrun means someone else redoing the
 *   work; the worst case for this one is hours, and redoing the work is a
 *   charge on the customer's bill. See `./lease.ts` — a renewing lease is what
 *   makes the exclusivity below mean anything past the first thirty minutes,
 *   and authorizing work against the last *confirmed* renewal rather than
 *   against elapsed time is what keeps that true when the database goes quiet.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client";
import { accountNetworkFlowPolls } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { NetworkFlowSetupError } from "@infrawrench/plugin-base";

import { collectAccountNetworkFlows, type NetworkFlowCollectionResult } from "./collect";
import {
  NETWORK_FLOW_LEASE_MS,
  NetworkFlowLeaseLostError,
  startNetworkFlowLease,
  type NetworkFlowLease,
} from "./lease";

export {
  NETWORK_FLOW_HEARTBEAT_MS,
  NETWORK_FLOW_LEASE_MS,
  NETWORK_FLOW_LEASE_RESERVE_MS,
  NETWORK_FLOW_MAX_RUNTIME_MS,
  NETWORK_FLOW_MIN_WORK_WINDOW_MS,
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
   * The owner token this claim wrote.
   *
   * Not decoration: it is what every renewal and every write to the row is
   * matched against, so a holder whose lease lapsed can tell "still mine" from
   * "somebody else's now" rather than blindly pushing the column forward. It
   * identifies the claim rather than its state, which is what makes that answer
   * survive a renewal whose outcome this process never learned — see
   * `./lease.ts`. Undefined only if the claim's `RETURNING` lost the column,
   * which the claim test pins against.
   */
  leaseOwner: string | undefined;
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
 * **The winner is handed an owner token**, because exclusivity at the moment of
 * the claim is only half of it: the collection that follows outlives a fixed
 * lease easily, and the same predicate that keeps a second replica out now will
 * let it in the moment the lease lapses. `./lease.ts` renews for as long as the
 * collection runs, matching on that token. It is minted per claim rather than
 * per process, so a replica that loses an account and later re-claims it cannot
 * present the identity it held the first time; one token covers every row in
 * one statement because a renewal names its account too, and the accounts in a
 * batch are distinct by construction.
 */
export async function claimDueNetworkFlowAccounts(
  limit: number,
  flowCapablePluginIds: string[],
): Promise<ClaimedNetworkFlowAccount[]> {
  if (flowCapablePluginIds.length === 0) return [];
  const owner = randomUUID();
  const rows = await db.execute(sql`
    INSERT INTO account_network_flow_polls (account_id, organization_id, next_poll_at, lease_owner)
    SELECT a.id, a.organization_id,
           now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond',
           -- Cast, because a bare placeholder in the select list of an
           -- INSERT … SELECT has no column to take its type from.
           ${owner}::text
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
      SET next_poll_at = now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond',
          -- Taking the account over means taking its identity over: whatever
          -- replica held it before now matches nothing, renews nothing and
          -- writes nothing.
          lease_owner = ${owner}::text
      -- Re-checked against the row as it stands now, not as the SELECT saw it.
      -- Without this the update is unconditional and a racing replica gets the
      -- same account back — see the doc comment.
      WHERE account_network_flow_polls.next_poll_at IS NULL
         OR account_network_flow_polls.next_poll_at <= now()
    RETURNING account_id, organization_id, failure_count, lease_owner
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => {
    const claimedBy = r["lease_owner"];
    return {
      accountId: String(r["account_id"]),
      organizationId: String(r["organization_id"]),
      failureCount: Number(r["failure_count"]),
      leaseOwner: claimedBy === null || claimedBy === undefined ? undefined : String(claimedBy),
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
 * The lease's owner token is the fence. A collection that overran badly enough
 * to lose the lease — the heartbeat could not reach the database for a whole
 * lease period, say — would otherwise finish and write its reschedule over the
 * top of whichever replica has the account now, releasing a lease that is not
 * ours to release. Matching zero rows is the correct outcome there: the new
 * holder records the run it actually performed.
 *
 * **The fence is the claim's identity, not any value the lease has been
 * moving.** Fencing on the deadline instead meant fencing on the column the
 * heartbeat rewrites every ten minutes, so the write only landed if this
 * process had correctly tracked every renewal — and one whose answer was lost
 * left it tracking a deadline the row had stopped having, which silently
 * dropped the reschedule and re-ran the whole customer-billed scan. The token
 * moves only when the account is claimed by somebody else, so there is nothing
 * to keep in step and no window in which to be wrong.
 *
 * The token is null only when the claim did not hand one back, in which case
 * there is nothing to fence with and the write is unconditional, exactly as it
 * was before renewal existed.
 */
function fencedWhere(claimed: ClaimedNetworkFlowAccount, lease: NetworkFlowLease) {
  const where = and(
    eq(accountNetworkFlowPolls.accountId, claimed.accountId),
    eq(accountNetworkFlowPolls.organizationId, claimed.organizationId),
  );
  const owner = lease.owner;
  if (!owner) return where;
  return and(where, eq(accountNetworkFlowPolls.leaseOwner, owner));
}

async function runOne(claimed: ClaimedNetworkFlowAccount, claimedAt: number): Promise<void> {
  const lease = startNetworkFlowLease(
    claimed.accountId,
    claimed.organizationId,
    claimed.leaseOwner ?? null,
    { claimedAt },
  );

  let result: NetworkFlowCollectionResult;
  try {
    result = await collectAccountNetworkFlows(claimed.accountId, claimed.organizationId, { lease });
  } catch (e) {
    // Before anything else: the heartbeat must not outlive the work it was
    // guarding — hence awaiting, which also waits out a renewal in flight so
    // this pass leaves no write of its own behind it.
    await lease.stop();
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
        // Releasing the lease is part of the same write that ends the pass.
        // See below.
        leaseOwner: null,
        failureCount: failures,
        lastError: message.slice(0, 1000),
        lastErrorHelpUrl: setup ? ((e as NetworkFlowSetupError).helpUrl ?? null) : null,
      })
      .where(fencedWhere(claimed, lease));
    console.error(`[network-flow] account ${claimed.accountId} failed:`, message);
    return;
  }

  // Awaited for the same reason as above: nothing this lease started should
  // still be on its way to the database once the pass has released the account.
  await lease.stop();
  await db
    .update(accountNetworkFlowPolls)
    .set({
      lastPolledAt: new Date(),
      nextPollAt: jittered(NETWORK_FLOW_INTERVAL_MS, NETWORK_FLOW_JITTER_MS),
      // Handing the lease back in the same statement that schedules tomorrow.
      // The two belong together: `next_poll_at` stops being a lease and goes
      // back to being a due time at exactly this point, and clearing the token
      // is what makes that stick — a renewal that escaped `stop()` because its
      // answer was lost, and which the database may still apply, now matches
      // nothing and cannot put a lease back over tomorrow's schedule.
      leaseOwner: null,
      failureCount: 0,
      lastError: null,
      lastErrorHelpUrl: null,
      lastSources: result.sources,
      lastQueryBytesScanned: Math.min(result.queryBytesScanned, 2_147_483_647),
    })
    .where(fencedWhere(claimed, lease));
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
  // Read before the claim is sent, and handed to every lease it hands back.
  // The lease each row is held under expires a fixed period after the database
  // ran this statement, so the earliest instant this process can prove that
  // statement had not yet run is the only honest anchor for the deadline it
  // wrote — see `startNetworkFlowLease`. Taking it afterwards would credit the
  // lease with the round trip.
  const claimedAt = Date.now();
  const claimed = await claimDueNetworkFlowAccounts(
    opts.limit ?? NETWORK_FLOWS_PER_TICK,
    flowCapable,
  );
  if (claimed.length === 0) return { claimed: 0 };
  await Promise.allSettled(claimed.map((row) => runOne(row, claimedAt)));
  return { claimed: claimed.length };
}
