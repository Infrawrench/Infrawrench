/**
 * Restore drills — the record that somebody actually tried.
 *
 * One table, and it is deliberately a *log* rather than a state: a drill is an
 * event that happened on a date, and "where does this resource stand" is
 * derived from the log on read (`drillStanding`) exactly as posture findings and
 * backup coverage are. Storing a standing would create a second thing that can
 * disagree with the drills it was computed from.
 *
 * `resourceId` is a plain column with no foreign key, matching the way the rest
 * of the product references synced resources: a resource row is re-created by
 * every sync, and a drill is evidence about a *system* rather than about a row.
 * The evidence that the orders database restored in 45 minutes should survive
 * that database being re-synced under a new internal id — and it should
 * certainly survive somebody deleting the resource, because "we tested this and
 * then removed it" is a fact an auditor asks about.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

export const restoreDrills = pgTable(
  "restore_drills",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Infrawrench resource id. No FK — see the module note. */
    resourceId: text("resource_id").notNull(),
    /**
     * When the drill was performed, which is **not** when it was recorded.
     * People write these up on Monday for a drill they ran on Saturday, and
     * every staleness computation uses this column rather than `created_at`.
     */
    performedAt: timestamp("performed_at").notNull(),
    /** "verified" | "restored-unverified" | "failed" | "blocked" */
    outcome: text("outcome")
      .$type<"verified" | "restored-unverified" | "failed" | "blocked">()
      .notNull(),
    /**
     * Measured wall-clock minutes. Null when the drill did not get that far —
     * a blocked drill has no RTO, and an invented one would be the most
     * dangerous number on the page.
     */
    rtoMinutes: integer("rto_minutes"),
    /** Snapshot id, S3 key, a date — whatever form the operator has it in. */
    restoredFrom: text("restored_from"),
    /** What was checked, or what went wrong. The most re-read field here. */
    notes: text("notes"),
    performedByUserId: text("performed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    /** The read: one org's drills for a resource, newest performed first. */
    orgResourceIdx: index("restore_drills_org_resource_idx").on(
      t.organizationId,
      t.resourceId,
      t.performedAt,
    ),
    orgPerformedIdx: index("restore_drills_org_performed_idx").on(t.organizationId, t.performedAt),
  }),
);
