/**
 * Restore drills — the half of a backup nobody tests.
 *
 * Backup coverage answers "is there a backup, and how old is it". It cannot
 * answer the question that actually matters on the day: *does it restore, and
 * how long does it take?* Those are different questions, and the second one is
 * routinely answered wrongly — by a snapshot that restores into a region with
 * no capacity, a dump taken from a replica that was already broken, an
 * encrypted volume whose key was rotated.
 *
 * A drill is a **record that somebody tried**, not an automated restore. That
 * distinction is the whole design. Restoring a customer's database on a
 * schedule, unattended, is not a feature this product will ever have — it costs
 * real money, it can collide with production, and there is no generic way to
 * verify a restored system is correct. What the product *can* do is make the
 * exercise scheduled, recorded, and visible when it lapses, which is the part
 * organisations actually fail at.
 *
 * This module is the pure half: the shapes, the validation, the staleness rule,
 * and the RTO arithmetic.
 */

/** How the drill ended. */
export type DrillOutcome =
  /** The restore worked and the restored system was checked. */
  | "verified"
  /** The restore worked but nobody checked what came back. */
  | "restored-unverified"
  /** The restore was attempted and did not work. */
  | "failed"
  /** It could not be attempted at all — no capacity, no key, no time. */
  | "blocked";

export const DRILL_OUTCOMES: readonly DrillOutcome[] = [
  "verified",
  "restored-unverified",
  "failed",
  "blocked",
] as const;

/**
 * Whether an outcome counts as evidence the backup works.
 *
 * Only `verified` does. `restored-unverified` is deliberately **not** evidence:
 * a restore that produced a running database nobody looked inside is exactly
 * how a team discovers, during an incident, that the dump had been empty for
 * three months. It is recorded because doing the restore is worth recording;
 * it does not reset the clock.
 */
export function isEvidenceOfRecovery(outcome: DrillOutcome): boolean {
  return outcome === "verified";
}

export interface RestoreDrill {
  id: string;
  /** The resource whose backup was exercised. */
  resourceId: string;
  resourceName: string | null;
  accountId: string | null;
  accountName: string | null;
  /** When the drill was performed (not when it was recorded). */
  performedAt: string;
  outcome: DrillOutcome;
  /**
   * Measured wall-clock minutes from starting the restore to having something
   * usable. Null when the drill did not get that far — a `blocked` drill has no
   * RTO, and inventing one would be the most dangerous number on the page.
   */
  rtoMinutes: number | null;
  /**
   * Which backup was restored, in whatever form the operator has it: a snapshot
   * id, an S3 key, a date. Free text on purpose — the identifiers differ per
   * provider and the value of writing it down does not.
   */
  restoredFrom: string | null;
  /** What was checked, or what went wrong. The most re-read field here. */
  notes: string | null;
  performedByUserId: string | null;
  performedByName: string | null;
  createdAt: string;
}

export interface RestoreDrillInput {
  resourceId: string;
  performedAt: string;
  outcome: DrillOutcome;
  rtoMinutes?: number | null;
  restoredFrom?: string | null;
  notes?: string | null;
}

export const RESTORE_DRILL_LIMITS = {
  maxNotesLength: 4000,
  maxRestoredFromLength: 300,
  /** A drill longer than a week is a migration, not a drill. */
  maxRtoMinutes: 10_080,
  /** Default staleness window: a drill older than this stops counting. */
  defaultValidDays: 180,
  minValidDays: 7,
  maxValidDays: 730,
} as const;

/**
 * How a resource stands with respect to drills.
 *
 * `never` and `stale` are kept apart because they call for different
 * conversations: one is "nobody has ever tried", the other is "it worked in
 * March". Collapsing them into "not ok" would lose the more alarming of the two.
 */
export type DrillStanding = "verified" | "stale" | "failed" | "never";

export interface DrillCoverageRow {
  resourceId: string;
  resourceName: string | null;
  accountId: string | null;
  accountName: string | null;
  resourceTypeId: string | null;
  standing: DrillStanding;
  /** The most recent drill of any outcome. */
  lastDrillAt: string | null;
  lastOutcome: DrillOutcome | null;
  /** The most recent drill that counts as evidence. */
  lastVerifiedAt: string | null;
  /** Measured RTO from the most recent verified drill. */
  verifiedRtoMinutes: number | null;
  /** Days until the verified drill goes stale; negative once it has. */
  daysUntilStale: number | null;
}

const MS_PER_DAY = 86_400_000;

export function validateRestoreDrill(input: RestoreDrillInput): string | null {
  if (!input.resourceId) return "Choose the resource whose backup you restored.";
  const performed = Date.parse(input.performedAt);
  if (Number.isNaN(performed)) return "When was the drill performed?";
  // A future drill is always a typo, and one recorded as future would sit at
  // the top of the list claiming the backup is fine.
  if (performed > Date.now() + 60_000) return "A drill cannot be in the future.";
  if (!DRILL_OUTCOMES.includes(input.outcome)) return "Choose what happened.";

  if (input.rtoMinutes != null) {
    if (!Number.isFinite(input.rtoMinutes) || input.rtoMinutes < 0) {
      return "The time to restore must be a positive number of minutes.";
    }
    if (input.rtoMinutes > RESTORE_DRILL_LIMITS.maxRtoMinutes) {
      return "A drill taking more than a week is a migration, not a drill.";
    }
    if (input.outcome === "blocked") {
      // A blocked drill never started, so a duration is meaningless — and a
      // meaningless RTO on this page is the most dangerous number on it.
      return "A blocked drill has no restore time — it never got that far.";
    }
  }
  if ((input.notes?.length ?? 0) > RESTORE_DRILL_LIMITS.maxNotesLength) {
    return `Notes must be ${RESTORE_DRILL_LIMITS.maxNotesLength} characters or fewer.`;
  }
  if ((input.restoredFrom?.length ?? 0) > RESTORE_DRILL_LIMITS.maxRestoredFromLength) {
    return `"Restored from" must be ${RESTORE_DRILL_LIMITS.maxRestoredFromLength} characters or fewer.`;
  }
  if (input.outcome === "verified" && input.rtoMinutes == null) {
    // The measured time is the entire point of a verified drill: an RPO comes
    // from the backup, and an RTO can only come from somebody with a stopwatch.
    return "A verified drill needs the measured time to restore — that is the number nobody else can supply.";
  }
  return null;
}

/**
 * Where a resource stands, from its drill history.
 *
 * `drills` may be in any order; the newest of each relevant kind is selected
 * here rather than assumed, because a drill *recorded* late for a date in the
 * past is the normal case — people write these up on Monday.
 */
export function drillStanding(
  drills: readonly RestoreDrill[],
  options: { validDays?: number; now?: number } = {},
): {
  standing: DrillStanding;
  lastDrillAt: string | null;
  lastOutcome: DrillOutcome | null;
  lastVerifiedAt: string | null;
  verifiedRtoMinutes: number | null;
  daysUntilStale: number | null;
} {
  const now = options.now ?? Date.now();
  const validDays = options.validDays ?? RESTORE_DRILL_LIMITS.defaultValidDays;

  const sorted = [...drills].sort((a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt));
  const last = sorted[0] ?? null;
  const lastVerified = sorted.find((drill) => isEvidenceOfRecovery(drill.outcome)) ?? null;

  if (!last) {
    return {
      standing: "never",
      lastDrillAt: null,
      lastOutcome: null,
      lastVerifiedAt: null,
      verifiedRtoMinutes: null,
      daysUntilStale: null,
    };
  }

  const base = {
    lastDrillAt: last.performedAt,
    lastOutcome: last.outcome,
    lastVerifiedAt: lastVerified?.performedAt ?? null,
    verifiedRtoMinutes: lastVerified?.rtoMinutes ?? null,
  };

  // A failure since the last success outranks the success. Somebody tried more
  // recently than the last green tick and it did not work; reporting that
  // resource as verified because March went well is the reading that gets a
  // team hurt.
  if (
    last.outcome === "failed" ||
    (last.outcome === "blocked" &&
      (!lastVerified || Date.parse(last.performedAt) > Date.parse(lastVerified.performedAt)))
  ) {
    return { ...base, standing: "failed", daysUntilStale: null };
  }

  if (!lastVerified) {
    // Drills exist but none of them verified anything — `restored-unverified`
    // only. That is "never" for the purposes of evidence, and the list shows
    // the attempt beside it.
    return { ...base, standing: "never", daysUntilStale: null };
  }

  const expiresAt = Date.parse(lastVerified.performedAt) + validDays * MS_PER_DAY;
  const daysUntilStale = Math.floor((expiresAt - now) / MS_PER_DAY);
  return {
    ...base,
    standing: daysUntilStale >= 0 ? "verified" : "stale",
    daysUntilStale,
  };
}

export interface DrillSummary {
  /** Resources that could be drilled — those with a backup to restore. */
  eligibleCount: number;
  verifiedCount: number;
  staleCount: number;
  failedCount: number;
  neverCount: number;
  /**
   * Slowest measured RTO among currently-verified resources. Null when nothing
   * is verified — which is different from zero, and the difference matters.
   */
  worstRtoMinutes: number | null;
  /** Median measured RTO, for the "typically" line. Null when nothing is verified. */
  medianRtoMinutes: number | null;
}

export function summarizeDrills(rows: readonly DrillCoverageRow[]): DrillSummary {
  let verified = 0;
  let stale = 0;
  let failed = 0;
  let never = 0;
  const rtos: number[] = [];
  for (const row of rows) {
    switch (row.standing) {
      case "verified":
        verified += 1;
        break;
      case "stale":
        stale += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "never":
        never += 1;
        break;
    }
    // Only currently-verified RTOs: a measurement from a drill that has since
    // gone stale is a number about a system that has changed underneath it.
    if (row.standing === "verified" && row.verifiedRtoMinutes != null) {
      rtos.push(row.verifiedRtoMinutes);
    }
  }
  rtos.sort((a, b) => a - b);
  const median = rtos.length === 0 ? null : (rtos[Math.floor((rtos.length - 1) / 2)] ?? null);
  return {
    eligibleCount: rows.length,
    verifiedCount: verified,
    staleCount: stale,
    failedCount: failed,
    neverCount: never,
    worstRtoMinutes: rtos.length === 0 ? null : (rtos[rtos.length - 1] ?? null),
    medianRtoMinutes: median,
  };
}

/** "3h 20m", "45m", "2d 4h" — an RTO is read by a person, not a chart. */
export function formatRto(minutes: number | null): string {
  if (minutes == null) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
