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
/**
 * Fired commitment-expiry warnings: one row per (account, commitment, term
 * end, horizon).
 *
 * The `budget_alert_events` once-per-period protocol — insert with
 * `onConflictDoNothing`, notify only on a fresh insert — with the "period"
 * being a horizon rather than a month. That is what makes 60/30/7 three
 * alerts and not three hundred: the daily pass re-evaluates every commitment,
 * and every horizon it already crossed collides with its own row.
 *
 * **`term_end_day` is in the key on purpose.** A commitment whose end date
 * moves — an in-place extension, or a provider correcting a date — is a
 * different term and deserves its own countdown. Without it, extending a
 * reservation by a year would buy permanent silence on its next expiry.
 *
 * Horizon `0` is the already-expired case: one alert for a commitment that
 * lapsed without any warning having fired, which is the only way an org that
 * connected the account late ever hears about it.
 */
export const commitmentExpiryEvents = pgTable(
  "commitment_expiry_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Provider-native commitment id, matching `account_commitments`. */
    commitmentId: text("commitment_id").notNull(),
    /** The term end this countdown is against, ISO day. */
    termEndDay: text("term_end_day").notNull(),
    /** Days of notice; 0 means it had already expired when we first saw it. */
    horizonDays: integer("horizon_days").notNull(),
    /** Snapshot of the holding, so the list renders without a join. */
    description: text("description").notNull(),
    currency: text("currency"),
    /** Committed spend per hour at the time of firing. */
    hourlyCommitmentAmount: doublePrecision("hourly_commitment_amount"),
    /**
     * What the usage this commitment currently covers would cost per month at
     * on-demand rates, in `currency` units — null when the holding carries no
     * money (GCP CUDs) or nothing was delivered to measure.
     */
    onDemandMonthlyAmount: doublePrecision("on_demand_monthly_amount"),
    firedAt: timestamp("fired_at").notNull().defaultNow(),
    notifiedAt: timestamp("notified_at"),
  },
  (t) => ({
    onceUnique: uniqueIndex("commitment_expiry_once_unique").on(
      t.accountId,
      t.commitmentId,
      t.termEndDay,
      t.horizonDays,
    ),
    orgFiredIdx: index("commitment_expiry_events_org_fired_idx").on(t.organizationId, t.firedAt),
  }),
);

/**
 * Fired idle-commitment findings: one row per (account, commitment, month).
 *
 * Monthly rather than per-window, deliberately. Idleness is a standing
 * condition, not an event: a commitment under its threshold today is under it
 * tomorrow too, and a per-window key (the window slides daily) would restate
 * the same fact every morning until the term ends. Once a month is the
 * cadence at which "this is still wasting money" is worth re-reading, and it
 * matches the cadence at which anyone could actually do something about it.
 */
export const commitmentIdleEvents = pgTable(
  "commitment_idle_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    commitmentId: text("commitment_id").notNull(),
    /** "YYYY-MM" the window ended in — the dedup key. */
    periodKey: text("period_key").notNull(),
    /** The measured window, inclusive ISO days. */
    windowFrom: text("window_from").notNull(),
    windowTo: text("window_to").notNull(),
    description: text("description").notNull(),
    currency: text("currency"),
    /** delivered / obligation over the measured days, unclamped. */
    utilization: doublePrecision("utilization").notNull(),
    /** hourly × 24 × measuredDays, in `currency` units. */
    obligationAmount: doublePrecision("obligation_amount").notNull(),
    deliveredAmount: doublePrecision("delivered_amount").notNull(),
    /** obligation − delivered, floored at 0 — the money that bought nothing. */
    wastedAmount: doublePrecision("wasted_amount").notNull(),
    /** Window days that carried cost data, and window days that did not. */
    measuredDays: integer("measured_days").notNull(),
    missingDays: integer("missing_days").notNull(),
    firedAt: timestamp("fired_at").notNull().defaultNow(),
    notifiedAt: timestamp("notified_at"),
  },
  (t) => ({
    onceUnique: uniqueIndex("commitment_idle_once_unique").on(
      t.accountId,
      t.commitmentId,
      t.periodKey,
    ),
    orgFiredIdx: index("commitment_idle_events_org_fired_idx").on(t.organizationId, t.firedAt),
  }),
);

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
