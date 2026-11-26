/**
 * git-feature-flag: which organisations have Git. Temporary; KNOWLEDGE.md
 * "Git feature flag" says how to remove it, and this table goes with it.
 *
 * A row turns on the app's Git surfaces for its organisation and lets its
 * members sign up on git.infrawrench.com. Platform admins add and remove
 * rows from `/admin`.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./core-schema.js";

export const gitFeatureAccess = pgTable("git_feature_access", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** The platform admin who turned it on, by email. */
  enabledBy: text("enabled_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
