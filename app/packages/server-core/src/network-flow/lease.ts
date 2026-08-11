/**
 * The network-flow claim's lease, kept alive for as long as the collection it
 * guards is still running.
 *
 * `claimDueNetworkFlowAccounts` is exclusive: two replicas ticking together
 * cannot both be handed the same account. But exclusivity is only worth
 * anything for as long as the claim lasts, and the claim lasts exactly
 * {@link NETWORK_FLOW_LEASE_MS}. The work under it is not bounded by anything
 * close to that — one account's pass is up to `MAX_DAYS_PER_PASS` days, each
 * day a serial walk over every usable flow log the account has, each flow log
 * two Logs Insights queries with their own multi-minute timeouts. The
 * arithmetic runs to hours. When the lease lapses under a still-running
 * collection, the due-ness predicate does exactly what it is supposed to do and
 * hands the account to a second replica — which then starts the same scans, and
 * a Logs Insights scan is billed to the *customer's* cloud account per gigabyte.
 * A lapsed lease here is a duplicate charge on somebody else's bill.
 *
 * So the lease is renewed as the collection progresses, and the renewal is a
 * **compare-and-swap against the lease's identity, not against its deadline**.
 * That distinction is the whole safety property:
 *
 * - Every claim mints a fresh owner token and writes it beside the deadline.
 *   Renewals update the row only `WHERE lease_owner` is still this holder's
 *   token, so a replica whose lease already lapsed — and whose account another
 *   replica has since claimed under a token of its own — matches no row, learns
 *   it lost, and stops. An unconditional `SET next_poll_at = now() + lease`
 *   would instead *extend the new holder's lease on the old holder's behalf*,
 *   which is the same overlap one layer further down.
 * - **The token is fixed for the life of the claim, and the deadline is not.**
 *   That is why the token exists. Matching on `next_poll_at` made the lease's
 *   identity the very value each renewal rewrote, so a renewal that committed
 *   and then lost its answer — the connection dropped after the write, not
 *   before it — left the holder naming a deadline the row had already stopped
 *   having. The next renewal matched nothing and reported a loss that had not
 *   happened, abandoning a collection this replica still owned, with no
 *   terminal write, so the committed renewal simply lapsed and the account came
 *   back due to re-run every day it had already paid to collect. Against a
 *   fixed token there is nothing to go stale: whether or not the lost write
 *   landed, the row still names this holder and the next renewal is correct.
 * - Renewal is driven from this process and nothing else. A process that dies
 *   stops renewing, and the account comes due on its own within one lease
 *   period. There is no reaper and no orphan state, exactly as before.
 *
 * The token is also the fence for the pass's terminal write, so a holder that
 * lost the lease cannot clobber the new holder's claim on its way out — and,
 * because that write releases the lease by clearing the token, a renewal still
 * in flight when it lands can no longer undo it whichever order the two arrive
 * in.
 *
 * **Billable work is authorized against the last *confirmed* deadline.** That
 * is the whole of the safety argument, and it is a statement about a value in
 * the database rather than about how long this process has been running:
 *
 * - {@link LeaseKeeper} tracks `confirmedUntil` — the latest deadline this
 *   process has *proof* the row holds. The claim is proof of one (its reply
 *   came back), and so is every renewal that answers. A renewal that does not
 *   answer proves nothing and advances it by nothing, because "committed, reply
 *   lost" and "never executed" are indistinguishable from here and only one of
 *   them moved the row.
 * - `checkpoint()` will not start another day unless `confirmedUntil` is still
 *   far enough out to be worth starting one, and the work that does start
 *   carries {@link NetworkFlowLease.signal}, which aborts the moment
 *   `confirmedUntil` runs out. So the guarantee is not "the pass is short" but
 *   "no billable query outlives the last deadline we could prove", which is
 *   exactly the instant a second replica could claim the account.
 * - {@link NETWORK_FLOW_LEASE_RESERVE_MS} is held back from that instant, to
 *   cover the skew between this process's clock and the database's `now()` and
 *   the moment or two between the signal firing and the provider actually
 *   stopping.
 * - While renewals answer, `confirmedUntil` keeps moving and the signal never
 *   fires: a legitimate three-hour day still runs to completion under a lease
 *   that is genuinely being held. The signal is not a timeout on the work. It
 *   is the withdrawal of the entitlement the work was running under, and it can
 *   only be withdrawn by the database going quiet or by the lease being lost
 *   outright — which aborts it too, rather than waiting for the next day
 *   boundary to notice.
 *
 * **This is the correction to an argument that used to be made here, and was
 * wrong.** It ran: the runtime budget is strictly shorter than the lease, so a
 * pass that begins at the claim cannot still be issuing queries when the
 * claim's deadline passes, and it is therefore safe to carry on through a
 * renewal we could not confirm. That holds only while renewals succeed — each
 * success is what pushes the deadline out ahead of the budget. When a renewal
 * is unconfirmed *and genuinely never landed*, the deadline stops where the
 * last confirmed write left it while the budget goes on being measured from
 * when the pass began, and the two stop being related at all. A checkpoint at
 * minute 24 of a 25-minute budget would authorize a day that ran past minute 30,
 * the lease would lapse underneath it, and a second replica would claim the
 * account and scan the same days — the duplicate customer charge, arrived at
 * through the reasoning that was supposed to rule it out. Elapsed time cannot
 * bound anything relative to a deadline it does not move.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client";
import { accountNetworkFlowPolls } from "../db/schema";

/**
 * Lease written into `next_poll_at` by the claim and by every renewal.
 *
 * This is now a renewal period rather than a guess at the worst-case duration
 * of a pass: it only has to outlast {@link NETWORK_FLOW_HEARTBEAT_MS} by enough
 * margin to survive a couple of failed renewals, and be short enough that a
 * replica that dies mid-collection frees the account promptly.
 */
export const NETWORK_FLOW_LEASE_MS = 30 * 60 * 1000;

/**
 * How often the lease is pushed forward while a collection is running. Well
 * inside the lease — three beats fit in one lease period, so two consecutive
 * renewal failures (a blip on the database, a failover) still leave the lease
 * comfortably held, while a process that stops beating at all still releases
 * the account within {@link NETWORK_FLOW_LEASE_MS}.
 */
export const NETWORK_FLOW_HEARTBEAT_MS = 10 * 60 * 1000;

/**
 * How much wall-clock one account's pass gets before it stops collecting days.
 *
 * **A fairness bound, not a safety one.** It stops one pathological account —
 * a hundred flow logs, or a provider having a bad day — from monopolizing a
 * poller slot for hours while every other account waits, and the right answer
 * for such an account is to bank the days it did collect and come back. It
 * decides nothing about whether the lease is still held: that is
 * `confirmedUntil`'s job, and elapsed time cannot do it (see the header). This
 * value may be raised or lowered on its own merits; nothing about exclusivity
 * turns on its relationship to {@link NETWORK_FLOW_LEASE_MS}.
 *
 * It gates the *start* of a day only, deliberately. A day already under way is
 * running under an entitlement that is still good, and cutting it short would
 * throw away scans the customer has already been billed for.
 */
export const NETWORK_FLOW_MAX_RUNTIME_MS = 25 * 60 * 1000;

/**
 * Held back from the confirmed lease deadline, so that billable work stops a
 * little before the account could become claimable rather than exactly as it
 * does.
 *
 * It covers two gaps, both small and neither zero:
 *
 * - **Clock skew.** `confirmedUntil` is on this process's clock and the row's
 *   deadline is on the database's, and the two are only as aligned as NTP makes
 *   them. Every deadline this process credits itself with is anchored to an
 *   instant *before* the write that set it, so the error is one-sided, and this
 *   absorbs it.
 * - **Stopping is not instantaneous.** The signal fires, a plugin notices it
 *   between polls, and a `StopQuery` has to reach the provider. A minute is
 *   more than any of that needs.
 */
export const NETWORK_FLOW_LEASE_RESERVE_MS = 60 * 1000;

/**
 * The least confirmed lease worth starting a day under.
 *
 * Below this the day cannot fit even one provider query, so all it would buy is
 * a couple of discovery round-trips and an abort — and, for a plugin that
 * cancels a scan it had already started, a small bill for nothing. The fine cut
 * belongs to the plugin, which knows its own query timeouts; this is only here
 * so the host does not open work it can see has no room.
 */
export const NETWORK_FLOW_MIN_WORK_WINDOW_MS = 60 * 1000;

/**
 * Thrown when a renewal finds the lease is no longer ours. Handled specially by
 * the pass: it is not the account's fault, so it must not count as a failure or
 * push the account's backoff out — and above all the pass must not write to the
 * row, because somebody else owns it now.
 */
export class NetworkFlowLeaseLostError extends Error {
  constructor(readonly accountId: string) {
    super(`Lost the network-flow lease for account ${accountId} mid-collection`);
    this.name = "NetworkFlowLeaseLostError";
  }
}

/**
 * The collector's view of the lease. Two halves, because a unit of work has to
 * be authorized both before it starts and while it runs — see
 * {@link startNetworkFlowLease}.
 */
export interface NetworkFlowLeaseGate {
  /**
   * Re-assert the lease before spending the customer's money again.
   *
   * Returns `false` when the caller must stop cleanly: the pass has used its
   * runtime budget, or the confirmed lease no longer reaches far enough ahead
   * to be worth starting another day under, or it already ran out and
   * {@link signal} was withdrawn. All three are ordinary endings — the days
   * already collected stand and the rest wait for the next pass.
   *
   * Throws {@link NetworkFlowLeaseLostError} when the lease has been lost, in
   * which case the caller must stop *without* recording anything against the
   * account.
   */
  checkpoint(): Promise<boolean>;
  /**
   * Live authorization for work that has already started, handed to the plugin.
   *
   * `checkpoint()` can only speak for the instant it is called, and a day is
   * not a bounded unit — it is a walk over every flow log on the account, each
   * with its own query timeout. So the entitlement travels with the work: this
   * aborts when the lease is lost outright, or when the last deadline this
   * process could confirm is about to pass, and a plugin that honours it stops
   * spending at that point rather than at a day boundary that may be an hour
   * away.
   *
   * It does not fire while renewals are answering, however long the work takes.
   */
  readonly signal: AbortSignal;
}

export interface NetworkFlowLease extends NetworkFlowLeaseGate {
  /**
   * This claim's owner token, or null when the lease is inert.
   *
   * Fence every write to the row on it. It names the claim rather than the
   * claim's current state, so — unlike the deadline it replaced — it is the
   * same value from the claim to the end of the pass, and a write fenced on it
   * lands exactly when this replica still holds the lease and never otherwise.
   * Nothing has to be re-read at the right moment, because there is no moment
   * at which it changes.
   */
  readonly owner: string | null;
  /**
   * Stop renewing, and wait for any renewal already in flight to land.
   *
   * Idempotent, and safe to call from a `finally`. Await it before writing to
   * the row: it is what guarantees the pass returns with no write of its own
   * still outstanding, so nothing this lease started can be observed after the
   * account has been released.
   *
   * A renewal that escapes anyway — one whose answer was lost, and which is
   * therefore no longer awaitable here even though the database may still apply
   * it — cannot do damage: the terminal write clears the owner token, so a
   * renewal arriving after it matches nothing, and one arriving before it is
   * simply overwritten by a write that still matches.
   */
  stop(): Promise<void>;
}

/**
 * Push the lease forward, but only if this holder still owns it.
 *
 * `now()` rather than the process clock, so the deadline is on the same clock
 * as the due-ness predicate that reads it.
 *
 * Resolves to whether the row still names this holder. False means the lease
 * lapsed and somebody else has the account.
 */
async function renewNetworkFlowLease(
  accountId: string,
  organizationId: string,
  owner: string,
): Promise<boolean> {
  const rows = await db
    .update(accountNetworkFlowPolls)
    .set({
      nextPollAt: sql`now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond'`,
    })
    .where(
      and(
        eq(accountNetworkFlowPolls.accountId, accountId),
        eq(accountNetworkFlowPolls.organizationId, organizationId),
        eq(accountNetworkFlowPolls.leaseOwner, owner),
      ),
    )
    .returning({ accountId: accountNetworkFlowPolls.accountId });
  return rows.length > 0;
}

export interface NetworkFlowLeaseOptions {
  heartbeatMs?: number;
  maxRuntimeMs?: number;
  /**
   * When the claim that this lease continues was *issued*, on this process's
   * clock.
   *
   * The first confirmed deadline is derived from it, so it has to be an instant
   * the database's `now()` provably came after: take it before sending the
   * claim statement, never after reading the reply. Defaults to construction
   * time, which is a few milliseconds late and therefore a few milliseconds
   * optimistic — fine for a caller that has nothing better, and the reason the
   * pass passes the real one.
   */
  claimedAt?: number;
  /**
   * How long a lease the claim and each renewal write. Only for tests that need
   * a lease shorter than a poller tick; production has exactly one value and it
   * is baked into the claim's SQL.
   */
  leaseMs?: number;
}

/**
 * What one renewal attempt proved about the lease.
 *
 * The two failures are emphatically not the same thing, and everything the pass
 * does next hangs off telling them apart:
 *
 * - `unconfirmed` — no answer came back. A connection blip, a timeout, a
 *   failover, or a write that committed and lost its reply on the way home.
 *   Deliberately one state and not two, because from here they are
 *   indistinguishable and, since renewals match on the owner token rather than
 *   on the deadline, they no longer need to be told apart: either the deadline
 *   the last confirmed renewal left is still in the row, or a later one is, and
 *   both are this holder's until they pass. The lease is still ours, so the
 *   collection carries on and the next beat retries — but it has proved
 *   *nothing new*, so it buys no time: `confirmedUntil` does not move, and the
 *   work now has a visible end at the deadline this holder last confirmed.
 * - `lost` — the renewal executed and matched no row. The owner token is gone,
 *   so somebody else has claimed the account. Stop, and touch nothing.
 *
 * Collapsing the first into the second aborts a collection, and records a
 * failure with backoff against an account that did nothing wrong, over a
 * database hiccup. Collapsing the second into the first is the duplicate
 * customer charge this whole file exists to prevent. Treating the first as if
 * it had *renewed* is the same charge again by a quieter route, which is why
 * only `renewed` advances anything.
 */
type RenewalOutcome =
  | { readonly status: "renewed"; readonly heldUntil: number }
  | { readonly status: "lost" }
  | { readonly status: "unconfirmed"; readonly error: unknown };

class LeaseKeeper implements NetworkFlowLease {
  #lost = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The renewal currently in flight, if any.
   *
   * Both the heartbeat and `checkpoint` renew, and they can meet: a beat that
   * fired while a provider call was awaiting is mid-renewal when the collector
   * reaches its next day. Coalescing them keeps that to one write rather than
   * two identical ones, and gives {@link stop} a single thing to await.
   *
   * It must settle rather than reject, for that awaiting to be worth anything:
   * see {@link RenewalOutcome}.
   */
  #inFlight: Promise<RenewalOutcome> | null = null;
  /**
   * The latest deadline this process has *proof* the row holds, on this
   * process's clock.
   *
   * Everything billable is authorized against this and nothing else. It starts
   * at the claim — whose reply came back, so its write is proved — and moves
   * only when a renewal answers. A renewal that does not answer leaves it
   * exactly where it was, which is the point: it may have committed, and it may
   * never have executed, and only one of those two moved the row.
   *
   * Meaningless, and unused, when there is no owner token to hold the lease
   * with; see {@link #confirmedRemaining}.
   */
  #confirmedUntil: number;
  /**
   * Fires when the entitlement runs out, so that work already in flight stops
   * instead of running on to a day boundary that may be an hour away.
   *
   * Armed against {@link #confirmedUntil}, and re-armed every time a renewal
   * pushes that out — so on a healthy lease it is a timer that is always being
   * moved and never fires.
   */
  #window: ReturnType<typeof setTimeout> | null = null;
  readonly #abort = new AbortController();
  readonly #owner: string | null;
  readonly #runtimeDeadline: number;
  readonly #heartbeatMs: number;
  readonly #leaseMs: number;

  constructor(
    private readonly accountId: string,
    private readonly organizationId: string,
    owner: string | null,
    options: NetworkFlowLeaseOptions,
  ) {
    this.#owner = owner;
    this.#heartbeatMs = options.heartbeatMs ?? NETWORK_FLOW_HEARTBEAT_MS;
    this.#leaseMs = options.leaseMs ?? NETWORK_FLOW_LEASE_MS;
    this.#runtimeDeadline = Date.now() + (options.maxRuntimeMs ?? NETWORK_FLOW_MAX_RUNTIME_MS);
    this.#confirmedUntil = (options.claimedAt ?? Date.now()) + this.#leaseMs;
    if (this.#owner) {
      this.#schedule();
      this.#armWindow();
    }
  }

  get owner(): string | null {
    return this.#owner;
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  async stop(): Promise<void> {
    // Synchronous first, so that a caller who does not await still stops the
    // beating: neither renewal path starts anything new once this is set, which
    // is also why the loop below terminates.
    this.#stopped = true;
    this.#clearTimer();
    // The work is over by the time anyone calls this, so there is nothing left
    // to withdraw authorization from — but a timer that outlived the pass would
    // abort a signal nobody is holding and, worse, keep firing on a lease this
    // process has already handed back.
    this.#clearWindow();
    // Then wait out the renewal that is already on its way to the database, so
    // that the pass never returns with one of this lease's writes outstanding.
    while (this.#inFlight) await this.#inFlight;
  }

  async checkpoint(): Promise<boolean> {
    if (this.#lost) throw new NetworkFlowLeaseLostError(this.accountId);
    // An entitlement that has been withdrawn is not handed back mid-pass, even
    // if the database has since started answering again. There is nothing to
    // hand it back *with*: the signal the collector already gave the plugin
    // cannot be un-aborted, so authorizing another day would only buy a round
    // trip that stops on its first check. The pass ends and the next one claims
    // afresh.
    if (this.#abort.signal.aborted) return false;
    if (Date.now() >= this.#runtimeDeadline) return false;
    if (!this.#owner || this.#stopped) return true;

    // Renew here as well as on the timer, so that every billable query is
    // immediately preceded by a successful compare-and-swap rather than by a
    // heartbeat that may have last run minutes ago — or, if the event loop was
    // starved, not at all.
    this.#clearTimer();
    if (!this.#stillHeld(await this.#renew())) throw new NetworkFlowLeaseLostError(this.accountId);
    if (!this.#stopped) this.#schedule();

    // The renewal above either proved a later deadline or proved nothing, and
    // this is where that difference is spent. Authorizing the next day on the
    // strength of a renewal that never reached the database is how a scan ends
    // up running past the deadline a second replica claims on.
    return this.#confirmedRemaining() >= NETWORK_FLOW_MIN_WORK_WINDOW_MS;
  }

  /**
   * The one place either path decides what a renewal outcome means, and the
   * only place `#lost` is set.
   *
   * The two used to classify separately and duly drifted: the heartbeat rode
   * out a renewal that failed to execute, while `checkpoint` let the same
   * exception escape into the pass, which could only read it as an account
   * failure — aborting the collection and pushing the account's backoff out
   * over a database blip the account had nothing to do with. Returns whether
   * the lease is still ours; how that gets reported is each caller's business,
   * since only one of them has somebody to throw to.
   */
  #stillHeld(outcome: RenewalOutcome): boolean {
    if (outcome.status === "lost") {
      this.#lost = true;
      // Somebody else has the account as of now, so the entitlement is gone as
      // of now — not as of the next day boundary. Whatever is running stops.
      this.#revoke(`the network-flow lease for account ${this.accountId} was claimed by another`);
      return false;
    }
    if (outcome.status === "renewed") {
      // Proof, and the only kind there is: the row named us at the moment the
      // database ran this statement, and the statement set the deadline to its
      // own `now()` plus a lease. `now()` came after we issued the renewal, so
      // the deadline is at least `issuedAt + lease` — the one bound available
      // that does not depend on when the answer got back.
      this.#confirmedUntil = Math.max(this.#confirmedUntil, outcome.heldUntil);
      this.#armWindow();
    }
    if (outcome.status === "unconfirmed") {
      // Not a lost lease: whatever happened to this attempt, the row still
      // names us as the owner, and the deadline in it — the old one or the one
      // this attempt may have committed — has not passed. So the collection
      // carries on and the next beat retries.
      //
      // But nothing was *learned*, so `#confirmedUntil` stays where the last
      // answered write left it, and the work now has an end in sight: the
      // window timer is already armed on that deadline, and if the database
      // stays unreachable it fires and billable work stops just before the
      // account becomes claimable by anyone else. The lease then lapses, which
      // is the safe direction — the account is freed rather than silently held.
      console.error(
        `[network-flow] account ${this.accountId}: lease renewal unconfirmed:`,
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      );
    }
    return true;
  }

  /**
   * How much longer billable work is authorized for, on this process's clock.
   *
   * `Infinity` for an inert lease: with no owner token there is no lease to
   * lapse, nobody is being kept out, and the pass behaves as it did before any
   * of this existed.
   */
  #confirmedRemaining(): number {
    if (!this.#owner) return Number.POSITIVE_INFINITY;
    return this.#confirmedUntil - NETWORK_FLOW_LEASE_RESERVE_MS - Date.now();
  }

  /** Withdraw the entitlement from work already running. Idempotent. */
  #revoke(why: string): void {
    this.#clearWindow();
    if (!this.#abort.signal.aborted) this.#abort.abort(new Error(why));
  }

  #clearWindow(): void {
    if (this.#window === null) return;
    clearTimeout(this.#window);
    this.#window = null;
  }

  /**
   * Point the window timer at the deadline as it now stands.
   *
   * Re-armed rather than left alone on every confirmed renewal, which is what
   * makes a long legitimate day work: each answered renewal moves the deadline
   * out and moves this with it, so the abort only ever arrives when the
   * renewals stop arriving.
   */
  #armWindow(): void {
    this.#clearWindow();
    if (this.#stopped || this.#abort.signal.aborted) return;
    const remaining = this.#confirmedRemaining();
    if (remaining <= 0) {
      this.#revoke(
        `the network-flow lease for account ${this.accountId} is no longer confirmed held`,
      );
      return;
    }
    this.#window = setTimeout(() => {
      this.#window = null;
      console.warn(
        `[network-flow] account ${this.accountId}: lease unconfirmed past its last known ` +
          `deadline, stopping billable work now`,
      );
      this.#revoke(
        `the network-flow lease for account ${this.accountId} is no longer confirmed held`,
      );
    }, remaining);
    // Never hold the process open for this; the pass owns the lifetime.
    this.#window.unref?.();
  }

  /**
   * One renewal at a time; later callers join the one already running.
   *
   * Settles rather than rejects, so that joining a renewal cannot turn into a
   * second copy of the same error and so that {@link stop} can await it without
   * having to care.
   */
  #renew(): Promise<RenewalOutcome> {
    if (this.#inFlight) return this.#inFlight;
    // Read before the statement is sent, never after the answer is read: the
    // deadline this renewal proves is anchored to an instant the database's
    // `now()` came *after*, so the proof is a lower bound and the error is on
    // the safe side. Anchoring to the reply instead would credit the lease with
    // however long the round trip took, which on a struggling database is
    // exactly when the credit is least deserved.
    const issuedAt = Date.now();
    const pending = renewNetworkFlowLease(this.accountId, this.organizationId, this.#owner!)
      .then(
        (held): RenewalOutcome =>
          held ? { status: "renewed", heldUntil: issuedAt + this.#leaseMs } : { status: "lost" },
        (error: unknown): RenewalOutcome => ({ status: "unconfirmed", error }),
      )
      .finally(() => {
        this.#inFlight = null;
      });
    this.#inFlight = pending;
    return pending;
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => void this.#beat(), this.#heartbeatMs);
    // Never hold the process open for a heartbeat; the pass owns the lifetime.
    this.#timer.unref?.();
  }

  async #beat(): Promise<void> {
    this.#timer = null;
    if (this.#stopped || this.#lost || !this.#owner) return;
    const held = this.#stillHeld(await this.#renew());
    if (this.#stopped) return;
    if (!held) {
      // `#stillHeld` has already revoked the entitlement, so a plugin that
      // honours the signal stops spending here rather than at the next day
      // boundary — which, for an account with a hundred flow logs, could be an
      // hour of scanning the new holder is also paying for. The checkpoint that
      // follows still throws, and nothing is written either way.
      console.warn(
        `[network-flow] account ${this.accountId}: lease lost mid-collection, stopping now`,
      );
      return;
    }
    this.#schedule();
  }
}

/**
 * Start renewing the lease `claimDueNetworkFlowAccounts` just handed out.
 *
 * `owner` is the token the claim wrote into the row. When it is null — which
 * can only happen if the claim stopped returning `lease_owner` — the lease is
 * inert: no renewals, no fence, no entitlement to withdraw (the signal never
 * aborts), and the pass behaves exactly as it did before renewal existed.
 * `network-flow-claim.test.ts` pins the column into the `RETURNING` clause so
 * that cannot happen unnoticed.
 */
export function startNetworkFlowLease(
  accountId: string,
  organizationId: string,
  owner: string | null,
  options: NetworkFlowLeaseOptions = {},
): NetworkFlowLease {
  return new LeaseKeeper(accountId, organizationId, owner, options);
}
