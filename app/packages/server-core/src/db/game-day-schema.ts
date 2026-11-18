/**
 * Game days: a planned, controlled failure injected into production, and the
 * record of how fast the organization noticed and recovered.
 *
 * Three tables:
 *
 * - `game_days`: the plan, the state machine and the detection timestamps.
 *   `next_check_at` is when the poller pass should look next and
 *   `claimed_until` its lease, so a game day is worked by one replica at a
 *   time and resumed by whichever replica comes next after a restart.
 * - `game_day_targets`: one row per resource, with the undo state the plugin
 *   returned **before** the inject. Writing it first is what lets an undo run
 *   after a process died between the provider call and the next write.
 * - `game_day_alerts`: every alert the routing rules handled while a game day
 *   ran, written by `routeAlert` itself. The alert feeds have no common
 *   record of "what was sent", and the report's page and acknowledgement
 *   times are read from these rows.
 *
 * `service_id`, the probe and SLO ids and `resource_id` are not foreign keys
 * (the SLO stance): deleting a service or a probe must not delete the record
 * of a game day run against it.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import { pgTable, text, boolean, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import type { FailureUndoState } from "@infrawrench/plugin-base";
import type {
  GameDayEndReason,
  GameDaySignals,
  GameDayStatus,
  GameDayTargetState,
} from "@infrawrench/client-core";

import { organizations, users } from "./core-schema.js";

export const gameDays = pgTable(
  "game_days",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** The service exercised. Not a FK, see above. */
    serviceId: text("service_id"),
    status: text("status").$type<GameDayStatus>().notNull().default("planned"),
    endReason: text("end_reason").$type<GameDayEndReason>(),
    startsAt: timestamp("starts_at").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    recoveryTimeoutMinutes: integer("recovery_timeout_minutes").notNull().default(30),
    freezeDuringRun: boolean("freeze_during_run").notNull().default(false),
    /** The change freeze this game day opened; plain text, the incident-artefact stance. */
    freezeId: text("freeze_id"),
    watchedProbeIds: jsonb("watched_probe_ids").$type<string[]>().notNull().default([]),
    watchedSloIds: jsonb("watched_slo_ids").$type<string[]>().notNull().default([]),
    /**
     * Resources an alert may be about for it to count: the targets plus the
     * service's members, captured at the inject so a later membership edit
     * cannot change what the report counted.
     */
    relatedResourceIds: jsonb("related_resource_ids").$type<string[]>().notNull().default([]),

    armedAt: timestamp("armed_at"),
    armedByUserId: text("armed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    injectedAt: timestamp("injected_at"),
    endsAt: timestamp("ends_at"),
    endRequestedAt: timestamp("end_requested_at"),
    endedByUserId: text("ended_by_user_id").references(() => users.id, { onDelete: "set null" }),
    undoneAt: timestamp("undone_at"),
    recoveredAt: timestamp("recovered_at"),
    completedAt: timestamp("completed_at"),
    lastError: text("last_error"),
    /** First instant each detector fired; only ever moved earlier (`mergeGameDaySignals`). */
    signals: jsonb("signals").$type<Partial<GameDaySignals>>().notNull().default({}),

    /** When the pass should next look. Null while there is nothing for it to do. */
    nextCheckAt: timestamp("next_check_at"),
    /**
     * The claim lease, separate from the due time so "end now" can make a game
     * day due straight away without handing it to a second replica while the
     * first is still mid-inject: the claim needs both due and unclaimed.
     */
    claimedUntil: timestamp("claimed_until"),

    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("game_days_org_idx").on(t.organizationId, t.startsAt),
    dueIdx: index("game_days_due_idx").on(t.nextCheckAt),
    orgStatusIdx: index("game_days_org_status_idx").on(t.organizationId, t.status),
  }),
);

export const gameDayTargets = pgTable(
  "game_day_targets",
  {
    id: text("id").primaryKey(),
    gameDayId: text("game_day_id")
      .notNull()
      .references(() => gameDays.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    /** `resources.id`. Not a FK, see above. */
    resourceId: text("resource_id").notNull(),
    accountId: text("account_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    displayName: text("display_name").notNull(),
    actionId: text("action_id").notNull(),
    actionLabel: text("action_label").notNull(),
    undoLabel: text("undo_label").notNull(),
    state: text("state").$type<GameDayTargetState>().notNull().default("pending"),
    /** What `prepareFailure` returned, stored before the inject. */
    undoState: jsonb("undo_state").$type<FailureUndoState>(),
    stateBefore: text("state_before"),
    injectedAt: timestamp("injected_at"),
    revertedAt: timestamp("reverted_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    gameDayIdx: index("game_day_targets_game_day_idx").on(t.gameDayId, t.position),
  }),
);

export const gameDayAlerts = pgTable(
  "game_day_alerts",
  {
    id: text("id").primaryKey(),
    gameDayId: text("game_day_id")
      .notNull()
      .references(() => gameDays.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    at: timestamp("at").notNull().defaultNow(),
    trigger: text("trigger").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    related: boolean("related").notNull(),
    paged: boolean("paged").notNull(),
    unrouted: boolean("unrouted").notNull(),
    /** `alert_deliveries` rows the alert armed, where its acknowledgement will land. */
    deliveryIds: jsonb("delivery_ids").$type<string[]>().notNull().default([]),
  },
  (t) => ({
    gameDayIdx: index("game_day_alerts_game_day_idx").on(t.gameDayId, t.at),
  }),
);
