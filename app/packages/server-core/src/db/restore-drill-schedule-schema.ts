/**
 * Automatic restore drills: a schedule per resource, and one row per run.
 *
 * A run is a small state machine the poller pass advances a step at a time
 * (`starting` → `restoring` → `cleaning` → `done`), because a provider copy can
 * take many minutes to come up and no pass may hold a request open that long.
 * The run row is also the only place the copy's handle lives, which is why it
 * is kept after the run ends: a copy whose delete keeps failing must stay
 * findable until it is gone.
 *
 * The outcome itself is written to `restore_drills`, the same log manual drills
 * use, so the standing, compliance evidence and the digest read one source.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { accounts, organizations, users } from "./core-schema.js";

export const restoreDrillSchedules = pgTable(
  "restore_drill_schedules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Cascades: a schedule runs with one account's credentials and cannot outlive them. */
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Infrawrench resource id. No FK, as with `restore_drills`: rows are re-created by sync. */
    resourceId: text("resource_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    intervalDays: integer("interval_days").notNull(),
    /** "latest-backup" | "point-in-time" */
    restorePoint: text("restore_point").$type<"latest-backup" | "point-in-time">().notNull(),
    pointInTimeHoursAgo: integer("point_in_time_hours_ago"),
    verifySql: text("verify_sql"),
    verifyMode: text("verify_mode").$type<"scalar" | "rowCount">().notNull().default("rowCount"),
    verifyOperator: text("verify_operator")
      .$type<"gt" | "gte" | "lt" | "lte" | "eq" | "neq">()
      .notNull()
      .default("gt"),
    verifyThreshold: doublePrecision("verify_threshold").notNull().default(0),
    timeLimitMinutes: integer("time_limit_minutes").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** When the next run is due; pushed forward by the claim, before the run starts. */
    nextRunAt: timestamp("next_run_at").notNull().defaultNow(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("restore_drill_schedules_org_idx").on(t.organizationId),
    dueIdx: index("restore_drill_schedules_due_idx").on(t.enabled, t.nextRunAt),
  }),
);

export const restoreDrillRuns = pgTable(
  "restore_drill_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Set null on delete: a run whose copy still exists must outlive its schedule. */
    scheduleId: text("schedule_id").references(() => restoreDrillSchedules.id, {
      onDelete: "set null",
    }),
    /** No FK: the run (and the copy it may still hold) must outlive a disconnected account. */
    accountId: text("account_id").notNull(),
    resourceId: text("resource_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    /** "schedule" | "manual" */
    trigger: text("trigger").$type<"schedule" | "manual">().notNull(),
    /** "starting" | "restoring" | "cleaning" | "done" */
    state: text("state").$type<"starting" | "restoring" | "cleaning" | "done">().notNull(),
    /** "verified" | "restored-unverified" | "failed", once decided. */
    outcome: text("outcome").$type<"verified" | "restored-unverified" | "failed">(),
    /** The schedule's settings as they were when the run started. */
    restorePoint: text("restore_point").$type<"latest-backup" | "point-in-time">().notNull(),
    pointInTimeAt: timestamp("point_in_time_at"),
    verifySql: text("verify_sql"),
    verifyMode: text("verify_mode").$type<"scalar" | "rowCount">().notNull(),
    verifyOperator: text("verify_operator")
      .$type<"gt" | "gte" | "lt" | "lte" | "eq" | "neq">()
      .notNull(),
    verifyThreshold: doublePrecision("verify_threshold").notNull(),
    copyName: text("copy_name").notNull(),
    /** The plugin's opaque handle to the copy. Null until the provider accepted the request. */
    copyRef: text("copy_ref"),
    restoredFrom: text("restored_from"),
    restorePointAt: timestamp("restore_point_at"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    deadlineAt: timestamp("deadline_at").notNull(),
    readyAt: timestamp("ready_at"),
    finishedAt: timestamp("finished_at"),
    restoreSeconds: integer("restore_seconds"),
    verifyValue: doublePrecision("verify_value"),
    detail: text("detail"),
    /** "none" | "pending" | "failed" | "done" */
    cleanupState: text("cleanup_state")
      .$type<"none" | "pending" | "failed" | "done">()
      .notNull()
      .default("none"),
    cleanupError: text("cleanup_error"),
    cleanupAttempts: integer("cleanup_attempts").notNull().default(0),
    /** Whether the loud "a copy could not be deleted" alert has gone out for this run. */
    cleanupAlerted: boolean("cleanup_alerted").notNull().default(false),
    restoreDrillId: text("restore_drill_id"),
    /** When the pass should look at this run again. */
    nextStepAt: timestamp("next_step_at").notNull().defaultNow(),
    /** Claim lease: a replica holding the run until this time owns it. */
    leaseUntil: timestamp("lease_until"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    orgScheduleIdx: index("restore_drill_runs_org_schedule_idx").on(
      t.organizationId,
      t.scheduleId,
      t.startedAt,
    ),
    activeIdx: index("restore_drill_runs_active_idx").on(t.state, t.cleanupState, t.nextStepAt),
  }),
);
