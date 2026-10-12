/**
 * Paid SaaS seats (Copilot, Cursor, GitLab, Okta...) and their collection
 * schedule. See plugin-base `seats.ts` for the plugin contract and
 * client-core `seats.ts` for the findings computed over these rows.
 *
 * `account_seats` is a mirror of what the provider reported on the last
 * collection: upserted on `(account_id, member_id, seat_key)` and swept of
 * rows the provider stopped reporting, the `account_commitments` protocol.
 * Price and activity columns are nullable on purpose: "the provider does not
 * say" must never render as "$0" or "idle".
 *
 * `account_seat_polls` is `account_commitment_polls` verbatim (sparse side
 * table, `next_poll_at` is the due time AND the claim lease), because
 * seat-capable plugins are a small minority of accounts.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { accounts, organizations } from "./core-schema.js";

export const accountSeats = pgTable(
  "account_seats",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    /** Provider-native member id. */
    memberId: text("member_id").notNull(),
    /** "" for providers with one seat per member; part of the identity. */
    seatKey: text("seat_key").notNull().default(""),
    name: text("name"),
    /** Lower-cased: the cross-tool duplicate join key. */
    email: text("email"),
    login: text("login"),
    product: text("product").notNull(),
    /** ai-coding | ai-assistant | source-control | identity | other */
    category: text("category").notNull(),
    seatType: text("seat_type").notNull(),
    monthlyPrice: doublePrecision("monthly_price"),
    currency: text("currency"),
    /** billing | catalog | configured | list-price */
    priceSource: text("price_source"),
    priceNote: text("price_note"),
    /** last-activity | last-login | usage-window | none */
    activityBasis: text("activity_basis").notNull(),
    lastActiveAt: timestamp("last_active_at"),
    activityWindowDays: integer("activity_window_days"),
    activitySource: text("activity_source").notNull().default(""),
    assignedAt: timestamp("assigned_at"),
    pendingRemovalOn: timestamp("pending_removal_on"),
    removable: boolean("removable").notNull().default(false),
    removalNote: text("removal_note"),
    /** {seatType, price: {monthly, currency, source, note?}, reason} */
    downgrade: jsonb("downgrade").$type<{
      seatType: string;
      price: { monthly: number; currency: string; source: string; note?: string };
      reason: string;
    }>(),
    /** The plugin's remediation context (org login, group id, domain). */
    context: jsonb("context").$type<Record<string, string>>(),
    resourceTypeId: text("resource_type_id"),
    externalId: text("external_id"),
    /** Last collection that still saw this seat. */
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    accountMemberUnique: uniqueIndex("account_seats_account_member_unique").on(
      t.accountId,
      t.memberId,
      t.seatKey,
    ),
    orgIdx: index("account_seats_org_idx").on(t.organizationId),
  }),
);

export const accountSeatPolls = pgTable(
  "account_seat_polls",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastPolledAt: timestamp("last_polled_at"),
    /** Due time AND claim lease, the `accounts.next_poll_at` protocol. */
    nextPollAt: timestamp("next_poll_at"),
    failureCount: integer("failure_count").notNull().default(0),
    /** Last failure, cleared on the next success. */
    lastError: text("last_error"),
  },
  (t) => ({
    dueIdx: index("account_seat_polls_due_idx").on(t.nextPollAt),
    orgIdx: index("account_seat_polls_org_idx").on(t.organizationId),
  }),
);

/**
 * Per-org seat tuning. No row means the defaults (30 days), the
 * `org_savings_settings` protocol.
 */
export const orgSeatSettings = pgTable("org_seat_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  inactiveDays: integer("inactive_days").notNull().default(30),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
