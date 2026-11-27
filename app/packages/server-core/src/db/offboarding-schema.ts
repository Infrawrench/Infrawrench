/**
 * Offboarding sweeps: one checklist per person leaving, and its rows.
 *
 * Satellite schema: imports only `core-schema.js`, re-exported from
 * `schema.ts`.
 *
 * Deliberately **no foreign key** from an offboarding to the person's user
 * row. Removing them from the organization is one of the checklist's own
 * steps, and a cascade (or a `set null`) from it would erase who the record
 * is about at the moment it becomes evidence. The email and name are kept as
 * snapshots instead, the `jit_access_requests` stance.
 */
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organizations } from "./core-schema.js";

export const offboardings = pgTable(
  "offboardings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lower-cased. The one identity every source agrees on. */
    email: text("email").notNull(),
    /** Their Infrawrench user id when they were a member. Not an FK: see the module doc. */
    subjectUserId: text("subject_user_id"),
    subjectName: text("subject_name"),
    /** Handles and other addresses providers know them by, normalized. */
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /** "open" | "completed" | "canceled" */
    status: text("status").notNull().default("open"),
    /** "manual" | "directory" */
    source: text("source").notNull().default("manual"),
    sourceDetail: text("source_detail"),
    note: text("note"),
    startedByUserId: text("started_by_user_id"),
    startedByName: text("started_by_name"),
    lastScannedAt: timestamp("last_scanned_at"),
    /** The last scan matched more resources than it reads; some may be missing. */
    scanTruncated: boolean("scan_truncated").notNull().default(false),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("offboardings_org_idx").on(t.organizationId, t.createdAt),
    /**
     * One open checklist per person: a second "Start offboarding" (or a
     * directory event arriving twice) lands on the existing one.
     */
    openEmailUnique: uniqueIndex("offboardings_org_open_email_unique")
      .on(t.organizationId, t.email)
      .where(sql`status = 'open'`),
  }),
);

export const offboardingItems = pgTable(
  "offboarding_items",
  {
    id: text("id").primaryKey(),
    offboardingId: text("offboarding_id")
      .notNull()
      .references(() => offboardings.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Stable across scans (`seat:<id>`, `principal:<resourceId>`): what a rescan upserts on. */
    itemKey: text("item_key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    pluginId: text("plugin_id"),
    providerName: text("provider_name"),
    /** Snapshots, not FKs: the row must outlive a disconnected account. */
    accountId: text("account_id"),
    accountName: text("account_name"),
    resourceId: text("resource_id"),
    resourceTypeId: text("resource_type_id"),
    /** "exact" | "alias" | "possible" */
    confidence: text("confidence").notNull(),
    matchReason: text("match_reason").notNull(),
    /** "matched" | "unconfirmed" | "confirmed" | "rejected" */
    matchState: text("match_state").notNull(),
    actions: jsonb("actions").$type<string[]>().notNull().default([]),
    /** What the server needs to act on the row: ids only, never a secret. */
    ref: jsonb("ref").$type<Record<string, string>>().notNull().default({}),
    /** "open" | "done" | "skipped" | "failed" | "gone" */
    status: text("status").notNull().default("open"),
    /** The action that resolved it, "manual", or "gone". */
    resolution: text("resolution"),
    lastError: text("last_error"),
    note: text("note"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedByName: text("resolved_by_name"),
    resolvedAt: timestamp("resolved_at"),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    offboardingKeyUnique: uniqueIndex("offboarding_items_key_unique").on(
      t.offboardingId,
      t.itemKey,
    ),
    orgIdx: index("offboarding_items_org_idx").on(t.organizationId),
  }),
);
