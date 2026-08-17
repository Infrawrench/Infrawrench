/**
 * On-call rotations: the schedule, its participants, and the covers.
 *
 * Participants are a **table**, not a jsonb array on the schedule, and the
 * reason is deletion. A rotation naming somebody who left the organization
 * pages nobody, silently, on their week — the worst failure this feature has —
 * and only a foreign key with `ON DELETE CASCADE` makes their removal from the
 * org remove them from the rotation. A jsonb list would have to be swept by
 * something that remembers to look.
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
} from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * One rotation.
 *
 * `startDate` is a `YYYY-MM-DD` **text** column rather than a date or a
 * timestamp, because it is a calendar date in `timezone` and nothing else:
 * storing it as an instant would make it a different date for readers in
 * another zone, and every boundary in the rotation is derived from it.
 */
export const onCallSchedules = pgTable(
  "on_call_schedules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** IANA zone the handover time is expressed in. */
    timezone: text("timezone").notNull(),
    /** Days per shift. 7 is the common case. */
    rotationDays: integer("rotation_days").notNull().default(7),
    /** Wall-clock "HH:MM" in `timezone` at which the shift changes hands. */
    handoffTime: text("handoff_time").notNull().default("09:00"),
    /** `YYYY-MM-DD` in `timezone`; the anchor every boundary derives from. */
    startDate: text("start_date").notNull(),
    /**
     * Off resolves to nobody. A destination pointing at a disabled schedule
     * contributes nobody and the rule's other destinations still deliver — an
     * alert lost to a misconfigured schedule is the worst outcome here.
     */
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("on_call_schedules_org_idx").on(t.organizationId),
    orgNameUnique: uniqueIndex("on_call_schedules_org_name_unique").on(t.organizationId, t.name),
  }),
);

/**
 * One person's place in one rotation.
 *
 * `position` is the rotation order and is unique per schedule, so two people
 * cannot silently share a slot. `userId` cascades — see the module note.
 */
export const onCallParticipants = pgTable(
  "on_call_participants",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => onCallSchedules.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    scheduleIdx: index("on_call_participants_schedule_idx").on(t.scheduleId, t.position),
    /** One slot per person per rotation — validated in the UI, enforced here. */
    scheduleUserUnique: uniqueIndex("on_call_participants_schedule_user_unique").on(
      t.scheduleId,
      t.userId,
    ),
  }),
);

/**
 * A cover: one person taking another's place for a bounded window.
 *
 * Stored rather than folded into the rotation, because "Sam covered Tuesday
 * night" is a fact somebody wants to read back six months later — and because
 * a rotation edited to express a one-off cover is a rotation nobody can reason
 * about afterwards.
 *
 * `userId` cascades for the same reason participants do: a cover naming
 * somebody who has left must not survive them.
 */
export const onCallOverrides = pgTable(
  "on_call_overrides",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => onCallSchedules.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    reason: text("reason"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    /** The resolve path's read: one schedule's covers around an instant. */
    scheduleWindowIdx: index("on_call_overrides_schedule_window_idx").on(
      t.scheduleId,
      t.startsAt,
      t.endsAt,
    ),
    orgIdx: index("on_call_overrides_org_idx").on(t.organizationId),
  }),
);
