/**
 * Backup coverage — the org's recovery objectives.
 *
 * There is exactly one table, and it holds *policies*, not findings. Coverage
 * is recomputed from synced inventory on every read (`backups/feed.ts`,
 * `computeBackupCoverage`) exactly as posture findings are, for the same
 * reason: a finding has no identity of its own — it is a fact about the state
 * of the world at the moment you asked — and materialising one would only
 * create a second thing that can be stale.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import { pgTable, text, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * One recovery objective, applied to whichever stateful resources its selector
 * picks out.
 *
 * The selector is two independent narrowings rather than a query language —
 * resource types and one tag — because those are the two axes people actually
 * reason about ("all production volumes", "every database"). Both empty means
 * every stateful resource, which is the useful shape for an org's first
 * policy.
 *
 * `resourceTypeIds` is a comma-joined text column rather than jsonb or an array
 * type: the values are short opaque identifiers with no commas, the list is
 * only ever read whole, and text keeps the row readable in a psql session —
 * the same call the sync path makes for comma-joined id fields.
 *
 * `createdBy` is nulled rather than cascaded when the user is deleted: the
 * org's recovery objective outlives whoever typed it in, exactly like a
 * posture dismissal's author.
 */
export const backupPolicies = pgTable(
  "backup_policies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Comma-joined resource type ids; empty string = every stateful type. */
    resourceTypeIds: text("resource_type_ids").notNull().default(""),
    /** Tag key that must be present on the resource; null = no tag narrowing. */
    tagKey: text("tag_key"),
    /** Required value of `tagKey`; null = presence is enough. */
    tagValue: text("tag_value"),
    /** Newest backup must be no older than this many hours; null = no RPO demand. */
    maxRpoHours: integer("max_rpo_hours"),
    /** Provider-native retention must be at least this many days; null = no demand. */
    minRetentionDays: integer("min_retention_days"),
    /**
     * Off keeps the row and stops it judging anything — the schedules `paused`
     * stance. Turning a policy off to investigate a noisy finding must not
     * cost you the policy.
     */
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("backup_policies_org_idx").on(t.organizationId),
  }),
);
