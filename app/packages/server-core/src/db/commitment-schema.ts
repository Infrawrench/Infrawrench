/**
 * Commitment inventory (reservations, savings plans, committed-use
 * discounts) and its collection schedule.
 *
 * One row per provider commitment per account, replaced wholesale on each
 * collection: the provider's list APIs return the entire holding (expired
 * records included), so `(account_id, commitment_id)` upserts plus a sweep of
 * rows the provider stopped reporting keep this an exact mirror. Money
 * columns are nullable on purpose — Azure's list API reports no purchase
 * price and GCP's reports no money at all, and a substituted zero renders as
 * "free" where a NULL renders as "not reported". One of those ends up in a
 * finance review.
 *
 * The poll table follows `account_credit_polls` exactly, and for the same
 * reason: commitment-capable plugins are a small minority (three), so a
 * sparse side table keeps the due-work query off the whole account set.
 */
import {
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

export const accountCommitments = pgTable(
  "account_commitments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    /**
     * Provider-native commitment id — the join key against
     * `cost_daily.commitment_id` (an ARN where billing data carries ARNs,
     * the bare id where it does not, e.g. EC2 RIs).
     */
    commitmentId: text("commitment_id").notNull(),
    /** "reservation" | "savings_plan" | "committed_use" */
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    /** Provider scope qualifier (an AZ, "Shared", an instance family). */
    scope: text("scope"),
    /** NULL means "applies across regions" — a real state, not missing data. */
    region: text("region"),
    startDate: timestamp("start_date"),
    endDate: timestamp("end_date"),
    /** Provider-reported term length; never derived from the dates. */
    termDays: integer("term_days"),
    /** "all_upfront" | "partial_upfront" | "no_upfront" | "monthly" */
    paymentOption: text("payment_option"),
    /** ISO 4217, NULL when the record carries no money. */
    currency: text("currency"),
    upfrontAmount: doublePrecision("upfront_amount"),
    recurringAmount: doublePrecision("recurring_amount"),
    /** "hour" | "month" — atomic with recurring_amount. */
    recurringPeriod: text("recurring_period"),
    /** Committed spend per hour — what utilization is measured against. */
    hourlyCommitmentAmount: doublePrecision("hourly_commitment_amount"),
    /** [{unit, amount}] for unit-denominated commitments (GCP CUDs). */
    unitCommitments: jsonb("unit_commitments").$type<Array<{ unit: string; amount: number }>>(),
    /** "active" | "expired" | "queued" */
    state: text("state").notNull(),
    /**
     * [{grainDays, percentage}] — the provider's own utilization aggregates
     * (Azure only), passed through and never blended with derived figures.
     */
    providerUtilization:
      jsonb("provider_utilization").$type<Array<{ grainDays: number; percentage: number }>>(),
    /** Last collection that still saw this record from the provider. */
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    accountCommitmentUnique: uniqueIndex("account_commitments_account_commitment_unique").on(
      t.accountId,
      t.commitmentId,
    ),
    orgIdx: index("account_commitments_org_idx").on(t.organizationId),
  }),
);

/**
 * Per-account collection schedule and last failure, `account_credit_polls`'
 * protocol verbatim: `next_poll_at` is the due time AND the claim lease.
 */
export const accountCommitmentPolls = pgTable(
  "account_commitment_polls",
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
    dueIdx: index("account_commitment_polls_due_idx").on(t.nextPollAt),
    orgIdx: index("account_commitment_polls_org_idx").on(t.organizationId),
  }),
);
