/**
 * Heartbeat rows: CRUD, the ping token, and the wire shape, shared by the web
 * API, the public ping route and the poller pass.
 *
 * Limits and schedule validation come from `@infrawrench/client-core`
 * (`HEARTBEAT_LIMITS`, `validateHeartbeatSchedule`), the values the editor
 * UIs check with: the server and the form can't disagree about what a valid
 * schedule is (the `probes/store.ts` stance).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  HEARTBEAT_DEFAULTS,
  HEARTBEAT_LIMITS,
  clampHeartbeatNumber,
  heartbeatDeadline,
  heartbeatNextExpected,
  validateHeartbeatSchedule,
  type Heartbeat,
  type HeartbeatPing,
  type HeartbeatSchedule,
  type HeartbeatScheduleKind,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { heartbeatPings, heartbeats, resources } from "../db/schema";
import { appPath } from "../app-url";

export type HeartbeatRecord = typeof heartbeats.$inferSelect;

export interface HeartbeatCreateInput {
  name: string;
  scheduleKind: HeartbeatScheduleKind;
  cronExpression?: string | undefined;
  timezone?: string | undefined;
  intervalMinutes?: number | undefined;
  graceMinutes?: number | undefined;
  enabled?: boolean | undefined;
  resourceId?: string | undefined;
  fieldKey?: string | undefined;
}

export interface HeartbeatUpdateInput {
  name?: string | undefined;
  scheduleKind?: HeartbeatScheduleKind | undefined;
  cronExpression?: string | undefined;
  timezone?: string | undefined;
  intervalMinutes?: number | undefined;
  graceMinutes?: number | undefined;
  enabled?: boolean | undefined;
}

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class HeartbeatInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "HeartbeatInputError";
  }
}

// Unambiguous lowercase letters and digits: the status-page slug alphabet. 32
// characters of 31 symbols is ~158 bits. The token is the ping URL's only
// credential, so it comes from `randomBytes`, rejection-sampled so the modulo
// does not bias it.
const TOKEN_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const TOKEN_LENGTH = 32;

export function generatePingToken(): string {
  const limit = 256 - (256 % TOKEN_ALPHABET.length);
  let out = "";
  while (out.length < TOKEN_LENGTH) {
    for (const byte of randomBytes(TOKEN_LENGTH)) {
      if (byte >= limit) continue;
      out += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
      if (out.length === TOKEN_LENGTH) break;
    }
  }
  return out;
}

/** Whether a path segment could be a ping token at all: a cheap refusal before any query. */
export function isPingTokenShape(token: string): boolean {
  return token.length === TOKEN_LENGTH && /^[a-z0-9]+$/.test(token);
}

/** The path a job pings, without the server's origin. */
export function pingPath(token: string): string {
  return `/api/ping/${token}`;
}

/** The schedule a row describes. */
export function scheduleOf(row: HeartbeatRecord): HeartbeatSchedule {
  return row.scheduleKind === "cron"
    ? { kind: "cron", cronExpression: row.cronExpression ?? "", timezone: row.timezone }
    : {
        kind: "interval",
        intervalMinutes: row.intervalMinutes ?? HEARTBEAT_DEFAULTS.intervalMinutes,
      };
}

/** Row to wire shape. */
export function toWireHeartbeat(row: HeartbeatRecord): Heartbeat {
  const path = pingPath(row.pingToken);
  return {
    id: row.id,
    name: row.name,
    scheduleKind: row.scheduleKind,
    cronExpression: row.scheduleKind === "cron" ? row.cronExpression : null,
    timezone: row.timezone,
    intervalMinutes: row.scheduleKind === "interval" ? row.intervalMinutes : null,
    graceMinutes: row.graceMinutes,
    enabled: row.enabled,
    status: row.status,
    downReason: row.status === "down" ? row.downReason : null,
    pingUrl: appPath(path) ?? path,
    lastPingAt: row.lastPingAt?.toISOString() ?? null,
    lastStartAt: row.lastStartAt?.toISOString() ?? null,
    lastFailAt: row.lastFailAt?.toISOString() ?? null,
    lastDurationMs: row.lastDurationMs,
    nextExpectedAt: row.nextExpectedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    lastStateChangeAt: row.lastStateChangeAt?.toISOString() ?? null,
    accountId: row.accountId,
    resourceId: row.resourceId,
    pluginId: row.pluginId,
    resourceTypeId: row.resourceTypeId,
    fieldKey: row.fieldKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toWirePing(row: typeof heartbeatPings.$inferSelect): HeartbeatPing {
  return {
    id: row.id,
    kind: row.kind,
    receivedAt: row.receivedAt.toISOString(),
    durationMs: row.durationMs,
    method: row.method,
    userAgent: row.userAgent,
    body: row.body,
  };
}

function clampGrace(raw: unknown): number {
  return clampHeartbeatNumber(
    raw,
    HEARTBEAT_DEFAULTS.graceMinutes,
    HEARTBEAT_LIMITS.minGraceMinutes,
    HEARTBEAT_LIMITS.maxGraceMinutes,
  );
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new HeartbeatInputError("A name is required");
  if (name.length > HEARTBEAT_LIMITS.maxNameLength) {
    throw new HeartbeatInputError(
      `Names are limited to ${HEARTBEAT_LIMITS.maxNameLength} characters`,
    );
  }
  return name;
}

/**
 * Resolve the schedule columns from a create or a patch layered over the
 * existing row, validated. A schedule switched to cron needs an expression; an
 * interval is clamped into range rather than refused, like a probe's interval.
 */
function resolveSchedule(
  input: HeartbeatUpdateInput,
  existing: HeartbeatRecord | null,
): Pick<HeartbeatRecord, "scheduleKind" | "cronExpression" | "timezone" | "intervalMinutes"> {
  const kind = input.scheduleKind ?? existing?.scheduleKind ?? HEARTBEAT_DEFAULTS.scheduleKind;
  if (kind !== "cron" && kind !== "interval") {
    throw new HeartbeatInputError('scheduleKind must be "cron" or "interval"');
  }
  if (kind === "interval") {
    const intervalMinutes = clampHeartbeatNumber(
      input.intervalMinutes ?? existing?.intervalMinutes,
      HEARTBEAT_DEFAULTS.intervalMinutes,
      HEARTBEAT_LIMITS.minIntervalMinutes,
      HEARTBEAT_LIMITS.maxIntervalMinutes,
    );
    return {
      scheduleKind: "interval",
      cronExpression: null,
      timezone: existing?.timezone ?? HEARTBEAT_DEFAULTS.timezone,
      intervalMinutes,
    };
  }
  const cronExpression = (input.cronExpression ?? existing?.cronExpression ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const timezone = (input.timezone ?? existing?.timezone ?? HEARTBEAT_DEFAULTS.timezone).trim();
  const problem = validateHeartbeatSchedule({ kind: "cron", cronExpression, timezone });
  if (problem !== null) throw new HeartbeatInputError(problem);
  return { scheduleKind: "cron", cronExpression, timezone, intervalMinutes: null };
}

export async function listHeartbeatRecords(organizationId: string): Promise<HeartbeatRecord[]> {
  return db
    .select()
    .from(heartbeats)
    .where(eq(heartbeats.organizationId, organizationId))
    .orderBy(heartbeats.createdAt);
}

export async function getHeartbeatRecord(
  organizationId: string,
  heartbeatId: string,
): Promise<HeartbeatRecord | null> {
  const rows = await db
    .select()
    .from(heartbeats)
    .where(and(eq(heartbeats.organizationId, organizationId), eq(heartbeats.id, heartbeatId)))
    .limit(1);
  return rows[0] ?? null;
}

async function requireHeartbeat(organizationId: string, heartbeatId: string) {
  const row = await getHeartbeatRecord(organizationId, heartbeatId);
  if (!row) throw new HeartbeatInputError("Heartbeat not found", 404);
  return row;
}

/**
 * Create a heartbeat. It starts `new`, with no deadline: it never alerts
 * before its job has pinged once, because it is usually created before the
 * ping is added to the job. A linked resource, when given, must exist in this
 * org (the link is advisory afterwards, but must start out true).
 */
export async function createHeartbeatRecord(
  organizationId: string,
  input: HeartbeatCreateInput,
  createdByUserId?: string,
): Promise<HeartbeatRecord> {
  const name = cleanName(input.name ?? "");
  const schedule = resolveSchedule(input, null);

  let link: Pick<HeartbeatRecord, "accountId" | "resourceId" | "pluginId" | "resourceTypeId"> = {
    accountId: null,
    resourceId: null,
    pluginId: null,
    resourceTypeId: null,
  };
  if (input.resourceId) {
    const [resource] = await db
      .select({
        id: resources.id,
        accountId: resources.accountId,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), eq(resources.id, input.resourceId)))
      .limit(1);
    if (!resource) {
      throw new HeartbeatInputError("Linked resource not found in this organization", 404);
    }
    link = {
      accountId: resource.accountId,
      resourceId: resource.id,
      pluginId: resource.pluginId,
      resourceTypeId: resource.resourceTypeId,
    };
  }

  const now = new Date();
  const row: typeof heartbeats.$inferInsert = {
    id: randomUUID(),
    organizationId,
    name,
    ...schedule,
    graceMinutes: clampGrace(input.graceMinutes),
    enabled: input.enabled ?? true,
    pingToken: generatePingToken(),
    status: "new",
    ...link,
    fieldKey: input.resourceId ? input.fieldKey?.trim() || null : null,
    createdByUserId: createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  // The per-org cap and the insert run under an org-scoped advisory lock so
  // two concurrent creates can't both pass the count (the probes stance).
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`heartbeats:${organizationId}`}))`,
    );
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(heartbeats)
      .where(eq(heartbeats.organizationId, organizationId));
    if ((count?.n ?? 0) >= HEARTBEAT_LIMITS.maxPerOrg) {
      throw new HeartbeatInputError(
        `Organizations are limited to ${HEARTBEAT_LIMITS.maxPerOrg} heartbeats`,
      );
    }
    await tx.insert(heartbeats).values(row);
  });
  return (await getHeartbeatRecord(organizationId, row.id))!;
}

/**
 * Update settings and/or the pause toggle.
 *
 * - A schedule or grace change recomputes the deadline from the last ping, so
 *   the new expectation applies to the run already due.
 * - Pausing clears the deadline. Resuming returns the heartbeat to `new`: it
 *   waits for the next ping rather than alerting on a gap it was told to ignore.
 */
export async function updateHeartbeatRecord(
  organizationId: string,
  heartbeatId: string,
  patch: HeartbeatUpdateInput,
): Promise<HeartbeatRecord> {
  const existing = await requireHeartbeat(organizationId, heartbeatId);
  const now = new Date();
  const set: Partial<typeof heartbeats.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = cleanName(patch.name);

  const scheduleTouched =
    patch.scheduleKind !== undefined ||
    patch.cronExpression !== undefined ||
    patch.timezone !== undefined ||
    patch.intervalMinutes !== undefined;
  if (scheduleTouched) Object.assign(set, resolveSchedule(patch, existing));
  if (patch.graceMinutes !== undefined) set.graceMinutes = clampGrace(patch.graceMinutes);

  const enabled = patch.enabled ?? existing.enabled;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;

  if (!enabled) {
    set.nextExpectedAt = null;
    set.deadlineAt = null;
  } else if (patch.enabled === true && !existing.enabled) {
    set.status = "new";
    set.downReason = null;
    set.nextExpectedAt = null;
    set.deadlineAt = null;
    set.lastStateChangeAt = now;
  } else if (
    (scheduleTouched || patch.graceMinutes !== undefined) &&
    existing.status === "up" &&
    existing.lastPingAt
  ) {
    const merged = { ...existing, ...set } as HeartbeatRecord;
    const schedule = scheduleOf(merged);
    set.nextExpectedAt = heartbeatNextExpected(schedule, existing.lastPingAt);
    set.deadlineAt = heartbeatDeadline(schedule, merged.graceMinutes, existing.lastPingAt);
  }

  await db
    .update(heartbeats)
    .set(set)
    .where(and(eq(heartbeats.organizationId, organizationId), eq(heartbeats.id, heartbeatId)));
  return (await getHeartbeatRecord(organizationId, heartbeatId))!;
}

/** Replace the ping token: the old URL stops working at once. */
export async function rotateHeartbeatToken(
  organizationId: string,
  heartbeatId: string,
): Promise<HeartbeatRecord> {
  await requireHeartbeat(organizationId, heartbeatId);
  await db
    .update(heartbeats)
    .set({ pingToken: generatePingToken(), updatedAt: new Date() })
    .where(and(eq(heartbeats.organizationId, organizationId), eq(heartbeats.id, heartbeatId)));
  return (await getHeartbeatRecord(organizationId, heartbeatId))!;
}

export async function deleteHeartbeatRecord(
  organizationId: string,
  heartbeatId: string,
): Promise<HeartbeatRecord> {
  const existing = await requireHeartbeat(organizationId, heartbeatId);
  await db
    .delete(heartbeats)
    .where(and(eq(heartbeats.organizationId, organizationId), eq(heartbeats.id, heartbeatId)));
  return existing;
}

/** One heartbeat's most recent pings, newest first. */
export async function listHeartbeatPings(
  organizationId: string,
  heartbeatId: string,
  limit: number,
): Promise<HeartbeatPing[]> {
  await requireHeartbeat(organizationId, heartbeatId);
  const rows = await db
    .select()
    .from(heartbeatPings)
    .where(
      and(
        eq(heartbeatPings.organizationId, organizationId),
        eq(heartbeatPings.heartbeatId, heartbeatId),
      ),
    )
    .orderBy(desc(heartbeatPings.receivedAt))
    .limit(limit);
  return rows.map(toWirePing);
}
