/**
 * Compliance: the org's per-control decisions.
 *
 * Control status is computed on read from the evidence sources (the posture
 * and backup-coverage stance: a stored status would be a second thing that
 * can disagree with the evidence). What is stored is only what a person
 * decided: whether a control applies (with the written justification an
 * auditor asks for when it does not), who owns it, and notes.
 *
 * Keyed by `(organization_id, framework_id, control_id)`. Framework and
 * control ids are the registry's (`client-core/src/compliance/frameworks/`),
 * not foreign keys: a control dropped from a framework file leaves its row
 * inert rather than failing a migration. A missing row means "applicable,
 * unowned", so the table only ever holds decisions somebody made.
 *
 * Pack schedules are not here: they are `report_notifications` rows with
 * `compliance_framework_id` set (see that table).
 *
 * Lives in its own module (importing only `core-schema.js`) and is
 * re-exported from `schema.ts`, the satellite-schema convention.
 */
import { boolean, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

export const complianceControlSettings = pgTable(
  "compliance_control_settings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    frameworkId: text("framework_id").notNull(),
    controlId: text("control_id").notNull(),
    applicable: boolean("applicable").notNull().default(true),
    /** Required when `applicable` is false; enforced by the store and the editors. */
    justification: text("justification"),
    /**
     * A member who owns the control. `set null` would silently turn an owned
     * control into an unowned one when somebody leaves; no FK instead, so the
     * status screen can say "Former member" and the gap is visible.
     */
    ownerUserId: text("owner_user_id"),
    /** A team or alias when the owner is not one member. */
    ownerLabel: text("owner_label"),
    notes: text("notes"),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.organizationId, t.frameworkId, t.controlId] }),
  }),
);
