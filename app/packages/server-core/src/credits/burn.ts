/**
 * Burn rate and runway from a series of credit readings.
 *
 * Pure functions — no database, no clock beyond what is passed in — because
 * this is the part that must not lie. A wrong runway is worse than no runway:
 * it is the number somebody uses to decide *not* to top up.
 *
 * The central problem is top-ups. A pot that went 500 → 300 → 900 → 700 over
 * four readings has burned 400, not gained 200, and the naive
 * `first - last` answer reports a negative burn and an infinite runway — the
 * most dangerous possible wrong answer, delivered with confidence. So the burn
 * is the sum of the *decreases* between consecutive readings, and increases
 * are recorded as top-ups rather than netted off.
 */

/** One reading of one pot. */
export interface CreditObservation {
  /** Epoch milliseconds. */
  at: number;
  remaining: number;
}

export interface BurnEstimate {
  /**
   * Spend per day over the observed span, in the pot's currency. Null when
   * there is not enough history to say — never 0, which would read as
   * "nothing is being spent".
   */
  perDay: number | null;
  /** Days between the first and last reading used. */
  spanDays: number;
  /** Readings used. */
  observations: number;
  /** Increases seen between consecutive readings, i.e. top-ups. */
  topUps: number;
  /** Total added by those top-ups. */
  toppedUpAmount: number;
}

/**
 * Least observed span before a burn rate is worth reporting.
 *
 * Two readings a few hours apart across a quiet night would extrapolate to a
 * runway of years; two spanning a busy afternoon to a runway of days. Neither
 * is a rate. Three days is the shortest span that has seen a weekday and can
 * absorb one idle day without swinging the answer by an order of magnitude.
 */
export const MIN_BURN_SPAN_DAYS = 3;

/**
 * Estimate spend per day from consecutive decreases.
 *
 * Observations are sorted by time; anything out of order or duplicated at the
 * same instant is tolerated rather than rejected, because a collection pass
 * that ran twice on one replica must not break the panel.
 */
export function estimateBurn(observations: readonly CreditObservation[]): BurnEstimate {
  const sorted = [...observations].sort((a, b) => a.at - b.at);
  if (sorted.length < 2) {
    return {
      perDay: null,
      spanDays: 0,
      observations: sorted.length,
      topUps: 0,
      toppedUpAmount: 0,
    };
  }

  let spent = 0;
  let topUps = 0;
  let toppedUpAmount = 0;
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i]!.remaining - sorted[i - 1]!.remaining;
    if (delta < 0) spent += -delta;
    else if (delta > 0) {
      topUps++;
      toppedUpAmount += delta;
    }
  }

  const spanMs = sorted[sorted.length - 1]!.at - sorted[0]!.at;
  const spanDays = spanMs / 86_400_000;
  return {
    // Below the minimum span the honest answer is "don't know yet", not a
    // number extrapolated from an afternoon.
    perDay: spanDays >= MIN_BURN_SPAN_DAYS ? spent / spanDays : null,
    spanDays,
    observations: sorted.length,
    topUps,
    toppedUpAmount,
  };
}

export interface RunwayEstimate {
  /**
   * Days until the pot is empty at the observed burn, or until the credit
   * expires — whichever comes first. Null when the burn is unknown, and
   * `Infinity` is never returned: see `neverEmpties`.
   */
  days: number | null;
  /** The date the credit runs out, ISO, when `days` is known. */
  exhaustedAt: string | null;
  /** True when nothing has been spent over the observed span. */
  neverEmpties: boolean;
  /** True when the limiting factor is the credit's expiry, not the burn. */
  limitedByExpiry: boolean;
}

/**
 * Turn a balance and a burn into a runway.
 *
 * Two things bound it, and the earlier wins. A trial grant that lapses in nine
 * days does not have a 200-day runway however slowly it is being spent, and a
 * report that said otherwise would be exactly wrong for the one case where
 * somebody most needs the warning.
 *
 * A zero burn returns `neverEmpties` rather than `Infinity`: "nothing spent in
 * the last two weeks" is a real observation about an idle account and should
 * read as one, not as an unbounded number that formats badly and invites
 * arithmetic.
 */
export function estimateRunway(
  remaining: number,
  burn: BurnEstimate,
  opts: { now: number; creditExpiresAt?: string | null } = { now: Date.now() },
): RunwayEstimate {
  const expiryDays = daysUntilExpiry(opts.creditExpiresAt, opts.now);

  if (burn.perDay === null) {
    // Even with no burn rate, a hard expiry is still a deadline worth naming.
    if (expiryDays !== null) {
      return {
        days: expiryDays,
        exhaustedAt: new Date(opts.now + expiryDays * 86_400_000).toISOString(),
        neverEmpties: false,
        limitedByExpiry: true,
      };
    }
    return { days: null, exhaustedAt: null, neverEmpties: false, limitedByExpiry: false };
  }

  if (burn.perDay <= 0 || remaining <= 0) {
    const empty = remaining <= 0;
    return {
      days: empty ? 0 : expiryDays,
      exhaustedAt: empty
        ? new Date(opts.now).toISOString()
        : expiryDays !== null
          ? new Date(opts.now + expiryDays * 86_400_000).toISOString()
          : null,
      neverEmpties: !empty && expiryDays === null,
      limitedByExpiry: !empty && expiryDays !== null,
    };
  }

  const burnDays = remaining / burn.perDay;
  const limitedByExpiry = expiryDays !== null && expiryDays < burnDays;
  const days = limitedByExpiry ? expiryDays! : burnDays;
  return {
    days,
    exhaustedAt: new Date(opts.now + days * 86_400_000).toISOString(),
    neverEmpties: false,
    limitedByExpiry,
  };
}

function daysUntilExpiry(expiresAt: string | null | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const at = new Date(expiresAt).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - now) / 86_400_000);
}

/**
 * How alarming a runway is.
 *
 * Thresholds in days rather than as a fraction of the balance, because what
 * matters is whether there is time to do something about it: a purchase order
 * takes a week at most organizations, and a weekend is when nobody is looking.
 */
export type RunwayUrgency = "critical" | "warning" | "ok" | "unknown";

export function runwayUrgency(runway: RunwayEstimate): RunwayUrgency {
  if (runway.neverEmpties) return "ok";
  if (runway.days === null) return "unknown";
  if (runway.days <= 7) return "critical";
  if (runway.days <= 30) return "warning";
  return "ok";
}
