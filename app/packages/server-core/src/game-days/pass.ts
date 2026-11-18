/**
 * The poller's game-day pass: injects an armed game day's failure at its
 * start, watches the detectors while it runs, undoes it at the time limit (or
 * on "end now" / abort), and waits for the watched probes to confirm
 * recovery.
 *
 * What makes it safe, in the order it matters:
 *
 * - **The undo is always reachable.** Each target's undo state is written
 *   before its inject is attempted (`prepareFailure` reads, the row is
 *   written, then `injectFailure` runs), so a process that dies between the
 *   provider call and the next write still knows how to put the resource
 *   back. A game day found mid-injection after a restart is reverted, never
 *   resumed (`interrupted`): half an experiment is not the experiment anybody
 *   confirmed.
 * - **One replica at a time.** `claimed_until` is the lease, separate from the
 *   due column `next_check_at`, so "end now" makes a game day due at once
 *   without letting a second replica start on it while the first is still
 *   injecting. A replica that dies lets the lease run out and the next one
 *   carries on from the stored state.
 * - **Every state change is conditional** on the status it read, the same
 *   rule as the store's, so a person and the pass never both move a game day.
 * - **Undo never gives up quietly.** A failing undo is retried with backoff;
 *   after `undoAttemptsMax` attempts the game day is parked as `undo_failed`,
 *   which every surface shows in red with a retry, rather than being marked
 *   complete with a resource still broken.
 * - **A change freeze stops the start, never the undo.** Somebody else's
 *   freeze in effect at the start cancels the game day; the undo runs whatever
 *   freeze is in effect, including the one the game day opened itself.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  EMPTY_GAME_DAY_SIGNALS,
  GAME_DAY_ACTIVE_STATUSES,
  GAME_DAY_LIMITS,
  mergeGameDaySignals,
  type GameDayEndReason,
  type GameDayStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { auditLogs, changeFreezes, gameDays, gameDayTargets } from "../db/schema";
import { findActiveChangeFreeze } from "../change-freezes";
import { getServiceRecord, resolveServiceMembers } from "../service-catalog/store";
import { injectFailureTarget, prepareFailureTarget, undoFailureTarget } from "./actions";
import { sampleGameDaySignals, watchedProbesRecovered } from "./signals";
import type { GameDayRow, GameDayTargetRow } from "./store";

/** How long a claim holds a game day. Longer than any one step's provider calls. */
export const GAME_DAY_LEASE_MS = 5 * 60_000;
/** How often a running or recovering game day is looked at. */
export const GAME_DAY_WATCH_MS = 15_000;
/** First undo retry delay; doubles per attempt up to five minutes. */
export const GAME_DAY_UNDO_RETRY_MS = 15_000;

export interface GameDayPassOptions {
  limit?: number;
  /** Fixed clock for tests. */
  now?: () => number;
}

export interface GameDayPassResult {
  claimed: number;
  injected: number;
  reverted: number;
  completed: number;
  failed: number;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1000);

async function claimDueGameDays(limit: number): Promise<string[]> {
  const rows = await db.execute(sql`
    UPDATE game_days
    SET claimed_until = now() + ${GAME_DAY_LEASE_MS}::float8 * interval '1 millisecond'
    WHERE id IN (
      SELECT id FROM game_days
      WHERE status IN (${sql.join(
        GAME_DAY_ACTIVE_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )})
        AND next_check_at IS NOT NULL
        AND next_check_at <= now()
        AND (claimed_until IS NULL OR claimed_until < now())
      ORDER BY next_check_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => String(r["id"]));
}

/** Release the claim and say when to look next. An end requested meanwhile wins. */
async function release(id: string, nextCheckAt: Date | null): Promise<void> {
  await db
    .update(gameDays)
    .set({
      claimedUntil: null,
      nextCheckAt:
        nextCheckAt === null
          ? null
          : sql`CASE WHEN ${gameDays.endRequestedAt} IS NOT NULL AND ${gameDays.status} IN ('injecting', 'running') THEN now() ELSE ${nextCheckAt.toISOString()}::timestamp END`,
      updatedAt: new Date(),
    })
    .where(eq(gameDays.id, id));
}

/** Move status from what we read; false when somebody else already moved it. */
async function moveStatus(
  row: GameDayRow,
  to: GameDayStatus,
  set: Partial<typeof gameDays.$inferInsert> = {},
): Promise<boolean> {
  const updated = await db
    .update(gameDays)
    .set({ ...set, status: to, updatedAt: new Date() })
    .where(and(eq(gameDays.id, row.id), eq(gameDays.status, row.status)))
    .returning({ id: gameDays.id });
  if (updated.length) row.status = to;
  return updated.length > 0;
}

async function updateTarget(id: string, set: Partial<typeof gameDayTargets.$inferInsert>) {
  await db
    .update(gameDayTargets)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(gameDayTargets.id, id));
}

async function audit(
  row: GameDayRow,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      organizationId: row.organizationId,
      userId: row.armedByUserId,
      action: `game_day.${action}`,
      entityType: "game_day",
      entityId: row.id,
      metadata: { name: row.name, ...metadata },
    });
  } catch (err) {
    console.error(`[game-days] audit ${action} for ${row.id} failed:`, err);
  }
}

function targetRef(row: GameDayRow, t: GameDayTargetRow) {
  return {
    organizationId: row.organizationId,
    accountId: t.accountId,
    pluginId: t.pluginId,
    resourceTypeId: t.resourceTypeId,
    resourceId: t.resourceId,
    actionId: t.actionId,
  };
}

async function loadTargets(gameDayId: string): Promise<GameDayTargetRow[]> {
  return db
    .select()
    .from(gameDayTargets)
    .where(eq(gameDayTargets.gameDayId, gameDayId))
    .orderBy(asc(gameDayTargets.position));
}

/** Targets, plus the service's members when it names one: what alerts may be about. */
async function relatedResourceIds(row: GameDayRow, targets: GameDayTargetRow[]): Promise<string[]> {
  const ids = new Set(targets.map((t) => t.resourceId));
  if (row.serviceId) {
    try {
      const svc = await getServiceRecord(row.organizationId, row.serviceId);
      if (svc) {
        const members = await resolveServiceMembers(row.organizationId, [svc]);
        for (const m of members.get(svc.id)?.members ?? []) ids.add(m.resourceId);
      }
    } catch (err) {
      console.error(`[game-days] service members for ${row.id} unavailable:`, err);
    }
  }
  return [...ids];
}

async function openFreeze(row: GameDayRow, now: Date): Promise<string | null> {
  try {
    const id = randomUUID();
    // Bounded so a game day that never completes cannot hold the org frozen.
    const endsAt = new Date(
      now.getTime() + (row.durationMinutes + row.recoveryTimeoutMinutes + 15) * 60_000,
    );
    await db.insert(changeFreezes).values({
      id,
      organizationId: row.organizationId,
      name: `Game day: ${row.name}`.slice(0, 120),
      reason: "Opened by a game day for its run.",
      startsAt: now,
      endsAt,
      active: true,
      createdByUserId: row.armedByUserId,
      endedByUserId: null,
    });
    return id;
  } catch (err) {
    console.error(`[game-days] opening the change freeze for ${row.id} failed:`, err);
    return null;
  }
}

async function closeFreeze(row: GameDayRow, now: Date): Promise<void> {
  if (!row.freezeId) return;
  try {
    await db
      .update(changeFreezes)
      .set({ active: false, endsAt: now, updatedAt: now })
      .where(
        and(
          eq(changeFreezes.id, row.freezeId),
          eq(changeFreezes.organizationId, row.organizationId),
          eq(changeFreezes.active, true),
        ),
      );
  } catch (err) {
    console.error(`[game-days] ending the change freeze for ${row.id} failed:`, err);
  }
}

async function recordSignals(row: GameDayRow): Promise<void> {
  if (!row.injectedAt) return;
  const observed = await sampleGameDaySignals({
    id: row.id,
    organizationId: row.organizationId,
    serviceId: row.serviceId,
    injectedAt: row.injectedAt,
    watchedProbeIds: row.watchedProbeIds,
    watchedSloIds: row.watchedSloIds,
    relatedResourceIds: row.relatedResourceIds,
  });
  if (Object.keys(observed).length === 0) return;
  const merged = mergeGameDaySignals({ ...EMPTY_GAME_DAY_SIGNALS, ...row.signals }, observed);
  row.signals = merged;
  await db.update(gameDays).set({ signals: merged }).where(eq(gameDays.id, row.id));
}

/** `armed` and due: inject every target, or revert whatever got in. */
async function inject(row: GameDayRow, now: Date): Promise<"injected" | "cancelled" | "failed"> {
  if (row.startsAt > now) {
    await release(row.id, row.startsAt);
    return "cancelled";
  }
  const freeze = await findActiveChangeFreeze(row.organizationId, now);
  if (freeze) {
    await moveStatus(row, "cancelled", {
      endReason: "freeze",
      lastError: `Not started: the change freeze "${freeze.name}" was in effect`,
      completedAt: now,
    });
    await audit(row, "cancel", { reason: "freeze", freezeId: freeze.id });
    await release(row.id, null);
    return "cancelled";
  }

  const targets = await loadTargets(row.id);
  const related = await relatedResourceIds(row, targets);
  if (!(await moveStatus(row, "injecting", { injectedAt: now, relatedResourceIds: related }))) {
    await release(row.id, now);
    return "cancelled";
  }
  row.injectedAt = now;
  row.relatedResourceIds = related;
  if (row.freezeDuringRun) {
    const freezeId = await openFreeze(row, now);
    if (freezeId) {
      row.freezeId = freezeId;
      await db.update(gameDays).set({ freezeId }).where(eq(gameDays.id, row.id));
    }
  }
  await audit(row, "inject", { targets: targets.map((t) => `${t.displayName}: ${t.actionId}`) });

  let failure: string | null = null;
  for (const t of targets) {
    if (t.state !== "pending") continue;
    try {
      const prepared = await prepareFailureTarget(targetRef(row, t));
      if (prepared.alreadyInEffect) {
        await updateTarget(t.id, { state: "skipped", stateBefore: prepared.currentState ?? null });
        continue;
      }
      // The undo state goes down before the inject is attempted.
      await updateTarget(t.id, {
        state: "injecting",
        undoState: prepared.undo,
        stateBefore: prepared.currentState ?? null,
      });
    } catch (e) {
      failure = `${t.displayName}: ${errorText(e)}`;
      await updateTarget(t.id, { state: "inject_failed", lastError: errorText(e) });
      break;
    }
    try {
      await injectFailureTarget(targetRef(row, t));
      await updateTarget(t.id, { state: "injected", injectedAt: new Date() });
    } catch (e) {
      // The call may still have landed (a timeout), so this one is undone too.
      failure = `${t.displayName}: ${errorText(e)}`;
      await updateTarget(t.id, { state: "inject_failed", lastError: errorText(e) });
      break;
    }
  }

  if (failure) {
    console.error(`[game-days] inject failed for ${row.id}, undoing: ${failure}`);
    await moveStatus(row, "reverting", {
      endReason: "inject_failed",
      endRequestedAt: new Date(),
      lastError: `Inject failed, so everything injected is being undone. ${failure}`,
    });
    return "failed";
  }
  const endsAt = new Date(now.getTime() + row.durationMinutes * 60_000);
  await moveStatus(row, "running", { endsAt });
  row.endsAt = endsAt;
  return "injected";
}

/** Undo every target that may be broken. True when nothing is left to undo. */
async function revert(row: GameDayRow): Promise<"done" | "retry" | "failed"> {
  const targets = await loadTargets(row.id);
  const pending = targets.filter(
    (t) =>
      t.state === "injecting" ||
      t.state === "injected" ||
      (t.state === "inject_failed" && t.undoState !== null),
  );
  let exhausted = false;
  let lastError: string | null = null;
  for (const t of pending) {
    try {
      await undoFailureTarget(targetRef(row, t), t.undoState ?? {});
      await updateTarget(t.id, { state: "reverted", revertedAt: new Date(), lastError: null });
    } catch (e) {
      const attempts = t.attempts + 1;
      lastError = `${t.displayName}: ${errorText(e)}`;
      const giveUp = attempts >= GAME_DAY_LIMITS.undoAttemptsMax;
      if (giveUp) exhausted = true;
      // An inject_failed target keeps its state (and its undo) for the next try.
      await updateTarget(t.id, {
        attempts,
        lastError: errorText(e),
        ...(giveUp ? { state: "undo_failed" as const } : {}),
      });
      console.error(`[game-days] undo attempt ${attempts} failed for ${row.id}: ${lastError}`);
    }
  }
  if (lastError === null) return "done";
  if (exhausted) {
    await moveStatus(row, "undo_failed", {
      lastError: `The undo kept failing. Check the resource and retry. ${lastError}`,
    });
    await audit(row, "undo_failed", { error: lastError });
    return "failed";
  }
  await db
    .update(gameDays)
    .set({ lastError: `Undo retrying. ${lastError}` })
    .where(eq(gameDays.id, row.id));
  return "retry";
}

function undoRetryDelay(targets: GameDayTargetRow[]): number {
  const attempts = Math.max(0, ...targets.map((t) => t.attempts));
  return Math.min(5 * 60_000, GAME_DAY_UNDO_RETRY_MS * 2 ** Math.max(0, attempts - 1));
}

async function complete(row: GameDayRow, now: Date, recoveredAt: Date | null, note?: string) {
  await moveStatus(row, "completed", {
    completedAt: now,
    recoveredAt,
    ...(note ? { lastError: note } : {}),
  });
  await closeFreeze(row, now);
  await audit(row, "complete", { recoveredAt: recoveredAt?.toISOString() ?? null });
}

/** One game day, from whatever state it was claimed in. */
async function work(row: GameDayRow, now: Date, result: GameDayPassResult): Promise<void> {
  if (row.status === "armed") {
    const outcome = await inject(row, now);
    if (outcome === "cancelled") return;
    if (outcome === "injected") {
      result.injected += 1;
      await release(row.id, new Date(now.getTime() + GAME_DAY_WATCH_MS));
      return;
    }
    // Inject failed: fall through to the undo straight away.
  } else if (row.status === "injecting") {
    // Found mid-injection: the replica doing it died. Revert, never resume.
    await moveStatus(row, "reverting", {
      endReason: "interrupted",
      endRequestedAt: now,
      lastError: "The injection was interrupted, so the game day is being undone.",
    });
  }

  if (row.status === "running") {
    await recordSignals(row);
    const due = row.endsAt !== null && row.endsAt <= now;
    if (!due && row.endRequestedAt === null) {
      await release(row.id, new Date(now.getTime() + GAME_DAY_WATCH_MS));
      return;
    }
    const reason: GameDayEndReason = row.endReason ?? (due ? "time_limit" : "ended");
    await moveStatus(row, "reverting", {
      endReason: reason,
      endRequestedAt: row.endRequestedAt ?? now,
    });
    await audit(row, "end", { reason });
  }

  if (row.status === "reverting") {
    await recordSignals(row);
    const outcome = await revert(row);
    if (outcome === "failed") {
      result.failed += 1;
      await release(row.id, null);
      return;
    }
    if (outcome === "retry") {
      await release(row.id, new Date(now.getTime() + undoRetryDelay(await loadTargets(row.id))));
      return;
    }
    result.reverted += 1;
    await audit(row, "undo", {});
    const undoneAt = new Date();
    if (!(await moveStatus(row, "recovering", { undoneAt, lastError: null }))) {
      await release(row.id, now);
      return;
    }
    row.undoneAt = undoneAt;
  }

  if (row.status === "recovering") {
    await recordSignals(row);
    const undoneAt = row.undoneAt ?? now;
    if (row.watchedProbeIds.length === 0) {
      await complete(row, now, null);
      result.completed += 1;
      await release(row.id, null);
      return;
    }
    const recoveredAt = await watchedProbesRecovered(
      row.organizationId,
      row.watchedProbeIds,
      undoneAt,
    );
    if (recoveredAt) {
      await complete(row, now, recoveredAt);
      result.completed += 1;
      await release(row.id, null);
      return;
    }
    if (now.getTime() > undoneAt.getTime() + row.recoveryTimeoutMinutes * 60_000) {
      await complete(
        row,
        now,
        null,
        `The watched probes had not recovered ${row.recoveryTimeoutMinutes} minutes after the undo.`,
      );
      result.completed += 1;
      await release(row.id, null);
      return;
    }
    await release(row.id, new Date(now.getTime() + GAME_DAY_WATCH_MS));
    return;
  }

  // Anything else (moved by a person meanwhile): look again soon.
  await release(row.id, GAME_DAY_ACTIVE_STATUSES.includes(row.status) ? now : null);
}

/**
 * One pass: claim due game days and move each as far as it can go. Nothing
 * throws into the poller; one game day's failure never blocks the rest.
 */
export async function runGameDayPass(options: GameDayPassOptions = {}): Promise<GameDayPassResult> {
  const result: GameDayPassResult = {
    claimed: 0,
    injected: 0,
    reverted: 0,
    completed: 0,
    failed: 0,
  };
  const ids = await claimDueGameDays(options.limit ?? 4);
  result.claimed = ids.length;
  if (ids.length === 0) return result;
  const rows = await db.select().from(gameDays).where(inArray(gameDays.id, ids));
  for (const row of rows) {
    const now = new Date(options.now?.() ?? Date.now());
    try {
      await work(row, now, result);
    } catch (e) {
      result.failed += 1;
      console.error(`[game-days] pass failed for ${row.id}:`, e);
      // Let the lease lapse sooner than its full length, so it is retried.
      await release(row.id, new Date(now.getTime() + GAME_DAY_WATCH_MS)).catch(() => undefined);
    }
  }
  return result;
}
