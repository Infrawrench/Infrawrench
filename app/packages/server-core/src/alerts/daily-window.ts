/**
 * The shared claim/scan/deliver/release protocol behind the daily alert
 * radars (expiry, quotas, posture). Each radar used to carry its own verbatim
 * copy; the invariants live here once and the radars supply only what genuinely
 * differs — the settings table, the shipped-default insert values, and the
 * scan-and-deliver body.
 *
 * The protocol, unchanged from the originals:
 *
 * 1. **One scan per org per window** (`cooldownMs`), claimed with a single
 *    conditional upsert on the settings table's `last_notified_at` — the exact
 *    statement `drift/alerts.ts` pioneered. Whoever wins the statement scans,
 *    everyone else is suppressed, so N poller replicas racing the same window
 *    still produce one message.
 * 2. **`last_notified_at` means "last alert scan", not "last message".** A
 *    completed scan that found nothing keeps the window spent (the radar's
 *    `deliver` sets `delivery.spent`); only a scan whose message reached
 *    *nobody* (or that threw) is rolled back, so a failed delivery retries next
 *    tick rather than starting a quiet day.
 * 3. **Never throws.** The pass runs inside the poller loop and must not be
 *    able to fail a tick; every error is logged under the radar's prefix.
 *
 * `drift/alerts.ts` stays separate on purpose: it is sync-driven rather than
 * clock-driven (no due-org query), its cooldown is per-org configurable, and a
 * quiet drift window is *released* rather than spent — the `spent` flag here is
 * exactly the semantic that distinguishes the radars from drift.
 */
import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../db/client";
import { accounts } from "../db/schema";

/** What every radar's settings record has to expose to the protocol. */
export interface DailyWindowSettings {
  enabled: boolean;
  lastNotifiedAt: Date | null;
}

/** The four columns every radar settings table shares. */
export type DailyWindowTable = PgTable & {
  organizationId: AnyPgColumn;
  enabled: AnyPgColumn;
  lastNotifiedAt: AnyPgColumn;
  updatedAt: AnyPgColumn;
};

/**
 * What the claimed body reports into the release guard. `spent` is the one
 * difference from drift's protocol: a completed scan with nothing to say keeps
 * the window, so the guard must be able to tell "quiet day" apart from
 * "message reached nobody".
 */
export interface WindowDelivery {
  succeeded: number;
  /** True when the scan completed and legitimately consumed the window. */
  spent: boolean;
  /** `null` until the release guard has run; then whether it succeeded. */
  release: null | boolean;
}

/**
 * A radar's per-org outcome: the engine's own statuses plus whatever the
 * radar's `deliver` returns. A radar outcome must not reuse the engine's
 * status names (`disabled`, `cooling-down`, `failed`) — the run loop counts on
 * telling them apart. Every radar status counts as a claimed scan.
 */
export type DailyWindowOutcome<TScan extends { status: string }> =
  | { status: "disabled" }
  | { status: "cooling-down" }
  /**
   * `claimed` is true only after the cooldown claim landed — pre-claim
   * failures (settings read, claim SQL) leave it false so `scanned` stays
   * honest. `released` is whether the claim was rolled back.
   */
  | { status: "failed"; error: string; claimed: boolean; released: boolean }
  | TScan;

export interface DailyWindowResult<TScan extends { status: string }> {
  /** Orgs this pass claimed and scanned. */
  scanned: number;
  /** Orgs whose message reached at least one destination. */
  sent: number;
  /** Per-org outcomes, keyed by organization id. */
  outcomes: Record<string, DailyWindowOutcome<TScan>>;
}

/** The three settings-table statements, bound to one radar's table. */
export interface DailyWindowStore<S extends DailyWindowSettings> {
  findDueOrgs(now: Date, limit: number): Promise<string[]>;
  claimWindow(organizationId: string, settings: S, now: Date): Promise<boolean>;
  releaseWindow(organizationId: string, claimed: Date, prior: Date | null): Promise<void>;
}

/**
 * Bind the protocol's SQL to a radar's settings table.
 *
 * `claimValues` supplies the full insert row for an org with no settings row
 * yet — it must land the shipped defaults the radar's reader already reported
 * (plus `lastNotifiedAt: now`), so a first claim and a later read agree.
 */
export function dailyWindowStore<S extends DailyWindowSettings>({
  table,
  cooldownMs,
  claimValues,
}: {
  table: DailyWindowTable;
  cooldownMs: number;
  claimValues: (organizationId: string, settings: S, now: Date) => Record<string, unknown>;
}): DailyWindowStore<S> {
  return {
    /**
     * Orgs due for a scan: at least one non-deleted account, and either no
     * settings row (shipped defaults: enabled) or enabled with the cooldown
     * elapsed. Bounded and deterministically ordered; an org this pass claims
     * fails the predicate next tick, so a backlog drains across ticks without
     * starving anyone.
     */
    async findDueOrgs(now, limit) {
      const cutoff = new Date(now.getTime() - cooldownMs);
      const rows = await db
        .selectDistinct({ organizationId: accounts.organizationId })
        .from(accounts)
        .leftJoin(table, eq(table.organizationId, accounts.organizationId))
        .where(
          and(
            isNull(accounts.deletedAt),
            or(
              isNull(table.organizationId),
              and(
                eq(table.enabled, true),
                or(isNull(table.lastNotifiedAt), lte(table.lastNotifiedAt, cutoff)),
              ),
            ),
          ),
        )
        .orderBy(accounts.organizationId)
        .limit(limit);
      return rows.map((r) => r.organizationId);
    },

    /**
     * Take the org's scan slot for this window. One statement, exactly like
     * drift's `claimWindow`: the insert covers an org with no settings row (it
     * lands the shipped defaults the reader already reported), the conditional
     * update covers every subsequent window, and reading the existing row
     * inside the same statement is what makes the claim atomic across
     * replicas.
     */
    async claimWindow(organizationId, settings, now) {
      const cutoff = new Date(now.getTime() - cooldownMs);
      const rows = await db
        .insert(table)
        // The cast is the price of a table-generic engine: the constraint
        // guarantees the shared columns exist, and `claimValues` is written
        // against the concrete table in the radar that owns it.
        .values(claimValues(organizationId, settings, now) as never)
        .onConflictDoUpdate({
          target: table.organizationId,
          set: { lastNotifiedAt: now, updatedAt: now } as never,
          // or()/lte(), not a raw sql`` fragment: raw interpolation sends the
          // Date object straight to postgres.js, which rejects it as a bind
          // parameter — comparators map it through the column's serializer.
          // (The ! is exactOptionalPropertyTypes noise; or() with arguments
          // never returns undefined.)
          setWhere: or(isNull(table.lastNotifiedAt), lte(table.lastNotifiedAt, cutoff))!,
        })
        .returning({ organizationId: table.organizationId });
      return rows.length > 0;
    },

    /**
     * Undo a claim whose message reached nobody, restoring the previous value.
     * Conditional on still owning the claim: `claimWindow` stamped
     * `lastNotifiedAt` with its own `now`, so that value is the ownership
     * token — a replica that wedged past the cooldown must not rewind a later
     * replica's claim. Losing the race means someone else owns the window, not
     * an error.
     */
    async releaseWindow(organizationId, claimed, prior) {
      await db
        .update(table)
        .set({ lastNotifiedAt: prior } as never)
        .where(and(eq(table.organizationId, organizationId), eq(table.lastNotifiedAt, claimed)));
    },
  };
}

/** Everything one radar hands the engine. */
export interface DailyWindowConfig<
  S extends DailyWindowSettings,
  TScan extends { status: string },
> {
  /** Log prefix, without brackets — `expiry`, `quotas`, `posture`. */
  logPrefix: string;
  store: DailyWindowStore<S>;
  getSettings(organizationId: string): Promise<S>;
  /**
   * Everything that happens under a won claim: compute the feed, decide
   * whether there is anything to say, and fan it out. Reports transport
   * successes into `delivery` as they land (and sets `delivery.spent` on a
   * legitimately quiet scan), so a throw part-way through the fan-out is
   * distinguishable from a throw before any of it ran. An outcome with
   * `status: "sent"` is what the run loop counts as delivered.
   */
  deliver(organizationId: string, settings: S, now: Date, delivery: WindowDelivery): Promise<TScan>;
}

/**
 * The release invariant: **the window stays spent exactly when the scan
 * completed quietly or at least one transport delivered.** Never throws (a
 * failing rollback must not mask the error that triggered it) and runs at
 * most once, so `catch` and `finally` can both call it. Returns whether the
 * claim ended up released.
 */
async function releaseUnlessDelivered<S extends DailyWindowSettings>(
  config: { logPrefix: string; store: DailyWindowStore<S> },
  organizationId: string,
  claimed: Date,
  prior: Date | null,
  delivery: WindowDelivery,
): Promise<boolean> {
  if (delivery.succeeded > 0 || delivery.spent) return false;
  if (delivery.release !== null) return delivery.release;
  try {
    await config.store.releaseWindow(organizationId, claimed, prior);
    delivery.release = true;
  } catch (err) {
    console.error(
      `[${config.logPrefix}] rolling back the claimed window for org ${organizationId} failed:`,
      err,
    );
    delivery.release = false;
  }
  return delivery.release;
}

/**
 * One org's full claim-scan-deliver-release cycle. Never throws. `claimed` is
 * reported beside the outcome (rather than re-derived from status strings) so
 * the run loop's `scanned` count cannot drift from what actually happened.
 */
async function runOne<S extends DailyWindowSettings, TScan extends { status: string }>(
  config: DailyWindowConfig<S, TScan>,
  organizationId: string,
  now: Date,
): Promise<{ outcome: DailyWindowOutcome<TScan>; claimed: boolean }> {
  try {
    const settings = await config.getSettings(organizationId);
    // The due query already filtered on `enabled`, but the row can change
    // between the read and the claim; re-checking is one comparison.
    if (!settings.enabled) return { outcome: { status: "disabled" }, claimed: false };

    const prior = settings.lastNotifiedAt;
    if (!(await config.store.claimWindow(organizationId, settings, now))) {
      return { outcome: { status: "cooling-down" }, claimed: false };
    }

    const delivery: WindowDelivery = { succeeded: 0, spent: false, release: null };
    try {
      return {
        outcome: await config.deliver(organizationId, settings, now, delivery),
        claimed: true,
      };
    } catch (err) {
      console.error(`[${config.logPrefix}] alert scan for org ${organizationId} failed:`, err);
      return {
        outcome: {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          claimed: true,
          released: await releaseUnlessDelivered(config, organizationId, now, prior, delivery),
        },
        claimed: true,
      };
    } finally {
      await releaseUnlessDelivered(config, organizationId, now, prior, delivery);
    }
  } catch (err) {
    // Nothing was claimed on this path — settings or the claim statement
    // itself failed — so there is nothing to roll back.
    console.error(`[${config.logPrefix}] alert scan for org ${organizationId} failed:`, err);
    return {
      outcome: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        claimed: false,
        released: false,
      },
      claimed: false,
    };
  }
}

/**
 * The poller pass: claim up to `limit` due orgs and run each one's scan.
 * Sequential on purpose — the batch is small and each scan is a handful of
 * indexed reads; parallel fan-outs would just interleave transport calls.
 */
export async function runDailyAlertWindows<
  S extends DailyWindowSettings,
  TScan extends { status: string },
>(
  config: DailyWindowConfig<S, TScan>,
  { limit = 4 }: { limit?: number } = {},
  now = new Date(),
): Promise<DailyWindowResult<TScan>> {
  const result: DailyWindowResult<TScan> = { scanned: 0, sent: 0, outcomes: {} };
  let due: string[];
  try {
    due = await config.store.findDueOrgs(now, limit);
  } catch (err) {
    console.error(`[${config.logPrefix}] finding due orgs failed:`, err);
    return result;
  }

  for (const organizationId of due) {
    const { outcome, claimed } = await runOne(config, organizationId, now);
    result.outcomes[organizationId] = outcome;
    // Only count orgs that actually claimed a window. Pre-claim outcomes
    // (`disabled`, `cooling-down`, unclaimed `failed`) leave the cooldown
    // untouched and must not inflate `scanned`.
    if (claimed) result.scanned += 1;
    if (outcome.status === "sent") result.sent += 1;
  }
  return result;
}
