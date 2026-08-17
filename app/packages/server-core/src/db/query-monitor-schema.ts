/**
 * Query monitors: a SQL query on a schedule, with a threshold.
 *
 * One table. The run history is deliberately **not** stored: a monitor's value
 * over time is a metric, and the product already has a place for metrics — a
 * second, worse time series here would be a table nobody prunes. What is kept
 * is the last outcome, which is what the list renders and what the fold needs.
 *
 * Lives in its own module (importing only `core-schema.js`) and is re-exported
 * from `schema.ts`, the satellite-schema convention.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { accounts, organizations, users } from "./core-schema.js";

export const queryMonitors = pgTable(
  "query_monitors",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Cascades: a monitor is a query against one account's connection, so it
     * cannot outlive the account. Unlike most references here that is not a
     * data-loss risk — the query text is the only thing worth keeping, and a
     * query nobody can run is not worth keeping.
     */
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Set when the query runs against one resource rather than the account. */
    resourceId: text("resource_id"),
    resourceTypeId: text("resource_type_id"),
    name: text("name").notNull(),
    description: text("description"),
    sql: text("sql").notNull(),
    /** "scalar" | "rowCount" */
    mode: text("mode").$type<"scalar" | "rowCount">().notNull().default("scalar"),
    /** "gt" | "gte" | "lt" | "lte" | "eq" | "neq" */
    operator: text("operator")
      .$type<"gt" | "gte" | "lt" | "lte" | "eq" | "neq">()
      .notNull()
      .default("gt"),
    threshold: doublePrecision("threshold").notNull(),
    intervalMinutes: integer("interval_minutes").notNull().default(15),
    consecutiveBreaches: integer("consecutive_breaches").notNull().default(1),
    enabled: boolean("enabled").notNull().default(true),

    /**
     * Due time **and** claim lease, the `account_quota_polls` protocol: the
     * poller claims a batch with `UPDATE … WHERE next_run_at <= now() … SKIP
     * LOCKED` and pushes the column forward in the same statement, so replicas
     * share the work without a second table.
     */
    nextRunAt: timestamp("next_run_at").notNull().defaultNow(),
    lastRunAt: timestamp("last_run_at"),
    /** "ok" | "breaching" | "unknown" */
    state: text("state").$type<"ok" | "breaching" | "unknown">().notNull().default("unknown"),
    lastValue: doublePrecision("last_value"),
    /**
     * Why the last run said nothing. Kept rather than collapsed into the state,
     * because "the monitor is broken" and "the data is bad" need different
     * people, and only the message distinguishes them.
     */
    lastError: text("last_error"),
    breachStreak: integer("breach_streak").notNull().default(0),
    lastAlertedAt: timestamp("last_alerted_at"),

    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("query_monitors_org_idx").on(t.organizationId),
    /** The poller's claim: enabled monitors whose next run has come due. */
    dueIdx: index("query_monitors_due_idx").on(t.nextRunAt),
    orgNameUnique: uniqueIndex("query_monitors_org_name_unique").on(t.organizationId, t.name),
  }),
);
