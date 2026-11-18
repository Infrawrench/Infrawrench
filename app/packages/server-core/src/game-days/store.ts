/**
 * Game days: storage, the wire shape, and every state change a person makes
 * (plan, edit, arm, disarm, end, abort, retry the undo). The poller pass
 * (`./pass.ts`) makes the rest.
 *
 * Each state change is a conditional `UPDATE ... WHERE status = <expected>`,
 * so a person and the pass can never both move one game day: whichever lands
 * second matches nothing and is told so (409), rather than overwriting.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import {
  EMPTY_GAME_DAY_SIGNALS,
  GAME_DAY_LIMITS,
  computeGameDayReport,
  stripControlCharacters,
  type GameDay,
  type GameDayAlert,
  type GameDayCandidates,
  type GameDayDetail,
  type GameDayInput,
  type GameDayStatus,
  type GameDayTarget,
  type GameDayWatchedProbe,
} from "@infrawrench/client-core";
import { failureActionsForType } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import {
  gameDayAlerts,
  gameDays,
  gameDayTargets,
  resources,
  services,
  slos,
  syntheticProbes,
  users,
} from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { listServiceRecords, resolveServiceMembers } from "../service-catalog/store";
import { failureActionsFor } from "./actions";

/** A refusal with the HTTP status it means. */
export class GameDayRefusal extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "GameDayRefusal";
  }
}

export type GameDayRow = typeof gameDays.$inferSelect;
export type GameDayTargetRow = typeof gameDayTargets.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Statuses a person may delete a game day in: nothing is, or will be, broken. */
const DELETABLE: readonly GameDayStatus[] = ["planned", "completed", "cancelled"];

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

function targetToWire(row: GameDayTargetRow): GameDayTarget {
  return {
    id: row.id,
    resourceId: row.resourceId,
    accountId: row.accountId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    displayName: row.displayName,
    actionId: row.actionId,
    actionLabel: row.actionLabel,
    undoLabel: row.undoLabel,
    state: row.state,
    stateBefore: row.stateBefore,
    injectedAt: iso(row.injectedAt),
    revertedAt: iso(row.revertedAt),
    attempts: row.attempts,
    lastError: row.lastError,
  };
}

interface WireLabels {
  probes: Map<string, GameDayWatchedProbe>;
  services: Map<string, string>;
  emails: Map<string, string>;
}

async function loadLabels(organizationId: string, rows: readonly GameDayRow[]): Promise<WireLabels> {
  const probeIds = [...new Set(rows.flatMap((r) => r.watchedProbeIds))];
  const serviceIds = [...new Set(rows.flatMap((r) => (r.serviceId ? [r.serviceId] : [])))];
  const userIds = [...new Set(rows.flatMap((r) => (r.armedByUserId ? [r.armedByUserId] : [])))];
  const [probeRows, serviceRows, userRows] = await Promise.all([
    probeIds.length
      ? db
          .select({
            id: syntheticProbes.id,
            name: syntheticProbes.name,
            status: syntheticProbes.status,
          })
          .from(syntheticProbes)
          .where(
            and(
              eq(syntheticProbes.organizationId, organizationId),
              inArray(syntheticProbes.id, probeIds),
            ),
          )
      : [],
    serviceIds.length
      ? db
          .select({ id: services.id, name: services.name })
          .from(services)
          .where(and(eq(services.organizationId, organizationId), inArray(services.id, serviceIds)))
      : [],
    userIds.length
      ? db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, userIds))
      : [],
  ]);
  return {
    probes: new Map(probeRows.map((p) => [p.id, p])),
    services: new Map(serviceRows.map((s) => [s.id, s.name])),
    emails: new Map(userRows.map((u) => [u.id, u.email])),
  };
}

export function gameDayToWire(
  row: GameDayRow,
  targets: readonly GameDayTargetRow[],
  labels: WireLabels,
): GameDay {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    serviceId: row.serviceId,
    serviceName: row.serviceId ? (labels.services.get(row.serviceId) ?? null) : null,
    status: row.status,
    endReason: row.endReason,
    startsAt: row.startsAt.toISOString(),
    durationMinutes: row.durationMinutes,
    recoveryTimeoutMinutes: row.recoveryTimeoutMinutes,
    freezeDuringRun: row.freezeDuringRun,
    freezeId: row.freezeId,
    // A deleted probe stays listed under its id: the game day watched it.
    watchedProbes: row.watchedProbeIds.map(
      (id) => labels.probes.get(id) ?? { id, name: id, status: "unknown" as const },
    ),
    watchedSloIds: row.watchedSloIds,
    armedAt: iso(row.armedAt),
    armedByUserId: row.armedByUserId,
    armedByEmail: row.armedByUserId ? (labels.emails.get(row.armedByUserId) ?? null) : null,
    injectedAt: iso(row.injectedAt),
    endsAt: iso(row.endsAt),
    endRequestedAt: iso(row.endRequestedAt),
    undoneAt: iso(row.undoneAt),
    recoveredAt: iso(row.recoveredAt),
    completedAt: iso(row.completedAt),
    lastError: row.lastError,
    signals: { ...EMPTY_GAME_DAY_SIGNALS, ...row.signals },
    targets: targets.map(targetToWire),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function targetsFor(gameDayIds: readonly string[]): Promise<Map<string, GameDayTargetRow[]>> {
  const out = new Map<string, GameDayTargetRow[]>();
  if (gameDayIds.length === 0) return out;
  const rows = await db
    .select()
    .from(gameDayTargets)
    .where(inArray(gameDayTargets.gameDayId, [...gameDayIds]))
    .orderBy(asc(gameDayTargets.position));
  for (const row of rows) {
    const list = out.get(row.gameDayId) ?? [];
    list.push(row);
    out.set(row.gameDayId, list);
  }
  return out;
}

export async function getGameDayRow(
  organizationId: string,
  id: string,
): Promise<GameDayRow | null> {
  const [row] = await db
    .select()
    .from(gameDays)
    .where(and(eq(gameDays.id, id), eq(gameDays.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

async function wireOne(row: GameDayRow): Promise<GameDay> {
  const [targets, labels] = await Promise.all([
    targetsFor([row.id]),
    loadLabels(row.organizationId, [row]),
  ]);
  return gameDayToWire(row, targets.get(row.id) ?? [], labels);
}

/** Every game day, newest start first. */
export async function listGameDays(organizationId: string): Promise<GameDay[]> {
  const rows = await db
    .select()
    .from(gameDays)
    .where(eq(gameDays.organizationId, organizationId))
    .orderBy(desc(gameDays.startsAt))
    .limit(200);
  const [targets, labels] = await Promise.all([
    targetsFor(rows.map((r) => r.id)),
    loadLabels(organizationId, rows),
  ]);
  return rows.map((row) => gameDayToWire(row, targets.get(row.id) ?? [], labels));
}

export async function getGameDayDetail(
  organizationId: string,
  id: string,
): Promise<GameDayDetail | null> {
  const row = await getGameDayRow(organizationId, id);
  if (!row) return null;
  const [gameDay, alertRows] = await Promise.all([
    wireOne(row),
    db
      .select()
      .from(gameDayAlerts)
      .where(eq(gameDayAlerts.gameDayId, id))
      .orderBy(asc(gameDayAlerts.at))
      .limit(500),
  ]);
  const alerts: GameDayAlert[] = alertRows.map((a) => ({
    id: a.id,
    at: a.at.toISOString(),
    trigger: a.trigger,
    severity: a.severity,
    title: a.title,
    related: a.related,
    paged: a.paged,
    unrouted: a.unrouted,
  }));
  return { gameDay, alerts, report: computeGameDayReport(gameDay) };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  actionId: string;
  actionLabel: string;
  undoLabel: string;
}

/**
 * Check a decoded body against the organization: every target a live resource
 * whose plugin declares the named failure action, the service, probes and SLOs
 * the org's own. Returns the targets with the labels the record keeps.
 */
export async function resolveGameDayInput(
  organizationId: string,
  input: GameDayInput,
  now: number = Date.now(),
): Promise<ResolvedTarget[]> {
  const startsAt = Date.parse(input.startsAt);
  if (!Number.isFinite(startsAt)) throw new GameDayRefusal("startsAt is not a date");
  if (startsAt > now + GAME_DAY_LIMITS.scheduleAheadDaysMax * 86_400_000) {
    throw new GameDayRefusal(
      `A game day can be scheduled at most ${GAME_DAY_LIMITS.scheduleAheadDaysMax} days ahead`,
    );
  }
  const ids = input.targets.map((t) => t.resourceId);
  if (new Set(ids).size !== ids.length) {
    throw new GameDayRefusal("Each resource can be a target once");
  }

  const rows = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
    })
    .from(resources)
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(resources.id, ids),
        isNull(resources.deletedAt),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolved: ResolvedTarget[] = [];
  for (const target of input.targets) {
    const row = byId.get(target.resourceId);
    if (!row) throw new GameDayRefusal(`Resource ${target.resourceId} not found`, 404);
    const actions = await failureActionsFor(row.pluginId, row.resourceTypeId);
    const action = actions.find((a) => a.id === target.actionId);
    if (!action) {
      throw new GameDayRefusal(
        `${row.displayName} does not support the failure action "${target.actionId}"`,
      );
    }
    resolved.push({
      resourceId: row.id,
      accountId: row.accountId,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
      displayName: row.displayName,
      actionId: action.id,
      actionLabel: action.label,
      undoLabel: action.undoLabel,
    });
  }

  if (input.serviceId) {
    const [svc] = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.id, input.serviceId), eq(services.organizationId, organizationId)));
    if (!svc) throw new GameDayRefusal("Service not found", 404);
  }
  if (input.watchedProbeIds.length) {
    const found = await db
      .select({ id: syntheticProbes.id })
      .from(syntheticProbes)
      .where(
        and(
          eq(syntheticProbes.organizationId, organizationId),
          inArray(syntheticProbes.id, input.watchedProbeIds),
        ),
      );
    if (found.length !== new Set(input.watchedProbeIds).size) {
      throw new GameDayRefusal("A watched probe was not found", 404);
    }
  }
  if (input.watchedSloIds.length) {
    const found = await db
      .select({ id: slos.id })
      .from(slos)
      .where(and(eq(slos.organizationId, organizationId), inArray(slos.id, input.watchedSloIds)));
    if (found.length !== new Set(input.watchedSloIds).size) {
      throw new GameDayRefusal("A watched SLO was not found", 404);
    }
  }
  return resolved;
}

function plannedColumns(input: GameDayInput) {
  return {
    name: stripControlCharacters(input.name),
    description: input.description === null ? null : stripControlCharacters(input.description),
    serviceId: input.serviceId,
    startsAt: new Date(input.startsAt),
    durationMinutes: input.durationMinutes,
    recoveryTimeoutMinutes: input.recoveryTimeoutMinutes,
    freezeDuringRun: input.freezeDuringRun,
    watchedProbeIds: [...new Set(input.watchedProbeIds)],
    watchedSloIds: [...new Set(input.watchedSloIds)],
  };
}

function targetRows(organizationId: string, gameDayId: string, targets: ResolvedTarget[]) {
  return targets.map((t, position) => ({
    id: randomUUID(),
    gameDayId,
    organizationId,
    position,
    ...t,
  }));
}

export async function createGameDay(
  organizationId: string,
  input: GameDayInput,
  userId: string | null,
): Promise<GameDay> {
  const targets = await resolveGameDayInput(organizationId, input);
  const id = randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(gameDays).values({
      id,
      organizationId,
      ...plannedColumns(input),
      status: "planned",
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(gameDayTargets).values(targetRows(organizationId, id, targets));
  });
  const row = await getGameDayRow(organizationId, id);
  if (!row) throw new GameDayRefusal("Game day not found", 404);
  return wireOne(row);
}

export async function updateGameDay(
  organizationId: string,
  id: string,
  input: GameDayInput,
): Promise<GameDay> {
  const existing = await getGameDayRow(organizationId, id);
  if (!existing) throw new GameDayRefusal("Game day not found", 404);
  if (existing.status !== "planned") {
    throw new GameDayRefusal("Only a planned game day can be edited; disarm it first", 409);
  }
  const targets = await resolveGameDayInput(organizationId, input);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(gameDays)
      .set({ ...plannedColumns(input), updatedAt: new Date() })
      .where(and(eq(gameDays.id, id), eq(gameDays.status, "planned")))
      .returning({ id: gameDays.id });
    if (updated.length === 0) {
      throw new GameDayRefusal("The game day was armed while you were editing it", 409);
    }
    await tx.delete(gameDayTargets).where(eq(gameDayTargets.gameDayId, id));
    await tx.insert(gameDayTargets).values(targetRows(organizationId, id, targets));
  });
  return wireOne((await getGameDayRow(organizationId, id))!);
}

export async function deleteGameDay(organizationId: string, id: string): Promise<GameDayRow> {
  const deleted = await db
    .delete(gameDays)
    .where(
      and(
        eq(gameDays.id, id),
        eq(gameDays.organizationId, organizationId),
        inArray(gameDays.status, [...DELETABLE]),
      ),
    )
    .returning();
  if (deleted[0]) return deleted[0];
  if (await getGameDayRow(organizationId, id)) {
    throw new GameDayRefusal(
      "A game day that is armed or may have a failure in effect cannot be deleted; abort it first",
      409,
    );
  }
  throw new GameDayRefusal("Game day not found", 404);
}

/**
 * Apply a conditional transition and return the result, or explain why it
 * matched nothing.
 */
async function transition(
  organizationId: string,
  id: string,
  from: readonly GameDayStatus[],
  set: PgUpdateSetSource<typeof gameDays>,
  refusal: string,
): Promise<GameDay> {
  const [row] = await db
    .update(gameDays)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(gameDays.id, id),
        eq(gameDays.organizationId, organizationId),
        inArray(gameDays.status, [...from]),
      ),
    )
    .returning();
  if (row) return wireOne(row);
  if (await getGameDayRow(organizationId, id)) throw new GameDayRefusal(refusal, 409);
  throw new GameDayRefusal("Game day not found", 404);
}

/** The confirmation. Only a person reaches this (the route refuses keys and agents). */
export async function armGameDay(
  organizationId: string,
  id: string,
  userId: string,
  confirmName: string,
): Promise<GameDay> {
  const row = await getGameDayRow(organizationId, id);
  if (!row) throw new GameDayRefusal("Game day not found", 404);
  if (confirmName.trim() !== row.name) {
    throw new GameDayRefusal("Type the game day's name exactly to arm it");
  }
  const now = new Date();
  return transition(
    organizationId,
    id,
    ["planned"],
    {
      status: "armed",
      armedAt: now,
      armedByUserId: userId,
      endReason: null,
      lastError: null,
      // Due at the start, or straight away when that has passed.
      nextCheckAt: row.startsAt > now ? row.startsAt : now,
    },
    "Only a planned game day can be armed",
  );
}

export async function disarmGameDay(organizationId: string, id: string): Promise<GameDay> {
  return transition(
    organizationId,
    id,
    ["armed"],
    { status: "planned", armedAt: null, armedByUserId: null, nextCheckAt: null },
    "Only an armed game day that has not started can be disarmed",
  );
}

/**
 * End a game day now ("ended") or abort it ("aborted"). An armed one that has
 * not started is cancelled outright; a live one is marked for the pass, which
 * runs the undo on its next turn (seconds: it has a loop of its own).
 */
export async function requestGameDayEnd(
  organizationId: string,
  id: string,
  userId: string | null,
  reason: "ended" | "aborted",
): Promise<GameDay> {
  const row = await getGameDayRow(organizationId, id);
  if (!row) throw new GameDayRefusal("Game day not found", 404);
  const now = new Date();
  if (row.status === "armed") {
    if (reason !== "aborted") {
      throw new GameDayRefusal("It has not started yet; disarm or abort it instead", 409);
    }
    return transition(
      organizationId,
      id,
      ["armed"],
      {
        status: "cancelled",
        endReason: "aborted",
        endRequestedAt: now,
        endedByUserId: userId,
        completedAt: now,
        nextCheckAt: null,
      },
      "The game day started while you were aborting it; abort it again",
    );
  }
  if (row.status === "undo_failed" && reason === "aborted") {
    return retryGameDayUndo(organizationId, id);
  }
  return transition(
    organizationId,
    id,
    ["injecting", "running", "reverting"],
    {
      endRequestedAt: sql`coalesce(${gameDays.endRequestedAt}, now())`,
      endReason: sql`coalesce(${gameDays.endReason}, ${reason})`,
      endedByUserId: sql`coalesce(${gameDays.endedByUserId}, ${userId})`,
      nextCheckAt: now,
    },
    "The failure is no longer in effect",
  );
}

/** Put an `undo_failed` game day back to undoing, attempts reset. */
export async function retryGameDayUndo(organizationId: string, id: string): Promise<GameDay> {
  const result = await transition(
    organizationId,
    id,
    ["undo_failed"],
    { status: "reverting", lastError: null, nextCheckAt: new Date() },
    "Only a game day whose undo failed can be retried",
  );
  await db
    .update(gameDayTargets)
    .set({ state: "injected", attempts: 0, updatedAt: new Date() })
    .where(and(eq(gameDayTargets.gameDayId, id), eq(gameDayTargets.state, "undo_failed")));
  return result;
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/**
 * What the editor can offer: resources whose type supports a failure action
 * (with the actions), services with their members, probes and SLOs. Reads the
 * plugin registry's declarations only, so it runs anywhere.
 */
export async function listGameDayCandidates(organizationId: string): Promise<GameDayCandidates> {
  const plugins = await loadPlugins();
  const actionsByType = new Map<string, ReturnType<typeof failureActionsForType>>();
  for (const { plugin } of plugins) {
    for (const type of plugin.resourceTypes) {
      const actions = failureActionsForType(type);
      if (actions.length) actionsByType.set(`${plugin.manifest.id}/${type.id}`, actions);
    }
  }
  const typeIds = [...new Set([...actionsByType.keys()].map((k) => k.split("/")[1]!))];

  const [resourceRows, probeRows, sloRows, serviceRecords] = await Promise.all([
    typeIds.length
      ? db
          .select({
            id: resources.id,
            accountId: resources.accountId,
            pluginId: resources.pluginId,
            resourceTypeId: resources.resourceTypeId,
            displayName: resources.displayName,
          })
          .from(resources)
          .where(
            and(
              eq(resources.organizationId, organizationId),
              inArray(resources.resourceTypeId, typeIds),
              isNull(resources.deletedAt),
            ),
          )
          .orderBy(asc(resources.displayName))
          .limit(2000)
      : [],
    db
      .select({ id: syntheticProbes.id, name: syntheticProbes.name, status: syntheticProbes.status })
      .from(syntheticProbes)
      .where(eq(syntheticProbes.organizationId, organizationId))
      .orderBy(asc(syntheticProbes.name)),
    db
      .select({ id: slos.id, name: slos.name })
      .from(slos)
      .where(eq(slos.organizationId, organizationId))
      .orderBy(asc(slos.name)),
    listServiceRecords(organizationId),
  ]);

  const members = await resolveServiceMembers(organizationId, serviceRecords).catch(
    () => new Map<string, { members: { resourceId: string }[] }>(),
  );

  return {
    resources: resourceRows.flatMap((r) => {
      const actions = actionsByType.get(`${r.pluginId}/${r.resourceTypeId}`);
      if (!actions) return [];
      return [
        {
          resourceId: r.id,
          accountId: r.accountId,
          pluginId: r.pluginId,
          resourceTypeId: r.resourceTypeId,
          displayName: r.displayName,
          actions: actions.map((a) => ({
            actionId: a.id,
            label: a.label,
            undoLabel: a.undoLabel,
            description: a.description ?? null,
          })),
        },
      ];
    }),
    services: serviceRecords.map((s) => ({
      id: s.id,
      name: s.name,
      resourceIds: (members.get(s.id)?.members ?? []).map((m) => m.resourceId),
    })),
    probes: probeRows,
    slos: sloRows,
  };
}
