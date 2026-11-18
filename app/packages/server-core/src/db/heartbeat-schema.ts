/**
 * Heartbeat monitors: a scheduled job pings a secret URL each time it runs,
 * and the poller marks a heartbeat down when the ping is later than its
 * schedule plus a grace period.
 *
 * `deadlineAt` is the whole schedule, precomputed: the ping handler writes
 * it on every success (the next expected ping plus grace, from the shared
 * schedule arithmetic in client-core), so the poller's pass is one indexed
 * range scan for `deadline_at <= now()` and needs no cron arithmetic of its
 * own. Null while the heartbeat is new (no ping yet: a heartbeat never alerts
 * before its job has reported once), paused, or already down.
 *
 * `pingToken` is the only credential the public ping URL carries, so it is
 * random, globally unique and indexed; it never appears in logs or audit
 * metadata. Rotating it is how a leaked URL is revoked.
 *
 * `pingWindowStart`/`pingWindowCount` are the ping rate limit, kept on the row
 * so it holds across every isolate and replica (an in-memory counter on the
 * edge is per isolate).
 *
 * The linked resource columns are **not** foreign keys, the
 * `synthetic_probes.resource_id` stance: resource rows churn with sync, and a
 * heartbeat must keep watching a job whose resource row disappeared upstream.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  HeartbeatDownReason,
  HeartbeatPingKind,
  HeartbeatScheduleKind,
  HeartbeatStatus,
} from "@infrawrench/client-core";
import { accounts, organizations, users } from "./core-schema.js";

export const heartbeats = pgTable(
  "heartbeats",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scheduleKind: text("schedule_kind").$type<HeartbeatScheduleKind>().notNull(),
    /** Five-field cron, read in `timezone`; set when `scheduleKind` is "cron". */
    cronExpression: text("cron_expression"),
    timezone: text("timezone").notNull().default("UTC"),
    /** Set when `scheduleKind` is "interval". */
    intervalMinutes: integer("interval_minutes"),
    graceMinutes: integer("grace_minutes").notNull().default(10),
    enabled: boolean("enabled").notNull().default(true),
    pingToken: text("ping_token").notNull(),
    status: text("status").$type<HeartbeatStatus>().notNull().default("new"),
    downReason: text("down_reason").$type<HeartbeatDownReason>(),
    lastPingAt: timestamp("last_ping_at"),
    lastStartAt: timestamp("last_start_at"),
    lastFailAt: timestamp("last_fail_at"),
    lastDurationMs: integer("last_duration_ms"),
    /** When the next ping is due (without grace). */
    nextExpectedAt: timestamp("next_expected_at"),
    /** Past this the heartbeat goes down. Null while new, paused or down. */
    deadlineAt: timestamp("deadline_at"),
    lastStateChangeAt: timestamp("last_state_change_at"),
    pingWindowStart: timestamp("ping_window_start"),
    pingWindowCount: integer("ping_window_count").notNull().default(0),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** Not a FK: see above. */
    resourceId: text("resource_id"),
    pluginId: text("plugin_id"),
    resourceTypeId: text("resource_type_id"),
    /** The resource field the schedule was read from. */
    fieldKey: text("field_key"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("heartbeats_org_idx").on(t.organizationId),
    tokenUnique: uniqueIndex("heartbeats_ping_token_unique").on(t.pingToken),
    deadlineIdx: index("heartbeats_deadline_idx").on(t.deadlineAt),
    resourceIdx: index("heartbeats_resource_idx").on(t.organizationId, t.resourceId),
    graceRange: check(
      "heartbeats_grace_range",
      sql`${t.graceMinutes} >= 1 AND ${t.graceMinutes} <= 10080`,
    ),
    scheduleShape: check(
      "heartbeats_schedule_shape",
      sql`(${t.scheduleKind} = 'cron' AND ${t.cronExpression} IS NOT NULL) OR (${t.scheduleKind} = 'interval' AND ${t.intervalMinutes} >= 1)`,
    ),
  }),
);

/**
 * Recorded pings, newest read first. Pruned by the poller after
 * `HEARTBEAT_LIMITS.pingRetentionDays`, and capped per heartbeat by the ping
 * rate limit on the parent row.
 */
export const heartbeatPings = pgTable(
  "heartbeat_pings",
  {
    id: text("id").primaryKey(),
    heartbeatId: text("heartbeat_id")
      .notNull()
      .references(() => heartbeats.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<HeartbeatPingKind>().notNull(),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    /** For a success or fail that closed a run opened by a start ping. */
    durationMs: integer("duration_ms"),
    method: text("method").notNull(),
    userAgent: text("user_agent"),
    /** The start of the request body, when the job sent one. */
    body: text("body"),
  },
  (t) => ({
    heartbeatIdx: index("heartbeat_pings_heartbeat_idx").on(t.heartbeatId, t.receivedAt),
    receivedIdx: index("heartbeat_pings_received_idx").on(t.receivedAt),
  }),
);
