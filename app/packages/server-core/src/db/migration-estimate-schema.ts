/**
 * Saved migration estimates: "what would this service cost on provider X?".
 *
 * Only the inputs are stored (what to price, where, and the user's per-row
 * overrides), never a figure. The current side of an estimate is the org's
 * billed spend, which a viewer may only see through their cost visibility
 * scope, so a stored total would show one member's org-wide money to another;
 * and the target side is list prices that move. Both are computed on read.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

export const migrationEstimates = pgTable(
  "migration_estimates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * `{ kind: "service", serviceId }` or `{ kind: "resources", resourceIds }`.
     * A service source is resolved to its members on every read, so the
     * estimate follows the service as it changes.
     */
    source: jsonb("source").notNull(),
    targetPluginId: text("target_plugin_id").notNull(),
    /** Null: the target region nearest the sources. */
    targetRegion: text("target_region"),
    /** Per source resource id: `{ resourceTypeId?, sizeId? }`. */
    overrides: jsonb("overrides").notNull().default({}),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("migration_estimates_org_idx").on(t.organizationId, t.updatedAt),
  }),
);
