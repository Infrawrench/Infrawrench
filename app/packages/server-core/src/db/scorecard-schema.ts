/**
 * The scorecard's one table: a daily reading, so "are we getting better?" has
 * an answer.
 *
 * The score itself is computed on read from the six feeds it summarises — the
 * posture/backup-coverage stance, and for the same reason. What has to be
 * stored is *history*, because a percentage with nothing to compare it against
 * is a number people glance at once.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

import { organizations } from "./core-schema.js";

/**
 * One day's reading for one org.
 *
 * **`(organization_id, day)` is unique, and that uniqueness is the whole
 * concurrency protocol.** The poller pass inserts with `onConflictDoNothing`,
 * so N replicas racing the same day produce one row and nobody needs a lock or
 * a claim column — the same trick `budget_alert_events` uses for once-per-period
 * delivery.
 *
 * `day` is a `YYYY-MM-DD` text column in UTC rather than a date type: it is
 * only ever compared for equality and ordering, it is what the wire carries,
 * and a text column reads correctly in a psql session without anyone having to
 * remember the session timezone.
 *
 * `pillars` is jsonb of `{pillarId: score}` and deliberately omits a pillar
 * that was unassessed that day, rather than storing a zero or a null. A history
 * that cannot distinguish "we scored badly" from "we could not look" would
 * reintroduce, in the trend line, exactly the lie the live computation refuses
 * to tell.
 */
export const scorecardSnapshots = pgTable(
  "scorecard_snapshots",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `YYYY-MM-DD`, UTC. */
    day: text("day").notNull(),
    /** 0–100 over the pillars assessed that day. */
    score: integer("score").notNull(),
    /** "A".."F", stored rather than derived so a boundary change cannot rewrite history. */
    grade: text("grade").notNull(),
    /** `{pillarId: score}`; a pillar unassessed that day is absent. */
    pillars: jsonb("pillars").notNull().$type<Record<string, number>>().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgDayUnique: uniqueIndex("scorecard_snapshots_org_day_unique").on(t.organizationId, t.day),
    orgDayIdx: index("scorecard_snapshots_org_day_idx").on(t.organizationId, t.day),
  }),
);
