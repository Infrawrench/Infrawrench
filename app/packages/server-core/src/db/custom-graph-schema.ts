/**
 * Custom graphs — org-authored scripts (run in the workflow isolate) that
 * describe a dashboard chart, its controls, and its refresh policy.
 *
 * Kept in its own module with self-contained imports; re-exported from
 * schema.ts so Drizzle + `@infrawrench/server-core/db/schema` consumers pick
 * it up. Paid-plan-only at the service layer (`requirePaidPlan`), not here.
 */
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { organizations } from "./core-schema.js";

export const customGraphs = pgTable(
  "custom_graphs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** The user-authored TypeScript source. */
    source: text("source").notNull().default(""),
    createdByUserId: text("created_by_user_id"),
    /**
     * Who last wrote `source` — the user whose role permissions the script's
     * `infra.*` access runs as at render time (definer-style, since any viewer
     * with dashboards:read can trigger a render). Updated on every source
     * change, so editing someone else's graph makes it run as YOU. Null on
     * rows that predate infra access; those render with `infra.*` disabled.
     */
    sourceAuthorUserId: text("source_author_user_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("custom_graphs_org_idx").on(t.organizationId),
  }),
);

/**
 * The graph's private key/value store (`graph.data.*`). Scoped by graph id;
 * `organization_id` is denormalized on so a leaked graph id from another org
 * still can't be read — every query filters on both.
 */
export const customGraphData = pgTable(
  "custom_graph_data",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    graphId: text("graph_id")
      .notNull()
      .references(() => customGraphs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    graphKeyUnique: uniqueIndex("custom_graph_data_graph_key_unique").on(t.graphId, t.key),
  }),
);
