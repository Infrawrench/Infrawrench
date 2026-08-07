/**
 * Prepaid credit balances and their history.
 *
 * Two tables because the two questions are different. "What is left right
 * now" wants one row per pot, overwritten; "how fast is it going" wants the
 * series. Keeping the current balance denormalized means the panel is one
 * indexed read rather than a max-over-history, and keeping the series means
 * the burn rate is measured rather than guessed.
 *
 * Neither carries an FK to `accounts` beyond the cascade: an account deleted
 * takes its credit history with it, which is right — a burn rate for an
 * account that no longer exists is not a fact anybody needs.
 */
import {
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { accounts, organizations } from "./core-schema.js";

/**
 * The latest reading for one pot. `(account_id, pot_key)` is the identity —
 * a provider that splits credit by currency or by project gets a row each,
 * because "$40 and ¥300" is not a number and one project running dry while
 * another has headroom is exactly what this is for.
 */
export const accountCreditBalances = pgTable(
  "account_credit_balances",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Plugin-chosen stable key for this pot ("USD", a project id, "default"). */
    potKey: text("pot_key").notNull(),
    label: text("label").notNull(),
    remaining: doublePrecision("remaining").notNull(),
    currency: text("currency").notNull(),
    /** What was granted, when the provider reports it. Null is common. */
    granted: doublePrecision("granted"),
    /** Hard expiry on the credit itself, independent of burn. */
    creditExpiresAt: timestamp("credit_expires_at"),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    accountPotUnique: uniqueIndex("account_credit_balances_account_pot_unique").on(
      t.accountId,
      t.potKey,
    ),
    orgIdx: index("account_credit_balances_org_idx").on(t.organizationId),
  }),
);

/**
 * The readings, in order. One row per collection per pot.
 *
 * Retained rather than aggregated because a burn rate computed over a window
 * needs the endpoints of that window, and the honest window depends on what a
 * caller asks for. The rows are tiny and written roughly daily, so a year of
 * history for a busy org is a few thousand rows.
 *
 * A top-up shows up here as a jump upward, which is exactly why the burn
 * calculation looks at consecutive pairs rather than first-vs-last: subtracting
 * the endpoints of a window containing a top-up reports a *negative* burn and
 * an infinite runway, which is the most dangerous possible wrong answer.
 */
export const accountCreditSnapshots = pgTable(
  "account_credit_snapshots",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    potKey: text("pot_key").notNull(),
    remaining: doublePrecision("remaining").notNull(),
    currency: text("currency").notNull(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
  },
  (t) => ({
    accountPotObservedIdx: index("account_credit_snapshots_account_pot_observed_idx").on(
      t.accountId,
      t.potKey,
      t.observedAt,
    ),
    orgObservedIdx: index("account_credit_snapshots_org_observed_idx").on(
      t.organizationId,
      t.observedAt,
    ),
  }),
);

/**
 * Per-account collection schedule and last failure, parallel to the cost-poll
 * columns on `accounts` but for the credits pass.
 *
 * A separate table rather than four more columns on `accounts`: credit-capable
 * plugins are a small minority (three at the time of writing), and a row that
 * only exists for accounts the pass actually touches keeps the due-work query
 * a scan of a tiny table instead of the whole account set.
 */
export const accountCreditPolls = pgTable(
  "account_credit_polls",
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
    /**
     * Last failure, kept so the panel can explain a missing balance rather
     * than leaving the user to guess. Cleared on the next success.
     */
    lastError: text("last_error"),
    /** Set when the plugin threw `CreditAccessError` — a permission gap. */
    lastErrorHelpLabel: text("last_error_help_label"),
    lastErrorHelpUrl: text("last_error_help_url"),
  },
  (t) => ({
    dueIdx: index("account_credit_polls_due_idx").on(t.nextPollAt),
    orgIdx: index("account_credit_polls_org_idx").on(t.organizationId),
  }),
);
