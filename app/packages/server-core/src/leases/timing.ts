/**
 * Pure timing + message rendering for the auto-delete lease pass. No I/O
 * lives here so the two-announcements contract is unit-testable without a
 * database — the `expiry/summary.ts` split.
 *
 * The contract the pass enforces, in words:
 *
 * 1. **Two announcements before any delete, always.** The first warning is
 *    targeted ~72h before expiry and the final one ~24h before; a lease
 *    shorter than that horizon compresses proportionally (warnings at 2/3 and
 *    11/12 of its lifetime), and a lease created inside the final window gets
 *    warning 1 immediately with warning 2 no sooner than half the remaining
 *    time. If the poller was down and expiry arrives with warnings unsent,
 *    the delete is pushed later — both warnings still go out first, separated
 *    by at least {@link LEASE_MIN_WARNING_GAP_MS}.
 * 2. **Delete only after expiry AND both warnings.** `nextLeaseStep` never
 *    yields `"delete"` until `expiresAt` has passed and both warning stamps
 *    are set.
 */

/** Target lead of the first announcement before expiry. */
export const LEASE_WARN1_LEAD_MS = 72 * 60 * 60 * 1000;
/** Target lead of the final announcement before expiry. */
export const LEASE_WARN2_LEAD_MS = 24 * 60 * 60 * 1000;
/**
 * Least time between the two announcements when the schedule has collapsed
 * (lease created — or discovered by a recovering poller — at/after expiry).
 * One pass lease, so the delete lands two ticks later at the earliest.
 */
export const LEASE_MIN_WARNING_GAP_MS = 10 * 60 * 1000;

export interface LeaseWarningTargets {
  /** Planned instant of the first announcement, epoch ms. */
  warn1At: number;
  /** Planned instant of the final announcement, epoch ms. */
  warn2At: number;
}

/**
 * The planned announcement instants for a lease's lifetime.
 *
 * Long lease (> 72h): expiry − 72h and expiry − 24h. Shorter leases
 * compress proportionally — `expiry − min(72h, duration/3)` puts warning 1
 * at 2/3 of the lifetime, `expiry − min(24h, duration/12)` puts warning 2 at
 * 11/12. A lease no longer than the final window (24h) sends warning 1
 * immediately and warning 2 at half the lifetime.
 */
export function leaseWarningTargets(createdAtMs: number, expiresAtMs: number): LeaseWarningTargets {
  const duration = Math.max(0, expiresAtMs - createdAtMs);
  if (duration <= LEASE_WARN2_LEAD_MS) {
    return { warn1At: createdAtMs, warn2At: createdAtMs + duration / 2 };
  }
  return {
    warn1At: expiresAtMs - Math.min(LEASE_WARN1_LEAD_MS, duration / 3),
    warn2At: expiresAtMs - Math.min(LEASE_WARN2_LEAD_MS, duration / 12),
  };
}

/** The timing-relevant half of a lease row, epoch ms. */
export interface LeaseTimingState {
  createdAt: number;
  expiresAt: number;
  /** When the first announcement actually went out; null until sent. */
  firstWarningAt: number | null;
  /** When the final announcement actually went out; null until sent. */
  finalWarningAt: number | null;
}

export type LeaseStep =
  | { kind: "warn1" }
  | { kind: "warn2" }
  | { kind: "delete" }
  /** Nothing due yet — re-check at `until`. */
  | { kind: "wait"; until: number };

/**
 * What the pass should do with a claimed lease right now. Deterministic in
 * `(state, now)`; the pass records each sent warning into the state, so a
 * restart or a re-claim recomputes the same answer instead of re-announcing.
 *
 * Warning 2 is due at the later of its planned target and "half the time
 * remaining after warning 1 actually went out" (floored at
 * {@link LEASE_MIN_WARNING_GAP_MS}) — a late first warning therefore always
 * buys a real gap before the final one, and expiry with warnings outstanding
 * pushes the delete later rather than skipping an announcement.
 */
export function nextLeaseStep(state: LeaseTimingState, now: number): LeaseStep {
  const targets = leaseWarningTargets(state.createdAt, state.expiresAt);
  if (state.firstWarningAt === null) {
    return now >= targets.warn1At ? { kind: "warn1" } : { kind: "wait", until: targets.warn1At };
  }
  if (state.finalWarningAt === null) {
    const gap = Math.max((state.expiresAt - state.firstWarningAt) / 2, LEASE_MIN_WARNING_GAP_MS);
    const due = Math.max(targets.warn2At, state.firstWarningAt + gap);
    return now >= due ? { kind: "warn2" } : { kind: "wait", until: due };
  }
  return now >= state.expiresAt ? { kind: "delete" } : { kind: "wait", until: state.expiresAt };
}

/** "3d" / "26h" / "45m" — rough humanized duration for message copy. */
export function leaseDurationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The message-relevant half of a lease row. */
export interface LeaseMessageInput {
  displayName: string;
  note: string | null;
  /** Epoch ms of the lease deadline. */
  expiresAt: number;
}

export interface LeaseMessage {
  title: string;
  /** Plain-text lines; transports join with their own separators. */
  lines: string[];
}

/** Copy for the two announcements. `expiryAlerts`-trigger fan-out renders it. */
export function leaseWarningMessage(
  step: "warn1" | "warn2",
  lease: LeaseMessageInput,
  now: number,
): LeaseMessage {
  const remaining = lease.expiresAt - now;
  const when =
    remaining > 0 ? `in ~${leaseDurationLabel(remaining)}` : "as soon as it has been announced";
  const title =
    step === "warn1"
      ? `Lease expiring: auto-delete of ${lease.displayName} is approaching`
      : `Lease expiring: ${lease.displayName} will be auto-deleted ${when}`;
  const lines = [
    step === "warn1"
      ? `${lease.displayName} is leased until ${new Date(lease.expiresAt).toISOString()} and will be deleted ${when}.`
      : `Final warning: ${lease.displayName} will be deleted ${when} (lease expires ${new Date(lease.expiresAt).toISOString()}).`,
  ];
  if (lease.note) lines.push(`Note: ${lease.note}`);
  lines.push("Cancel or extend the lease from the resource's Lease tab to keep it.");
  return { title, lines };
}

/** Copy for the completion notifications (success / gave up). */
export function leaseOutcomeMessage(
  outcome: "deleted" | "failed",
  lease: LeaseMessageInput,
  error?: string,
): LeaseMessage {
  if (outcome === "deleted") {
    return {
      title: `Lease expired: ${lease.displayName} was deleted`,
      lines: [
        `${lease.displayName} reached the end of its lease and was deleted as requested.`,
        ...(lease.note ? [`Note: ${lease.note}`] : []),
      ],
    };
  }
  return {
    title: `Lease auto-delete failed: ${lease.displayName}`,
    lines: [
      `${lease.displayName}'s lease expired but the delete kept failing and was given up on.`,
      ...(error ? [`Last error: ${error}`] : []),
      "The resource still exists — delete it manually or re-arm the lease.",
    ],
  };
}
