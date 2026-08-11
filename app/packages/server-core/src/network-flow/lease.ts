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
 * **compare-and-swap, not a blind push forward**. That distinction is the whole
 * safety property:
 *
 * - The claim hands back the exact deadline it wrote. Every renewal updates the
 *   row only `WHERE next_poll_at` still equals the deadline this holder last
 *   saw, so a replica whose lease already lapsed — and whose account another
 *   replica has since claimed — matches no row, learns it lost, and stops. An
 *   unconditional `SET next_poll_at = now() + lease` would instead *extend the
 *   new holder's lease on the old holder's behalf*, which is the same overlap
 *   one layer further down.
 * - Renewal is driven from this process and nothing else. A process that dies
 *   stops renewing, and the account comes due on its own within one lease
 *   period. There is no reaper and no orphan state, exactly as before.
 *
 * The deadline doubles as the fence for the pass's terminal write, so a holder
 * that lost the lease cannot clobber the new holder's claim on its way out.
 *
 * **What happens when a collection genuinely overruns.** Two bounds, and
 * between them there is no third outcome where a second replica starts the same
 * scan:
 *
 * - {@link NETWORK_FLOW_MAX_RUNTIME_MS} bounds the *work*. `checkpoint()`
 *   returns false once the budget is spent and the collector stops at the next
 *   day boundary, before issuing another billable query. Days already collected
 *   keep their watermark, so the remainder is simply picked up by a later pass —
 *   which is already how a backlog deeper than `MAX_DAYS_PER_PASS` drains.
 * - The heartbeat bounds nothing; it just keeps renewing until {@link stop}. A
 *   single provider query that runs for hours therefore holds the lease for
 *   hours rather than letting a second replica in. That is the deliberate
 *   trade: the failure mode of a hung provider call is an account that goes
 *   uncollected until the process gives up, not an account that gets scanned
 *   twice. Bounding a single query is the plugin's job, not the lease's.
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
 * Set just inside a single lease period on purpose: in the overwhelmingly
 * common case a pass finishes without the heartbeat ever having mattered, and
 * the heartbeat is there for the one query that overshoots rather than being
 * load-bearing for every run. A pass that has spent this long on one account is
 * pathological — a hundred flow logs, or a provider having a bad day — and the
 * right answer for it is to bank the days it did collect and come back.
 */
export const NETWORK_FLOW_MAX_RUNTIME_MS = 25 * 60 * 1000;

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
 * The collector's view of the lease: one gate, called immediately before each
 * billable provider query. See {@link startNetworkFlowLease}.
 */
export interface NetworkFlowLeaseGate {
  /**
   * Re-assert the lease before spending the customer's money again.
   *
   * Returns `false` when the pass has used its runtime budget and the caller
   * should stop cleanly. Throws {@link NetworkFlowLeaseLostError} when the lease
   * has been lost, in which case the caller must stop *without* recording
   * anything against the account.
   */
  checkpoint(): Promise<boolean>;
}

export interface NetworkFlowLease extends NetworkFlowLeaseGate {
  /**
   * The deadline currently written in the row, or null when this lease is
   * inert. Use it to fence any write that would otherwise trample a newer
   * holder's claim.
   */
  readonly expiresAt: Date | null;
  /** Stop renewing. Idempotent, and safe to call from a `finally`. */
  stop(): void;
}

/**
 * Push the lease forward, but only if this holder still owns it.
 *
 * `now()` rather than the process clock, so the deadline is on the same clock
 * as the due-ness predicate that reads it. `date_trunc` to milliseconds because
 * the returned deadline is a fence token that has to survive a round trip
 * through a JS `Date`, which has no microseconds — an untruncated value would
 * read back slightly early and every subsequent compare-and-swap would miss.
 *
 * Resolves to the new deadline, or null if the row no longer matches, which
 * means the lease lapsed and somebody else has the account.
 */
async function renewNetworkFlowLease(
  accountId: string,
  organizationId: string,
  current: Date,
): Promise<Date | null> {
  const rows = await db
    .update(accountNetworkFlowPolls)
    .set({
      nextPollAt: sql`date_trunc('milliseconds', now() + ${NETWORK_FLOW_LEASE_MS}::float8 * interval '1 millisecond')`,
    })
    .where(
      and(
        eq(accountNetworkFlowPolls.accountId, accountId),
        eq(accountNetworkFlowPolls.organizationId, organizationId),
        eq(accountNetworkFlowPolls.nextPollAt, current),
      ),
    )
    .returning({ nextPollAt: accountNetworkFlowPolls.nextPollAt });
  return rows[0]?.nextPollAt ?? null;
}

export interface NetworkFlowLeaseOptions {
  heartbeatMs?: number;
  maxRuntimeMs?: number;
}

class LeaseKeeper implements NetworkFlowLease {
  #expiresAt: Date | null;
  #lost = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The renewal currently in flight, if any.
   *
   * Both the heartbeat and `checkpoint` renew, and they can meet: a beat that
   * fired while a provider call was awaiting is mid-renewal when the collector
   * reaches its next day. Two renewals issued from the same expected deadline
   * would have the second one match nothing and conclude — wrongly, and
   * expensively, since it stops a collection this replica does still own — that
   * the lease was lost. So the second caller joins the first instead.
   */
  #inFlight: Promise<Date | null> | null = null;
  readonly #deadline: number;
  readonly #heartbeatMs: number;

  constructor(
    private readonly accountId: string,
    private readonly organizationId: string,
    expiresAt: Date | null,
    options: NetworkFlowLeaseOptions,
  ) {
    this.#expiresAt = expiresAt;
    this.#heartbeatMs = options.heartbeatMs ?? NETWORK_FLOW_HEARTBEAT_MS;
    this.#deadline = Date.now() + (options.maxRuntimeMs ?? NETWORK_FLOW_MAX_RUNTIME_MS);
    if (this.#expiresAt) this.#schedule();
  }

  get expiresAt(): Date | null {
    return this.#expiresAt;
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
  }

  async checkpoint(): Promise<boolean> {
    if (this.#lost) throw new NetworkFlowLeaseLostError(this.accountId);
    if (Date.now() >= this.#deadline) return false;
    if (!this.#expiresAt || this.#stopped) return true;

    // Renew here as well as on the timer, so that every billable query is
    // immediately preceded by a successful compare-and-swap rather than by a
    // heartbeat that may have last run minutes ago — or, if the event loop was
    // starved, not at all.
    this.#clearTimer();
    const renewed = await this.#renew();
    if (renewed === null) {
      this.#lost = true;
      throw new NetworkFlowLeaseLostError(this.accountId);
    }
    if (!this.#stopped) this.#schedule();
    return true;
  }

  /** One renewal at a time; later callers join the one already running. */
  #renew(): Promise<Date | null> {
    if (this.#inFlight) return this.#inFlight;
    const expected = this.#expiresAt!;
    const pending = renewNetworkFlowLease(this.accountId, this.organizationId, expected)
      .then((renewed) => {
        if (renewed !== null) this.#expiresAt = renewed;
        return renewed;
      })
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
    if (this.#stopped || this.#lost || !this.#expiresAt) return;
    try {
      const renewed = await this.#renew();
      if (this.#stopped) return;
      if (renewed === null) {
        // Only the next checkpoint can actually stop the work — there is no way
        // to abort a provider call already in flight — but from here on nothing
        // new is started and nothing is written.
        this.#lost = true;
        console.warn(
          `[network-flow] account ${this.accountId}: lease lost mid-collection, stopping at the next day boundary`,
        );
        return;
      }
    } catch (e) {
      // A renewal that failed to *execute* is not a lost lease: the deadline is
      // still in the row and still ours until it passes. Try again on the next
      // beat. If the database stays unreachable the lease simply lapses, which
      // is the safe direction — the collection then loses its next checkpoint
      // too, and the account is freed rather than silently held.
      console.error(
        `[network-flow] account ${this.accountId}: lease renewal failed:`,
        e instanceof Error ? e.message : String(e),
      );
    }
    if (!this.#stopped && !this.#lost) this.#schedule();
  }
}

/**
 * Start renewing the lease `claimDueNetworkFlowAccounts` just handed out.
 *
 * `expiresAt` is the deadline the claim returned. When it is null — which can
 * only happen if the claim stopped returning `next_poll_at` — the lease is
 * inert: no renewals, no fence, and the pass behaves exactly as it did before
 * renewal existed. `network-flow-claim.test.ts` pins the column into the
 * `RETURNING` clause so that cannot happen unnoticed.
 */
export function startNetworkFlowLease(
  accountId: string,
  organizationId: string,
  expiresAt: Date | null,
  options: NetworkFlowLeaseOptions = {},
): NetworkFlowLease {
  return new LeaseKeeper(accountId, organizationId, expiresAt, options);
}
