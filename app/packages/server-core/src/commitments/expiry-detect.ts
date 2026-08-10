/**
 * Commitment expiry detection — **pure**. No db, no ClickHouse, no clock, no
 * network. The caller hands in the inventory and the day; findings come back.
 *
 * ## Why this exists at all
 *
 * Every other cost alert in the product compares a spend total against another
 * spend total, so every one of them learns about an expired reservation the
 * same way a human does: from the bill, after the fact. A commitment lapsing is
 * a *scheduled* step change — the usage it was covering reverts to on-demand
 * the hour after the term ends — and it is the only cost event we can see
 * coming with certainty, because the end date is a fact the provider already
 * told us.
 *
 * ## The bracket rule (this is the one worth reading)
 *
 * Horizons are 60/30/7 days by default, and each must fire **once**. The naive
 * rule — "emit a finding for every horizon the commitment is inside" — is
 * wrong in a way the dedup table cannot fix: an account connected 30 days
 * before a term ends is inside *both* the 60 and the 30 horizon, so it would
 * produce two alerts about one commitment in one pass, neither of which the
 * reader asked for twice.
 *
 * So a commitment fires at the **smallest horizon it has reached** — its
 * current bracket — and nothing else:
 *
 *     horizons [60, 30, 7], 45 days left → bracket 60
 *     horizons [60, 30, 7], 30 days left → bracket 30
 *     horizons [60, 30, 7],  3 days left → bracket 7
 *
 * A pass a day later re-emits the same bracket, and the unique index on
 * `commitment_expiry_events` (account, commitment, term end, horizon) absorbs
 * it — the `budget_alert_events` once-per-period protocol. As the term
 * shortens, the bracket tightens and a genuinely new horizon fires. An account
 * connected late skips the horizons that are already moot rather than firing
 * all of them at once, which is what makes "once per commitment per horizon"
 * true in practice and not just in the index.
 *
 * ## Auto-renewal
 *
 * A commitment that renews itself does not revert to on-demand, so the warning
 * that says it will would be false. It is not a non-event either — the money
 * keeps leaving at whatever the renewal price is, and "we meant to cancel that"
 * is a real conversation — so an auto-renewing commitment fires **once, at the
 * shortest configured horizon only**, flagged {@link CommitmentExpiryFinding.autoRenewing}
 * so the driver can lower the severity and change the sentence.
 *
 * Two independent signals feed {@link ExpiringCommitmentInput.autoRenew}:
 *
 * 1. The provider's own flag (Azure `renew`, GCP `autoRenew`). The collected
 *    inventory does not carry one today — `CommitmentRecord` in
 *    `@infrawrench/plugin-base` has no such field — so the driver passes
 *    `null` and this module treats it as "not known to renew". The input is
 *    typed for it anyway so that the day a collector reports it, the change is
 *    one line in the driver and nothing here moves.
 * 2. A **successor already in the inventory** — another commitment on the same
 *    account, same kind/region/scope/description, starting at or after this
 *    one's end. That is what an AWS queued RI purchase looks like, and it is
 *    stronger evidence than any flag: the replacement is bought. A commitment
 *    with a successor is skipped outright rather than downgraded, because
 *    nothing lapses and nothing renews at a surprising price — see
 *    {@link CommitmentExpirySkipReason}.
 *
 * ## The already-expired case
 *
 * A commitment whose term ended in the past cannot have fired a horizon
 * warning if we only started collecting after the fact. That is the worst case
 * this feature exists for and it is silent by construction, so it gets exactly
 * one finding at horizon `0`. It is bounded by
 * {@link CommitmentExpiryOptions.expiredLookbackDays}: connecting an account
 * with six years of dead reservations must produce one pass of recent news,
 * not six years of it.
 */

/** Why a commitment produced no finding. Returned, never silently dropped. */
export type CommitmentExpirySkipReason =
  /** The provider reports no end date — nothing to count down to. */
  | "no_end_date"
  /** Purchased but not started; its own expiry is a future term's problem. */
  | "queued"
  /** A replacement commitment already covers the handover. */
  | "succeeded"
  /** Still further out than the widest horizon. */
  | "outside_horizons"
  /** Expired, and the org asked not to hear about those. */
  | "expired_alerts_disabled"
  /** Expired longer ago than `expiredLookbackDays`. */
  | "expired_long_ago";

export interface ExpiringCommitmentInput {
  accountId: string;
  /** Provider-native commitment id. */
  commitmentId: string;
  kind: string;
  description: string;
  scope: string | null;
  region: string | null;
  /** "active" | "queued" | "expired" — the provider's own word. */
  state: string;
  /** Term start as an ISO day, or null. */
  startDay: string | null;
  /** Term end as an ISO day, or null when the provider reports none. */
  endDay: string | null;
  currency: string | null;
  /** Committed spend per hour; null for unit-denominated records. */
  hourlyCommitmentAmount: number | null;
  unitCommitments: Array<{ unit: string; amount: number }> | null;
  /**
   * The provider's auto-renewal flag, when it reports one. `null` means "not
   * reported" and is treated as not renewing — see the module note.
   */
  autoRenew: boolean | null;
  /**
   * Σ **amortized** consumption stamped with this commitment's id over
   * `measuredDays`, or null when it could not be measured (unit-denominated,
   * unattributed rows, no collected days). Only used to size the exposure;
   * a null never suppresses a finding, because a commitment nobody could
   * measure still expires.
   */
  deliveredAmount: number | null;
  /** Days behind `deliveredAmount`. Zero means the rate is not derivable. */
  measuredDays: number;
}

export interface CommitmentExpiryOptions {
  /** Days of notice. Order and duplicates do not matter; the module sorts. */
  horizonDays: number[];
  /** Whether an already-expired commitment raises one finding at horizon 0. */
  alertOnExpired: boolean;
  /** How far back an expired commitment may be and still be worth saying. */
  expiredLookbackDays: number;
}

export interface CommitmentExpiryFinding {
  accountId: string;
  commitmentId: string;
  /** The term end this countdown is against — part of the dedup key. */
  termEndDay: string;
  /** The bracket that fired. `0` means it had already expired. */
  horizonDays: number;
  /** Days until the term ends; negative when it already has. */
  daysRemaining: number;
  /** True when the commitment renews itself — see the module note. */
  autoRenewing: boolean;
  description: string;
  kind: string;
  currency: string | null;
  hourlyCommitmentAmount: number | null;
  unitCommitments: Array<{ unit: string; amount: number }> | null;
  /**
   * What the org stops paying when the term ends: `hourly × 24 × 30.4`, in
   * `currency` units. Null for a unit-denominated commitment, which costs no
   * stated money.
   */
  monthlyCommitmentAmount: number | null;
  /**
   * A **lower bound** on what the covered usage will cost per month once it
   * reverts: the amortized value of what this commitment actually delivered,
   * restated to a month.
   *
   * A bound rather than an estimate, and stated as one everywhere it is
   * rendered, because nothing we store knows the on-demand list price — no
   * provider's cost export carries it on the covered line. What is certain is
   * the direction: on-demand is by definition at least the committed rate, so
   * the usage cannot revert to *less* than what it is amortizing at today.
   * Null when nothing could be measured.
   */
  monthlyCoveredUsageAmount: number | null;
}

export interface CommitmentExpiryResult {
  findings: CommitmentExpiryFinding[];
  skipped: Array<{
    accountId: string;
    commitmentId: string;
    reason: CommitmentExpirySkipReason;
  }>;
}

const DAY_MS = 86_400_000;

/** Mean days in a month. Used only to restate hourly rates as monthly ones. */
const DAYS_PER_MONTH = 30.4;

function dayValue(day: string): number {
  return new Date(`${day}T00:00:00Z`).valueOf();
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysUntil(from: string, to: string): number {
  return Math.round((dayValue(to) - dayValue(from)) / DAY_MS);
}

/**
 * The identity a successor has to match. Description is included deliberately:
 * two reservations for different instance families in the same region are not
 * each other's replacement, and their descriptions are what says so.
 */
function successorKey(c: ExpiringCommitmentInput): string {
  return [c.kind, c.region ?? "", c.scope ?? "", c.description].join("\x00");
}

/**
 * Whether some other commitment on the same account takes over when this one
 * ends.
 *
 * The one-day slack on the start is not cosmetic: providers stamp a queued
 * purchase's start at the incumbent's end *date*, and the two timestamps land
 * on either side of midnight often enough that an exact `>=` would miss the
 * handover it exists to find.
 */
function hasSuccessor(
  commitment: ExpiringCommitmentInput,
  endDay: string,
  byKey: Map<string, ExpiringCommitmentInput[]>,
): boolean {
  const peers = byKey.get(`${commitment.accountId}\x00${successorKey(commitment)}`);
  if (!peers) return false;
  return peers.some((peer) => {
    if (peer.commitmentId === commitment.commitmentId) return false;
    if (peer.state === "expired") return false;
    if (!peer.startDay) return false;
    if (daysUntil(peer.startDay, endDay) > 1) return false; // starts too late
    // A peer that also ends before us is a shorter overlapping term, not a
    // successor — it cannot cover the handover it ends before.
    return peer.endDay === null || peer.endDay > endDay;
  });
}

/**
 * The smallest horizon a commitment has reached, or null when it is still
 * further out than all of them. See the bracket rule in the module comment.
 */
export function expiryBracket(daysRemaining: number, horizonDays: number[]): number | null {
  let bracket: number | null = null;
  for (const horizon of horizonDays) {
    if (daysRemaining > horizon) continue;
    if (bracket === null || horizon < bracket) bracket = horizon;
  }
  return bracket;
}

/** The horizons, de-duplicated, positive, and ascending. */
function normalizeHorizons(horizonDays: number[]): number[] {
  return [...new Set(horizonDays.filter((h) => Number.isFinite(h) && h > 0).map(Math.round))].sort(
    (a, b) => a - b,
  );
}

/**
 * Which commitments are close enough to their term end to be worth saying
 * something about, and what saying it should cost.
 *
 * `commitments` is the whole org inventory rather than one account's, because
 * successor detection needs peers; findings are still per commitment.
 */
export function detectCommitmentExpiries(
  commitments: ExpiringCommitmentInput[],
  options: CommitmentExpiryOptions,
  today: string,
): CommitmentExpiryResult {
  const horizons = normalizeHorizons(options.horizonDays);
  const findings: CommitmentExpiryFinding[] = [];
  const skipped: CommitmentExpiryResult["skipped"] = [];
  if (horizons.length === 0) return { findings, skipped };

  const byKey = new Map<string, ExpiringCommitmentInput[]>();
  for (const c of commitments) {
    const key = `${c.accountId}\x00${successorKey(c)}`;
    const list = byKey.get(key);
    if (list) list.push(c);
    else byKey.set(key, [c]);
  }

  const skip = (c: ExpiringCommitmentInput, reason: CommitmentExpirySkipReason): void => {
    skipped.push({ accountId: c.accountId, commitmentId: c.commitmentId, reason });
  };

  for (const c of commitments) {
    const endDay = c.endDay;
    if (!endDay) {
      skip(c, "no_end_date");
      continue;
    }
    if (c.state === "queued") {
      skip(c, "queued");
      continue;
    }
    if (hasSuccessor(c, endDay, byKey)) {
      skip(c, "succeeded");
      continue;
    }

    const daysRemaining = daysUntil(today, endDay);

    let horizonDays: number;
    if (daysRemaining < 0) {
      if (!options.alertOnExpired) {
        skip(c, "expired_alerts_disabled");
        continue;
      }
      if (-daysRemaining > options.expiredLookbackDays) {
        skip(c, "expired_long_ago");
        continue;
      }
      horizonDays = 0;
    } else if (c.autoRenew === true) {
      // One notice, at the shortest horizon, and only once it is reached.
      const shortest = horizons[0]!;
      if (daysRemaining > shortest) {
        skip(c, "outside_horizons");
        continue;
      }
      horizonDays = shortest;
    } else {
      const bracket = expiryBracket(daysRemaining, horizons);
      if (bracket === null) {
        skip(c, "outside_horizons");
        continue;
      }
      horizonDays = bracket;
    }

    const hourly = c.hourlyCommitmentAmount;
    const monthlyCommitmentAmount =
      hourly !== null && hourly !== undefined ? hourly * 24 * DAYS_PER_MONTH : null;
    // Delivered is a total over `measuredDays`; a monthly rate needs both, and
    // zero measured days means there is no rate to state rather than a rate of
    // zero. (`deliveredAmount` of exactly 0 over real days *is* a rate of zero
    // — that commitment is expiring unused, which is worth saying.)
    const monthlyCoveredUsageAmount =
      c.deliveredAmount !== null && c.measuredDays > 0
        ? (c.deliveredAmount / c.measuredDays) * DAYS_PER_MONTH
        : null;

    findings.push({
      accountId: c.accountId,
      commitmentId: c.commitmentId,
      termEndDay: endDay,
      horizonDays,
      daysRemaining,
      autoRenewing: c.autoRenew === true,
      description: c.description,
      kind: c.kind,
      currency: c.currency,
      hourlyCommitmentAmount: hourly,
      unitCommitments: c.unitCommitments,
      monthlyCommitmentAmount,
      monthlyCoveredUsageAmount,
    });
  }

  // Soonest first: the reader's next decision is about whatever lapses next.
  findings.sort(
    (a, b) => a.daysRemaining - b.daysRemaining || a.description.localeCompare(b.description),
  );
  return { findings, skipped };
}
