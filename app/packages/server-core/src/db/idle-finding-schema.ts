/**
 * Metric-based idle findings (`manifest.idleFindings`), their collection
 * bookkeeping, and the org's tuning.
 *
 * The `quota-schema.ts` shape: the findings table is the latest verdict per
 * (account, rule, subject), replaced wholesale by each collection; the poll
 * table is the lease and the persisted error ("why is this account showing
 * nothing" deserves an answer, not a log line); the settings table is one row
 * per org, where a missing row means the shipped defaults.
 *
 * Findings are a verdict, not a series: the evidence behind a flag is the
 * metric aggregate over the window it was judged on, which the provider can
 * recompute at any time, so there is no snapshot history to keep.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { IdleMetricEvidence, IdleSavingsEstimate } from "@infrawrench/plugin-base";

import { accounts, organizations, users } from "./core-schema.js";

/**
 * One idle finding. `(account_id, rule_id, subject_key)` is the identity:
 * `subject_key` is the plugin's stable key for the thing flagged (the
 * resource's provider id, or a metric name), so a resource that stays idle
 * keeps its `first_detected_at` across collections.
 *
 * `resource_id` is a soft reference to `resources.id` (no FK: resources are
 * soft-deleted and the read joins on `deleted_at IS NULL`), null for a subject
 * that is not a synced resource (a Datadog custom metric).
 */
export const accountIdleFindings = pgTable(
  "account_idle_findings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    ruleId: text("rule_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    resourceId: text("resource_id"),
    resourceTypeId: text("resource_type_id"),
    displayName: text("display_name").notNull(),
    subjectLabel: text("subject_label"),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<IdleMetricEvidence[]>().notNull(),
    estimate: jsonb("estimate").$type<IdleSavingsEstimate | null>(),
    /** Primitive fields the plugin reported for remediation generators. */
    fields: jsonb("fields").$type<Record<string, string | number | boolean>>().notNull(),
    lookbackDays: integer("lookback_days").notNull(),
    firstDetectedAt: timestamp("first_detected_at").notNull(),
    evaluatedAt: timestamp("evaluated_at").notNull(),
  },
  (t) => ({
    identityIdx: uniqueIndex("account_idle_findings_identity_idx").on(
      t.accountId,
      t.ruleId,
      t.subjectKey,
    ),
    orgIdx: index("account_idle_findings_org_idx").on(t.organizationId),
  }),
);

/** Collection bookkeeping per account: the `account_quota_polls` protocol. */
export const accountIdlePolls = pgTable(
  "account_idle_polls",
  {
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    lastPolledAt: timestamp("last_polled_at"),
    /** Due time AND claim lease. Settings changes set it to now() for a re-scan. */
    nextPollAt: timestamp("next_poll_at"),
    failureCount: integer("failure_count").notNull().default(0),
    /** Last failure, cleared on the next success; shown on the rules panel. */
    lastError: text("last_error"),
    /** Set when the plugin threw `IdleFindingAccessError`: a fixable permission gap. */
    lastErrorHelpLabel: text("last_error_help_label"),
    lastErrorHelpUrl: text("last_error_help_url"),
  },
  (t) => ({
    dueIdx: index("account_idle_polls_due_idx").on(t.nextPollAt),
    orgIdx: index("account_idle_polls_org_idx").on(t.organizationId),
  }),
);

/**
 * Per-org tuning of the idle rules. `rules` holds only what the org changed,
 * keyed by `pluginId:ruleId`: `{ enabled?, thresholds? }`. A rule absent from
 * it runs enabled with its declared defaults, so a rule a plugin adds later is
 * on without anybody saving the form.
 */
export const orgIdleFindingSettings = pgTable("org_idle_finding_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  lookbackDays: integer("lookback_days").notNull().default(14),
  rules: jsonb("rules")
    .$type<Record<string, { enabled?: boolean; thresholds?: Record<string, number> }>>()
    .notNull()
    .default({}),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
