/**
 * Provider quota readings, their history, and the collection bookkeeping.
 *
 * Three tables, the `credit-schema.ts` shape for the same reasons — "what is
 * the headroom right now" wants one row per quota, overwritten, so the panel
 * is an indexed read rather than a max-over-history; "is it trending to
 * exhaustion" wants the series; and "why is this account showing nothing" wants
 * a persisted error rather than a log line nobody will read.
 *
 * One difference from credits, and it is the whole point of the feature: the
 * `limit` is stored on every row, current and historical. A quota's ceiling
 * moves when a support ticket is approved, and a trend computed against
 * today's limit would rewrite last week's utilisation the moment it did — an
 * account that was at 95% and got an increase would retroactively read as
 * having been fine all along, which is the opposite of the fact worth keeping.
 *
 * Neither carries an FK to `accounts` beyond the cascade: an account deleted
 * takes its quota history with it, which is right — headroom on an account
 * that no longer exists is not a fact anybody needs.
 */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { accounts, organizations, users } from "./core-schema.js";

/**
 * The latest reading for one quota. `(account_id, quota_key)` is the identity,
 * where `quota_key` is the plugin's own stable id — derived from the
 * provider's quota code and scope, never from the label or the value, so a
 * limit increase continues one series instead of starting a fresh empty one.
 */
export const accountQuotaUsage = pgTable(
  "account_quota_usage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Plugin-chosen stable key (`ec2/L-1216C47A/eu-west-1`). */
    quotaKey: text("quota_key").notNull(),
    /** Provider service in the provider's own vocabulary (`ec2`, `compute`). */
    service: text("service").notNull(),
    name: text("name").notNull(),
    /** Null — never the string "global" — for an account-wide quota. */
    region: text("region"),
    quotaLimit: doublePrecision("quota_limit").notNull(),
    used: doublePrecision("used").notNull(),
    /**
     * Denormalized `used / quota_limit`, written by the collector rather than
     * computed on read. It is what the surface sorts and filters on, and an
     * expression index over a division that both operands can be null-free but
     * zero in is more fragile than one stored column.
     */
    utilization: doublePrecision("utilization").notNull(),
    unit: text("unit"),
    /** Null when the plugin does not know whether an increase can be requested. */
    adjustable: boolean("adjustable"),
    docsUrl: text("docs_url"),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    accountQuotaUnique: uniqueIndex("account_quota_usage_account_quota_unique").on(
      t.accountId,
      t.quotaKey,
    ),
    /**
     * `(organization_id, utilization)` rather than `(organization_id)` alone:
     * every read of this table is "the org's quotas, worst first", and the
     * ordering is what the page is *for*.
     */
    orgUtilizationIdx: index("account_quota_usage_org_utilization_idx").on(
      t.organizationId,
      t.utilization,
    ),
  }),
);

/**
 * The readings, in order. One row per collection per quota.
 *
 * `quota_limit` is repeated here deliberately (see the module header): the
 * historical utilisation is only meaningful against the limit that applied at
 * the time, and recomputing it against today's would silently rewrite the past
 * every time an increase is approved.
 *
 * A quota whose *usage* has not moved still gets a row. A flat stretch is
 * evidence of a stable account, and dropping it would make a stable quota
 * indistinguishable from an uncollected one — the `credit-schema.ts` rule.
 */
export const accountQuotaSnapshots = pgTable(
  "account_quota_snapshots",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    quotaKey: text("quota_key").notNull(),
    quotaLimit: doublePrecision("quota_limit").notNull(),
    used: doublePrecision("used").notNull(),
    utilization: doublePrecision("utilization").notNull(),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
  },
  (t) => ({
    accountQuotaObservedIdx: index("account_quota_snapshots_account_quota_observed_idx").on(
      t.accountId,
      t.quotaKey,
      t.observedAt,
    ),
    /** Drives the per-org retention prune as an index range scan. */
    orgObservedIdx: index("account_quota_snapshots_org_observed_idx").on(
      t.organizationId,
      t.observedAt,
    ),
  }),
);

/**
 * Per-account collection schedule and last failure, the `account_credit_polls`
 * shape verbatim.
 *
 * A separate table rather than more columns on `accounts`: quota-capable
 * plugins are a minority, and a row that only exists for accounts the pass has
 * touched keeps the due-work query a scan of a tiny table instead of the whole
 * account set.
 */
export const accountQuotaPolls = pgTable(
  "account_quota_polls",
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
     * Last failure, kept so the panel can explain an account with no readings
     * rather than leaving the user to read it as "no quotas near the ceiling".
     * That distinction is the whole reason this column exists rather than a
     * log line. Cleared on the next success.
     */
    lastError: text("last_error"),
    /** Set when the plugin threw `QuotaAccessError` — a fixable permission gap. */
    lastErrorHelpLabel: text("last_error_help_label"),
    lastErrorHelpUrl: text("last_error_help_url"),
  },
  (t) => ({
    dueIdx: index("account_quota_polls_due_idx").on(t.nextPollAt),
    orgIdx: index("account_quota_polls_org_idx").on(t.organizationId),
  }),
);

/**
 * Per-org quota alert settings. One row per org; a missing row means the
 * shipped defaults, the `org_expiry_settings` / `org_drift_alert_settings`
 * contract.
 *
 * `last_notified_at` is a **claim**, not bookkeeping — see
 * `server-core/src/quotas/alerts.ts`. It records the last alert *scan*: a scan
 * that found nothing over threshold keeps the window spent, because quota
 * utilisation moves on the scale of provisioning decisions and re-scanning a
 * quiet org every tick would only reconfirm the same silence.
 */
export const orgQuotaSettings = pgTable("org_quota_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  /**
   * Utilisation fraction (0–1) at or above which a quota alerts. Stored as a
   * fraction rather than a percentage so it never has to be divided by 100 in
   * two places that could disagree.
   */
  threshold: doublePrecision("threshold").notNull().default(0.8),
  lastNotifiedAt: timestamp("last_notified_at"),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
