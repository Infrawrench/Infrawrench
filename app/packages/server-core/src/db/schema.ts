import {
  pgTable,
  text,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { accounts, dashboards, organizations, users } from "./core-schema.js";

export const roles = pgTable(
  "roles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isSystem: boolean("is_system").notNull().default(false),
    /** "owner" | "admin" | "member" for system rows; null for custom roles */
    systemKey: text("system_key"),
    /** Permission strings; ignored for system roles (resolved from code instead). */
    permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("roles_org_idx").on(t.organizationId),
    orgSystemUnique: uniqueIndex("roles_org_system_unique").on(t.organizationId, t.systemKey),
  }),
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Legacy text role; superseded by roleId. Kept for one release for fallback. */
    role: text("role").notNull().default("member"), // "owner" | "admin" | "member"
    roleId: text("role_id").references(() => roles.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userOrgUnique: uniqueIndex("org_members_user_org_unique").on(t.userId, t.organizationId),
    orgIdx: index("org_members_org_idx").on(t.organizationId),
    userIdx: index("org_members_user_idx").on(t.userId),
    roleIdx: index("org_members_role_idx").on(t.roleId),
  }),
);

export const pluginInstallations = pgTable(
  "plugin_installations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    installedAt: timestamp("installed_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginUnique: uniqueIndex("plugin_install_org_plugin_unique").on(
      t.organizationId,
      t.pluginId,
    ),
    orgIdx: index("plugin_install_org_idx").on(t.organizationId),
  }),
);

export const resources = pgTable(
  "resources",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
    /** Non-secret fields as JSON */
    fieldsJson: jsonb("fields_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Resolved outputs cache as JSON */
    outputsJson: jsonb("outputs_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    parentResourceId: text("parent_resource_id"),
    lastSyncedAt: timestamp("last_synced_at"),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPluginTypeIdx: index("resources_org_plugin_type_idx").on(
      t.organizationId,
      t.pluginId,
      t.resourceTypeId,
    ),
    accountIdx: index("resources_account_idx").on(t.accountId),
    externalIdx: index("resources_external_idx").on(t.pluginId, t.externalId),
    parentIdx: index("resources_parent_idx").on(t.parentResourceId),
  }),
);

/**
 * Change-timeline events — one row per observed difference between consecutive
 * resource snapshots. Written by the shared sync path in `sync-resources.ts`
 * whenever the poller (or a manual refresh) upserts polled state, so every
 * provider gets a drift feed for free. Generic by construction: the diff is
 * computed over the host's stored record (displayName, fieldsJson,
 * outputsJson), never over provider-specific shapes.
 *
 * `resourceId` is deliberately not a FK — the feed is history and must keep
 * rendering rows for resources that disappeared upstream. Cleanup rides the
 * `accountId` cascade instead: deleting an account takes its history with it.
 */
export const resourceChanges = pgTable(
  "resource_changes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    /** Denormalized so deleted resources still render in the feed. */
    displayName: text("display_name").notNull(),
    /** "created" | "updated" | "deleted" */
    changeKind: text("change_kind").$type<"created" | "updated" | "deleted">().notNull(),
    /**
     * Changed top-level fields for "updated" rows:
     * Array<{ field, from, to }>. Empty for created/deleted rows.
     */
    diff: jsonb("diff")
      .$type<{ field: string; from: unknown; to: unknown }[]>()
      .notNull()
      .default([]),
    /**
     * Who caused the change, when a non-sync writer knows: `"schedule"` for
     * sleep/wake schedule transitions. Null = observed by sync (drift, or a
     * user mutation the differ can't attribute).
     */
    origin: text("origin").$type<"schedule">(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("resource_changes_org_created_idx").on(t.organizationId, t.createdAt),
    resourceCreatedIdx: index("resource_changes_resource_created_idx").on(
      t.resourceId,
      t.createdAt,
    ),
    orgAccountIdx: index("resource_changes_org_account_idx").on(t.organizationId, t.accountId),
  }),
);

export const secretFieldStates = pgTable(
  "secret_field_states",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    /** "literal" | "output-ref" */
    resolutionKind: text("resolution_kind").notNull(),
    // Literal columns
    encryptedValue: text("encrypted_value"),
    valueIv: text("value_iv"),
    // Output-ref columns
    sourcePluginId: text("source_plugin_id"),
    sourceResourceTypeId: text("source_resource_type_id"),
    sourceResourceId: text("source_resource_id"),
    sourceAccountId: text("source_account_id"),
    sourceOutputKey: text("source_output_key"),
    // Cache for output-ref
    cachedEncryptedValue: text("cached_encrypted_value"),
    cachedValueIv: text("cached_value_iv"),
    cachedAt: timestamp("cached_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    resourceFieldUnique: uniqueIndex("secret_field_resource_field_unique").on(
      t.resourceId,
      t.fieldKey,
    ),
    resourceIdx: index("secret_field_resource_idx").on(t.resourceId),
  }),
);

export const associations = pgTable(
  "associations",
  {
    id: text("id").primaryKey(),
    consumerResourceId: text("consumer_resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    consumerFieldKey: text("consumer_field_key").notNull(),
    providerResourceId: text("provider_resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "restrict" }),
    providerOutputKey: text("provider_output_key").notNull(),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    consumerUnique: uniqueIndex("assoc_consumer_unique").on(
      t.consumerResourceId,
      t.consumerFieldKey,
    ),
    consumerIdx: index("assoc_consumer_idx").on(t.consumerResourceId),
    providerIdx: index("assoc_provider_idx").on(t.providerResourceId),
  }),
);

export const dashboardPins = pgTable(
  "dashboard_pins",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    gridX: integer("grid_x").notNull().default(0),
    gridY: integer("grid_y").notNull().default(0),
    gridW: integer("grid_w").notNull().default(1),
    gridH: integer("grid_h").notNull().default(1),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dashboardPinUnique: uniqueIndex("dashboard_pin_unique").on(t.dashboardId, t.resourceId),
    dashboardIdx: index("dashboard_pin_dashboard_idx").on(t.dashboardId),
  }),
);

/**
 * Non-resource dashboard cards (cost graphs, budget views). A separate table
 * from dashboardPins — which FKs resources — following the
 * dashboardWorkflowPins precedent of one table per pin kind. `config` is a
 * kind-discriminated JSONB blob validated against the zod schemas in
 * `@infrawrench/ui/cost` at the API boundary.
 */
export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    /** "cost_graph" | "budget" */
    kind: text("kind").notNull(),
    title: text("title").notNull().default(""),
    config: jsonb("config").notNull(),
    gridX: integer("grid_x").notNull().default(0),
    gridY: integer("grid_y").notNull().default(0),
    /** Cost charts want width — default to a double-wide card. */
    gridW: integer("grid_w").notNull().default(2),
    gridH: integer("grid_h").notNull().default(1),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    dashboardIdx: index("dashboard_widgets_dashboard_idx").on(t.dashboardId),
    orgIdx: index("dashboard_widgets_org_idx").on(t.organizationId),
  }),
);

/**
 * Spend budgets. Independent of dashboard widgets — a budget keeps evaluating
 * and alerting even when no widget shows it. `filters` scopes which cost rows
 * count (CostFilter[] from `@infrawrench/ui/cost`); `thresholds` is
 * Array<{ type: "actual" | "forecast"; percent: number }>.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Monthly budget amount in cents of `currency`. */
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    filters: jsonb("filters").notNull().default([]),
    thresholds: jsonb("thresholds").notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("budgets_org_idx").on(t.organizationId),
  }),
);

/**
 * Fired budget-threshold crossings. The unique index makes each threshold
 * fire at most once per calendar month — evaluation inserts with
 * onConflictDoNothing and only notifies on a fresh insert.
 */
export const budgetAlertEvents = pgTable(
  "budget_alert_events",
  {
    id: text("id").primaryKey(),
    budgetId: text("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** "YYYY-MM" (UTC) the crossing was observed in. */
    month: text("month").notNull(),
    thresholdType: text("threshold_type").$type<"actual" | "forecast">().notNull(),
    thresholdPercent: integer("threshold_percent").notNull(),
    actualAmountCents: integer("actual_amount_cents").notNull(),
    forecastAmountCents: integer("forecast_amount_cents"),
    triggeredAt: timestamp("triggered_at").notNull().defaultNow(),
    notifiedAt: timestamp("notified_at"),
  },
  (t) => ({
    onceUnique: uniqueIndex("budget_alert_once_unique").on(
      t.budgetId,
      t.month,
      t.thresholdType,
      t.thresholdPercent,
    ),
    orgIdx: index("budget_alert_events_org_idx").on(t.organizationId),
  }),
);

/**
 * Org-level change freeze windows. While a freeze is in effect (active, started,
 * and not yet past `endsAt`), destructive mutations — resource deletion,
 * destructive plugin actions, secret-version destroys, deployment rollbacks —
 * are refused with a 423 unless the caller holds `freezes:override` and
 * explicitly opts in. Both blocks and overrides land in `audit_logs`.
 */
export const changeFreezes = pgTable(
  "change_freezes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    reason: text("reason"),
    startsAt: timestamp("starts_at").notNull().defaultNow(),
    /** Null = open-ended; the freeze holds until someone ends it. */
    endsAt: timestamp("ends_at"),
    /** Cleared when the freeze is ended early (or deleted logically). */
    active: boolean("active").notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    endedByUserId: text("ended_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("change_freezes_org_idx").on(t.organizationId),
    orgActiveIdx: index("change_freezes_org_active_idx").on(t.organizationId, t.active),
  }),
);

/**
 * Org tag policy: the required tag keys (optionally with allowed values) every
 * resource should carry, and whether resource creation through the app is
 * refused when they are missing. One row per org, the same missing-row-means-
 * defaults protocol as `org_cost_anomaly_settings`. Enforcement mirrors the
 * change-freeze pattern: blocked creates get a 422 with code
 * `tag_policy_unmet`, overridable via the `x-tag-policy-override` header by
 * callers holding `tag-policy:override`; blocks and overrides land in
 * `audit_logs`.
 */
export const orgTagPolicies = pgTable("org_tag_policies", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** `[{ key, allowedValues? }]` — see `RequiredTag` in client-core. */
  requiredTags: jsonb("required_tags")
    .$type<Array<{ key: string; allowedValues?: string[] | undefined }>>()
    .notNull()
    .default([]),
  enforceOnCreate: boolean("enforce_on_create").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Named cost centres spend is allocated to for showback ("Platform", "Data",
 * "Growth"…). Purely org-defined labels — the mapping from spend to centre is
 * the allocation rules table below.
 */
export const costCentres = pgTable(
  "cost_centres",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_centres_org_idx").on(t.organizationId),
  }),
);

/**
 * Ordered rules mapping cost rows to cost centres. `match` is an AND of the
 * fields it sets (tag key/value, account, provider, service); a rule with an
 * empty match is a catch-all. Evaluation is first-match-wins by ascending
 * `priority` — the showback reader compiles the ordered list into one
 * ClickHouse `multiIf` over `cost_daily`, so rows no rule claims fall into the
 * synthetic "Unallocated" bucket rather than disappearing.
 */
export const costAllocationRules = pgTable(
  "cost_allocation_rules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    costCentreId: text("cost_centre_id")
      .notNull()
      .references(() => costCentres.id, { onDelete: "cascade" }),
    /** Lower fires first; first matching rule wins. */
    priority: integer("priority").notNull().default(0),
    match: jsonb("match")
      .$type<{
        tagKey?: string | undefined;
        tagValue?: string | undefined;
        accountId?: string | undefined;
        pluginId?: string | undefined;
        service?: string | undefined;
      }>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_allocation_rules_org_idx").on(t.organizationId),
    centreIdx: index("cost_allocation_rules_centre_idx").on(t.costCentreId),
  }),
);

/**
 * Detected spend anomalies: a day whose spend for one (dimension, key) —
 * a provider or a service — cleared the trailing-window statistical threshold,
 * or where a key with no prior spend at all started costing money (see
 * `cost/anomaly-detect.ts`). The unique index makes each (org, day,
 * dimension, key, currency) fire at most once no matter how many cost passes
 * re-run that day: evaluation inserts with `onConflictDoNothing` and only a
 * fresh insert can notify. `notifiedAt` stays null when delivery failed or the
 * anomaly was suppressed by the cross-day cooldown.
 *
 * `kind` is deliberately *not* part of the unique index. The two detections
 * are mutually exclusive for a (day, key) — a key with a baseline worth a
 * sigma bar is not a new source, and one without cannot clear a sigma bar —
 * so adding it would only let the same day be reported twice under two names,
 * which is exactly what the cooldown and the dedup index exist to prevent.
 */
export const costAnomalies = pgTable(
  "cost_anomalies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The anomalous day, "YYYY-MM-DD" (UTC). */
    day: text("day").notNull(),
    /**
     * Which detection produced the row. Defaults to `spike` so rows written
     * before new-source detection existed keep their original meaning.
     */
    kind: text("kind").$type<"spike" | "new_source">().notNull().default("spike"),
    /** Which breakdown flagged it. */
    dimension: text("dimension").$type<"provider" | "service">().notNull(),
    /** The dimension's value — a plugin id or a service name. */
    dimensionKey: text("dimension_key").notNull(),
    currency: text("currency").notNull(),
    actualAmountCents: integer("actual_amount_cents").notNull(),
    /** Trailing-window mean, in cents. ~0 for a `new_source`. */
    baselineAmountCents: integer("baseline_amount_cents").notNull(),
    /**
     * The bar the day cleared, in cents: mean + N·stddev for a `spike`, the
     * new-source floor for a `new_source`.
     */
    thresholdAmountCents: integer("threshold_amount_cents").notNull(),
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    notifiedAt: timestamp("notified_at"),
    /**
     * Root-cause hints computed when the anomaly first fired: a small ranked
     * list of human-readable facts from the change timeline and audit log for
     * the anomalous day and the day before ("12 gce-instance resources
     * appeared", "Astrid ran workflow \"Nightly rebuild\"") — see
     * `cost/anomaly-hints.ts`. Null for rows written before hints existed and
     * for passes where the hint queries failed; capped at three entries.
     */
    hints: jsonb("hints").$type<string[]>(),
  },
  (t) => ({
    onceUnique: uniqueIndex("cost_anomalies_once_unique").on(
      t.organizationId,
      t.day,
      t.dimension,
      t.dimensionKey,
      t.currency,
    ),
    orgDayIdx: index("cost_anomalies_org_day_idx").on(t.organizationId, t.day),
  }),
);

/**
 * Metric threshold alert rules — "CPU > 90% for 15 minutes on these
 * resources". Resources are selected by *query* (plugin + resource type +
 * tag), never by id list, so a rule automatically covers resources created
 * after it was written; the selector is resolved against the live `resources`
 * table on every evaluation pass (`server-core/src/metric-alerts/`).
 *
 * `nextEvalAt` is the due-time column AND the claim lease, exactly like
 * `accounts.next_poll_at`: the poller claims due rules with
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` writing
 * `now() + lease` into it, so N replicas never double-evaluate, and the
 * normal completion path overwrites the lease with the true next cadence.
 */
export const metricAlertRules = pgTable(
  "metric_alert_rules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Selector: null means "any plugin". */
    pluginId: text("plugin_id"),
    /** Selector: null means "any resource type". Only meaningful with pluginId. */
    resourceTypeId: text("resource_type_id"),
    /** Selector: tag key the resource must carry (matched case-insensitively). */
    tagKey: text("tag_key"),
    /** Selector: exact value `tagKey` must have; null means "any value". */
    tagValue: text("tag_value"),
    /** The metric series label as written to ClickHouse (e.g. "CPU %"). */
    metricKey: text("metric_key").notNull(),
    comparator: text("comparator").$type<">" | ">=" | "<" | "<=">().notNull(),
    threshold: doublePrecision("threshold").notNull(),
    /** Trailing window the condition must hold for before the rule fires. */
    forMinutes: integer("for_minutes").notNull().default(15),
    /**
     * Least minutes between notified firings for one (rule, resource) — the
     * flap suppressor. Follows the anomaly cooldown convention: a firing
     * inside the cooldown is still recorded, just not notified.
     */
    cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    /** Due time + claim lease; null means "due now" (fresh rules evaluate promptly). */
    nextEvalAt: timestamp("next_eval_at"),
    lastEvalAt: timestamp("last_eval_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("metric_alert_rules_org_idx").on(t.organizationId),
    dueIdx: index("metric_alert_rules_due_idx").on(t.nextEvalAt),
    forMinutesPositive: check("metric_alert_rules_for_minutes_positive", sql`${t.forMinutes} > 0`),
    cooldownNonNegative: check(
      "metric_alert_rules_cooldown_non_negative",
      sql`${t.cooldownMinutes} >= 0`,
    ),
  }),
);

/**
 * Firing state and history for metric alert rules — one row per continuous
 * breach of one rule on one resource. The partial unique index on
 * (ruleId, resourceId) WHERE status = 'firing' is the claim, mirroring
 * `paging_incidents_open_unique`: the replica whose `onConflictDoNothing`
 * insert lands owns opening (and notifying) the incident, and a firing stays
 * open until an evaluation observes the condition clear, which flips it to
 * `resolved` and sends the recovery notification.
 *
 * `resourceId` is deliberately not a FK (the `resource_changes` stance):
 * resource rows are churned by sync, and the history must keep rendering for
 * resources that disappeared upstream. `notifiedAt` stays null when delivery
 * failed or the firing was suppressed by the rule's cooldown.
 *
 * Rules only ever soft-delete (`deletedAt`), so `ruleId`'s FK is `restrict`
 * rather than `cascade`: history is an audit surface, and a stray hard delete
 * of a rule must fail loudly instead of silently erasing its firings.
 * `ruleName` is denormalized at firing time for the same reason
 * `resourceName` is — the event renders on its own, whatever happens to the
 * rule row later.
 */
export const metricAlertEvents = pgTable(
  "metric_alert_events",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => metricAlertRules.id, { onDelete: "restrict" }),
    /** The rule's name when the firing opened, snapshotted (see above). */
    ruleName: text("rule_name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    /** Denormalized so resolved firings still render after resource churn. */
    resourceName: text("resource_name").notNull(),
    status: text("status").$type<"firing" | "resolved">().notNull().default("firing"),
    /** Worst sample observed in the breaching window, in the metric's unit. */
    observedValue: doublePrecision("observed_value").notNull(),
    firedAt: timestamp("fired_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    /** When the firing notification was delivered; null = suppressed or failed. */
    notifiedAt: timestamp("notified_at"),
    /** When the recovery notification was delivered. */
    resolvedNotifiedAt: timestamp("resolved_notified_at"),
  },
  (t) => ({
    openUnique: uniqueIndex("metric_alert_events_open_unique")
      .on(t.ruleId, t.resourceId)
      .where(sql`status = 'firing'`),
    ruleFiredIdx: index("metric_alert_events_rule_fired_idx").on(t.ruleId, t.firedAt),
    orgFiredIdx: index("metric_alert_events_org_fired_idx").on(t.organizationId, t.firedAt),
  }),
);

/**
 * Synthetic HTTP probes — "is this endpoint up, and how fast?" checks run on
 * an interval from the egress-proxy Cloudflare Worker, i.e. from *outside* the
 * cluster, so a probe measures what a user on the internet would see rather
 * than pod-to-pod latency. Results land in ClickHouse as ordinary metric
 * points (`resource_id = "probe:<id>"`, series "Latency"/"Up"), which is what
 * lets the existing metric readers and chart components render them unchanged.
 *
 * `nextProbeAt` is the due-time column AND the claim lease, exactly like
 * `metric_alert_rules.next_eval_at`: the poller claims due probes with
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` writing
 * `now() + interval` into it, so N replicas never double-probe. Null means
 * "due now" — fresh probes fire promptly.
 *
 * The linked resource identity (`accountId`/`resourceId`/`pluginId`/
 * `resourceTypeId`/`outputKey`) remembers which resource output suggested the
 * URL. `resourceId` is deliberately not a FK (the `resource_changes` stance):
 * resource rows are churned by sync, and a probe must keep running for an
 * endpoint whose resource row disappeared upstream.
 *
 * State machine: every failed probe increments `consecutiveFailures`; reaching
 * `failureThreshold` flips `status` to "down" and notifies (`probeAlerts`
 * trigger); any success resets the counter and flips back to "up", notifying
 * only if the probe was previously "down".
 */
export const syntheticProbes = pgTable(
  "synthetic_probes",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method").notNull().default("GET"),
    /** Seconds between probes; floored at 60 (see `PROBE_LIMITS`). */
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    timeoutMs: integer("timeout_ms").notNull().default(10_000),
    /** Consecutive failures before the probe flips to "down" and notifies. */
    failureThreshold: integer("failure_threshold").notNull().default(3),
    enabled: boolean("enabled").notNull().default(true),
    /** Linked resource identity — which output suggested the URL. All nullable. */
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    /** Not a FK — see above. */
    resourceId: text("resource_id"),
    pluginId: text("plugin_id"),
    resourceTypeId: text("resource_type_id"),
    /** The output/field key the URL was suggested from (e.g. "endpoint"). */
    outputKey: text("output_key"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    status: text("status").$type<"up" | "down" | "unknown">().notNull().default("unknown"),
    lastProbeAt: timestamp("last_probe_at"),
    /** Due time + claim lease; null means "due now". */
    nextProbeAt: timestamp("next_probe_at"),
    lastStatusCode: integer("last_status_code"),
    lastLatencyMs: integer("last_latency_ms"),
    /** Failure detail for the last failed probe; null after a success. */
    lastError: text("last_error"),
    /** When `status` last flipped up↔down — "down for 23 minutes" rendering. */
    lastStateChangeAt: timestamp("last_state_change_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("synthetic_probes_org_idx").on(t.organizationId),
    dueIdx: index("synthetic_probes_due_idx").on(t.nextProbeAt),
    intervalMin: check("synthetic_probes_interval_min", sql`${t.intervalSeconds} >= 60`),
    timeoutPositive: check("synthetic_probes_timeout_positive", sql`${t.timeoutMs} > 0`),
    thresholdPositive: check("synthetic_probes_threshold_positive", sql`${t.failureThreshold} > 0`),
  }),
);

export const sshKeys = pgTable(
  "ssh_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Owner of this key — only the owner can manage it */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** AES-256-GCM encrypted public key */
    encryptedPublicKey: text("encrypted_public_key").notNull(),
    publicKeyIv: text("public_key_iv").notNull(),
    /** AES-256-GCM encrypted private key (server-generated keys only) */
    encryptedPrivateKey: text("encrypted_private_key"),
    privateKeyIv: text("private_key_iv"),
    /** e.g. "ssh-ed25519" */
    keyType: text("key_type"),
    /** Whether the key was imported (true) or server-generated (false) */
    isImported: boolean("is_imported").notNull().default(false),
    /** SHA-256 fingerprint of the public key (for display/verification) */
    fingerprint: text("fingerprint"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("ssh_keys_org_idx").on(t.organizationId),
    userIdx: index("ssh_keys_user_idx").on(t.userId),
    userNameUnique: uniqueIndex("ssh_keys_user_name_unique").on(t.userId, t.name),
  }),
);

/**
 * Saved fan-out SSH command snippets — org-shared, so the whole team reuses
 * the same "check kernel", "disk usage" one-liners from the fan-out screen,
 * the desktop app, and the CLI. Commands are not secret (they run over hosts
 * the org already administers), so they are stored in plaintext.
 */
export const sshSnippets = pgTable(
  "ssh_snippets",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    command: text("command").notNull(),
    description: text("description"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("ssh_snippets_org_idx").on(t.organizationId),
    orgNameUnique: uniqueIndex("ssh_snippets_org_name_unique").on(t.organizationId, t.name),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
    action: text("action").notNull(), // e.g. "account.create", "resource.delete"
    entityType: text("entity_type").notNull(), // "account" | "resource" | "dashboard" | ...
    entityId: text("entity_id").notNull(),
    metadata: jsonb("metadata"), // action-specific payload
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt),
    orgEntityTypeIdx: index("audit_logs_org_entity_type_idx").on(t.organizationId, t.entityType),
  }),
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hashedKey: text("hashed_key").notNull(), // SHA-256 of full key
    prefix: text("prefix").notNull(), // first 8 chars for display (e.g. "iwk_abc1")
    scopes: jsonb("scopes").notNull(), // string[] of granted scopes
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    /**
     * For keys still on the legacy SHA-256 hash scheme, the cutover date past
     * which authentication is refused. Set on first legacy-hash auth hit;
     * cleared once the row has been rehashed with HMAC.
     */
    legacyHashSunsetAt: timestamp("legacy_hash_sunset_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    hashedKeyUnique: uniqueIndex("api_keys_hashed_key_unique").on(t.hashedKey),
    orgIdx: index("api_keys_org_idx").on(t.organizationId),
  }),
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    /** "active" | "past_due" | "canceled" | "unpaid" | "trialing" */
    status: text("status").notNull().default("trialing"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    seatCount: integer("seat_count").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgUnique: uniqueIndex("subscriptions_org_unique").on(t.organizationId),
    stripeCustomerIdx: index("subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
    stripeSubIdx: index("subscriptions_stripe_sub_idx").on(t.stripeSubscriptionId),
  }),
);

/**
 * Prepaid seat capacity, bought outright for a fixed term instead of rented by
 * the month.
 *
 * One row per completed one-time Stripe payment, not per seat: a purchase of
 * three slots is one row with `quantity` 3, because they were paid for together
 * and therefore expire together. Rows are additive and never mutated by seat
 * accounting — capacity is a `sum(quantity)` over the rows that are still
 * `active` and not yet past `expiresAt`, so an expiring term needs no sweep job
 * to take effect.
 *
 * Unlike `subscriptions` there is no unique index on the organization: an org
 * accumulates slots, and each purchase carries its own term.
 */
export const capacitySlots = pgTable(
  "capacity_slots",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Seats this purchase grants for the whole of its term. */
    quantity: integer("quantity").notNull().default(1),
    /**
     * "active" | "refunded". A refunded slot stops granting capacity
     * immediately; the row is kept so the purchase history stays honest.
     */
    status: text("status").notNull().default("active"),
    /**
     * The Checkout Session that paid for it. Unique, and that is what makes the
     * webhook idempotent — Stripe redelivers events, and without this a retry
     * would grant the same seats twice.
     */
    stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    /** What was actually charged, in cents, for the purchase-history line. */
    amountPaidCents: integer("amount_paid_cents"),
    /** Term length as sold, recorded per row so changing the offer is safe. */
    termMonths: integer("term_months").notNull(),
    startsAt: timestamp("starts_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    sessionUnique: uniqueIndex("capacity_slots_session_unique").on(t.stripeCheckoutSessionId),
    orgIdx: index("capacity_slots_org_idx").on(t.organizationId),
    paymentIntentIdx: index("capacity_slots_payment_intent_idx").on(t.stripePaymentIntentId),
  }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    /** Legacy text role; superseded by roleId. Kept for one release for fallback. */
    role: text("role").notNull().default("member"), // "admin" | "member"
    roleId: text("role_id").references(() => roles.id, { onDelete: "set null" }),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 hash of the invitation token. Lookups are performed on this. */
    hashedToken: text("hashed_token").notNull(),
    acceptedAt: timestamp("accepted_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    hashedTokenUnique: uniqueIndex("invitations_hashed_token_unique").on(t.hashedToken),
    orgIdx: index("invitations_org_idx").on(t.organizationId),
    emailOrgIdx: index("invitations_email_org_idx").on(t.email, t.organizationId),
  }),
);

export const sshHostKeys = pgTable(
  "ssh_host_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    /** SHA-256 fingerprint of the host key, "SHA256:..." format */
    fingerprint: text("fingerprint").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgHostPortUnique: uniqueIndex("ssh_host_keys_org_host_port_unique").on(
      t.organizationId,
      t.host,
      t.port,
    ),
  }),
);

export const twilioSettings = pgTable(
  "twilio_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** AES-256-GCM encrypted Twilio Account SID. AAD: `twilio:<orgId>:accountSid`. */
    encryptedAccountSid: text("encrypted_account_sid"),
    accountSidIv: text("account_sid_iv"),
    /** AES-256-GCM encrypted Twilio auth token. AAD: `twilio:<orgId>:authToken`. */
    encryptedAuthToken: text("encrypted_auth_token"),
    authTokenIv: text("auth_token_iv"),
    /** E.164 number messages/calls originate from (Twilio number). */
    fromNumber: text("from_number"),
    /** Page after this many distinct sync failures in `windowMinutes`. */
    failureThreshold: integer("failure_threshold").notNull().default(3),
    windowMinutes: integer("window_minutes").notNull().default(10),
    /** Minimum minutes between re-pages for the same open incident. */
    cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    failureThresholdPositive: check(
      "twilio_settings_failure_threshold_positive",
      sql`${t.failureThreshold} > 0`,
    ),
    windowMinutesPositive: check(
      "twilio_settings_window_minutes_positive",
      sql`${t.windowMinutes} > 0`,
    ),
    cooldownMinutesPositive: check(
      "twilio_settings_cooldown_minutes_positive",
      sql`${t.cooldownMinutes} > 0`,
    ),
  }),
);

export const twilioRecipients = pgTable(
  "twilio_recipients",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    /** E.164 phone number (e.g. `+15551234567`). */
    phoneNumber: text("phone_number").notNull(),
    sms: boolean("sms").notNull().default(true),
    voice: boolean("voice").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("twilio_recipients_org_idx").on(t.organizationId),
  }),
);

/**
 * A Slack workspace an org has installed the Infrawrench app into, via the
 * "Add to Slack" OAuth flow. Holds the bot token we post as; the token is
 * long-lived (Slack only rotates it when the workspace enables token rotation,
 * which this install does not request).
 *
 * An org may install into more than one workspace, so this is keyed by
 * (org, teamId) rather than by org alone. Uninstalling sets `deletedAt` so the
 * channel rows and their trigger opt-ins survive a re-install.
 */
export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Slack workspace id (`T…`). */
    teamId: text("team_id").notNull(),
    /** Workspace name at install time, for display. */
    teamName: text("team_name"),
    /** The bot user we post as (`U…`), returned by oauth.v2.access. */
    botUserId: text("bot_user_id"),
    /** Space-separated scopes the install was granted, for diagnosing failures. */
    scopes: text("scopes"),
    /** AES-256-GCM encrypted bot token (`xoxb-…`). AAD: `slack:<orgId>:botToken`. */
    encryptedBotToken: text("encrypted_bot_token").notNull(),
    botTokenIv: text("bot_token_iv").notNull(),
    installedByUserId: text("installed_by_user_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("slack_installations_org_idx").on(t.organizationId),
    orgTeamUnique: uniqueIndex("slack_installations_org_team_unique").on(
      t.organizationId,
      t.teamId,
    ),
  }),
);

/**
 * A Slack channel an org routes alerts to, with one opt-in per trigger. The
 * three flags mirror `pushPreferences` so a channel can take budget alerts
 * without also taking every sync incident.
 */
export const slackChannels = pgTable(
  "slack_channels",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => slackInstallations.id, { onDelete: "cascade" }),
    /** Slack channel id (`C…`/`G…`). Stable across renames, unlike the name. */
    channelId: text("channel_id").notNull(),
    /** Channel name at the time it was added, refreshed when we list channels. */
    channelName: text("channel_name").notNull(),
    isPrivate: boolean("is_private").notNull().default(false),
    syncIncidents: boolean("sync_incidents").notNull().default(true),
    budgetAlerts: boolean("budget_alerts").notNull().default(true),
    /** Statistical spend-spike alerts (see `cost/anomaly-eval.ts`). */
    anomalyAlerts: boolean("anomaly_alerts").notNull().default(true),
    /** Metric threshold rule firings/recoveries (see `metric-alerts/eval.ts`). */
    metricAlerts: boolean("metric_alerts").notNull().default(true),
    /**
     * Batched resource-drift digests (see `drift/alerts.ts`). The one trigger
     * that defaults **off**: drift is continuous and high-volume where the
     * other alerts are exceptional, so shipping it default-on would start
     * posting into every channel an org already connected.
     */
    resourceDrift: boolean("resource_drift").notNull().default(false),
    /** Alerts raised by a workflow calling `infra.page(...)`. */
    workflowPages: boolean("workflow_pages").notNull().default(true),
    /** Provider status-page incidents overlapping the org's resources. */
    providerIncidents: boolean("provider_incidents").notNull().default(true),
    /** Approaching deadlines on synced resources (see `expiry/alerts.ts`). */
    expiryAlerts: boolean("expiry_alerts").notNull().default(true),
    /** Saved log-query matches (see `log-workspaces/pass.ts`). */
    logMatchAlerts: boolean("log_match_alerts").notNull().default(true),
    /** Critical/high security posture findings (see `posture/alerts.ts`). */
    postureAlerts: boolean("posture_alerts").notNull().default(true),
    /** Synthetic probe down/recovered transitions (see `probes/pass.ts`). */
    probeAlerts: boolean("probe_alerts").notNull().default(true),
    /**
     * The Monday-morning weekly summary. Channel opt-in defaults on like the
     * other triggers, but nothing sends until the org enables the digest in
     * `org_digest_settings`.
     */
    weeklyDigest: boolean("weekly_digest").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("slack_channels_org_idx").on(t.organizationId),
    installChannelUnique: uniqueIndex("slack_channels_install_channel_unique").on(
      t.installationId,
      t.channelId,
    ),
  }),
);

/**
 * Slack identity ↔ org member mapping, created by the signed link flow
 * (`GET /api/slack/link`). Inbound Slack requests (slash commands, approval
 * buttons) carry only a Slack `user_id`; nothing is honoured until that id
 * resolves through this table to a member of the org, so the row is the whole
 * trust boundary for two-way Slack.
 *
 * Keyed per (org, workspace, Slack user): one Slack account maps to exactly
 * one Infrawrench account within an org, and re-linking overwrites — the link
 * token proves control of the Slack account, the session proves the
 * Infrawrench one, so whoever holds both decides the pairing.
 */
export const slackUserLinks = pgTable(
  "slack_user_links",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Slack workspace id (`T…`) the link was made from. */
    teamId: text("team_id").notNull(),
    /** Slack user id (`U…`/`W…`). */
    slackUserId: text("slack_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgTeamSlackUnique: uniqueIndex("slack_user_links_org_team_slack_unique").on(
      t.organizationId,
      t.teamId,
      t.slackUserId,
    ),
    teamUserIdx: index("slack_user_links_team_user_idx").on(t.teamId, t.slackUserId),
    orgIdx: index("slack_user_links_org_idx").on(t.organizationId),
  }),
);

/**
 * Where an approval request's interactive Slack message landed, so a decision
 * — from a Slack button or the web UI — can update every copy in place and
 * thread the outcome under it. One row per (approval, channel) message.
 *
 * `approvalId` is deliberately not a FK: it points at `workflow_approvals` for
 * kind "workflow" and `chat_pending_actions` for kind "chat", and a stale row
 * is harmless (the update loop just no-ops when the message is gone).
 */
export const slackApprovalMessages = pgTable(
  "slack_approval_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** "workflow" (workflow_approvals) | "chat" (chat_pending_actions). */
    kind: text("kind").$type<"workflow" | "chat">().notNull(),
    approvalId: text("approval_id").notNull(),
    installationId: text("installation_id")
      .notNull()
      .references(() => slackInstallations.id, { onDelete: "cascade" }),
    /** Slack channel id (`C…`/`G…`) the message was posted to. */
    channelId: text("channel_id").notNull(),
    /** Slack message timestamp — the id `chat.update` and threads key on. */
    messageTs: text("message_ts").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    approvalIdx: index("slack_approval_messages_approval_idx").on(t.kind, t.approvalId),
    orgIdx: index("slack_approval_messages_org_idx").on(t.organizationId),
  }),
);

/**
 * A Microsoft Teams channel an org routes alerts to, identified by the webhook
 * URL of a Teams "Workflows" automation (or a legacy Office 365 connector).
 * The three flags mirror `slackChannels` and `pushPreferences`.
 *
 * There is no installation table above this one, as there is for Slack: Teams
 * has no app-only OAuth flow we can use, so each channel stands alone with its
 * own URL. See `server-core/src/msteams.ts` for why.
 *
 * The URL is a bearer credential — it carries its own signature — so it is
 * stored encrypted and never leaves the server. `urlHost` and `urlHint` are the
 * non-secret parts kept in the clear for display and diagnostics.
 */
export const msteamsWebhooks = pgTable(
  "msteams_webhooks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** User-supplied display name, e.g. `#alerts (Platform)`. */
    label: text("label").notNull(),
    /** AES-256-GCM encrypted webhook URL. AAD: `msteams:<orgId>:webhookUrl`. */
    encryptedUrl: text("encrypted_url").notNull(),
    urlIv: text("url_iv").notNull(),
    /**
     * Keyed HMAC of the URL. Lets re-pasting the same webhook update the
     * existing row instead of doubling up delivery, without storing the URL in
     * a comparable form.
     */
    urlDigest: text("url_digest").notNull(),
    /** Hostname, for display and for spotting legacy connector URLs. */
    urlHost: text("url_host").notNull(),
    /** Non-secret display hint, e.g. `contoso.webhook.office.com · …a7f2`. */
    urlHint: text("url_hint").notNull(),
    syncIncidents: boolean("sync_incidents").notNull().default(true),
    budgetAlerts: boolean("budget_alerts").notNull().default(true),
    /** Statistical spend-spike alerts (see `cost/anomaly-eval.ts`). */
    anomalyAlerts: boolean("anomaly_alerts").notNull().default(true),
    /** Metric threshold rule firings/recoveries (see `metric-alerts/eval.ts`). */
    metricAlerts: boolean("metric_alerts").notNull().default(true),
    /** Batched resource-drift digests. Defaults off — see `slackChannels`. */
    resourceDrift: boolean("resource_drift").notNull().default(false),
    /** Alerts raised by a workflow calling `infra.page(...)`. */
    workflowPages: boolean("workflow_pages").notNull().default(true),
    /** Provider status-page incidents overlapping the org's resources. */
    providerIncidents: boolean("provider_incidents").notNull().default(true),
    /** Approaching deadlines on synced resources (see `expiry/alerts.ts`). */
    expiryAlerts: boolean("expiry_alerts").notNull().default(true),
    /** Saved log-query matches (see `log-workspaces/pass.ts`). */
    logMatchAlerts: boolean("log_match_alerts").notNull().default(true),
    /** Critical/high security posture findings (see `posture/alerts.ts`). */
    postureAlerts: boolean("posture_alerts").notNull().default(true),
    /** Synthetic probe down/recovered transitions (see `probes/pass.ts`). */
    probeAlerts: boolean("probe_alerts").notNull().default(true),
    /**
     * The Monday-morning weekly summary. Channel opt-in defaults on like the
     * other triggers, but nothing sends until the org enables the digest in
     * `org_digest_settings`.
     */
    weeklyDigest: boolean("weekly_digest").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("msteams_webhooks_org_idx").on(t.organizationId),
    orgDigestUnique: uniqueIndex("msteams_webhooks_org_digest_unique").on(
      t.organizationId,
      t.urlDigest,
    ),
  }),
);

/**
 * Per-org weekly-digest settings, schedule, and delivery bookkeeping. One row
 * per org that has ever touched the feature; no row means disabled.
 *
 * `lastSentWeekStart` is the Monday (ISO `YYYY-MM-DD`) of the week the last
 * digest *covered*, not the day it was sent, and it is expressed in the org's
 * own `timezone` — the window is the org's local Monday-to-Sunday calendar
 * week. The scheduler claims due orgs with a single conditional UPDATE on this
 * column, so any number of poller replicas — or a restart mid-morning — can
 * never double-send: only the instance whose UPDATE actually moved the column
 * forward delivers. The column only ever moves *forward*, which is what makes
 * the invariant hold even when an org changes its timezone.
 *
 * The retry columns are deliberately separate state rather than a rollback of
 * the claim: reverting `lastSentWeekStart` would let two replicas race back
 * into the same slot. `nextAttemptAt` is its own claimable gate (the retry
 * UPDATE nulls it in the same statement), `attemptCount` bounds the retries,
 * and `lastStatus`/`lastError` give the settings UI something to show so a
 * failing digest is never silent.
 */
export const orgDigestSettings = pgTable("org_digest_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  /** Monday (ISO day, in `timezone`) of the last week a digest was claimed for. */
  lastSentWeekStart: text("last_sent_week_start"),
  /** When a digest last actually went out. Null while only failures have happened. */
  lastSentAt: timestamp("last_sent_at"),
  /**
   * IANA zone the schedule and the week boundary are expressed in, e.g.
   * `Europe/Berlin`. `UTC` preserves the original behaviour for every org that
   * predates the column. Validated server-side against `Intl`.
   */
  timezone: text("timezone").notNull().default("UTC"),
  /** ISO day of week the digest fires on: 1 = Monday … 7 = Sunday. */
  sendDay: integer("send_day").notNull().default(1),
  /** Local hour (0–23) in `timezone` the digest fires at. */
  sendHour: integer("send_hour").notNull().default(7),
  /** Opt-in AI-written summary paragraph above the deterministic content. */
  narrativeEnabled: boolean("narrative_enabled").notNull().default(false),
  /** Attempts made for `lastSentWeekStart`'s window, including the first. */
  attemptCount: integer("attempt_count").notNull().default(0),
  /** When the last attempt (successful or not) ran. */
  lastAttemptAt: timestamp("last_attempt_at"),
  /** `pending` | `succeeded` | `partial` | `failed` | `no_targets`. */
  lastStatus: text("last_status"),
  /** Human-readable reason for the last non-success, for the settings UI. */
  lastError: text("last_error"),
  /**
   * Retry gate. Set only after a *total* delivery failure and only while
   * attempts remain; the retry claim clears it, so concurrent replicas cannot
   * both pick the same retry up.
   */
  nextAttemptAt: timestamp("next_attempt_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Email addresses an org routes its weekly digest to — the third digest
 * transport alongside Slack channels and Teams webhooks.
 *
 * Recipients are an **org-level address list**, not a per-member opt-in, for
 * the same reason `slack_channels` and `msteams_webhooks` are: the digest is a
 * `ChannelTrigger`, a scheduled summary sent to a destination an admin picked,
 * not a per-user alert. An address list also reaches a finance alias or an
 * exec who has no Infrawrench login, which a member opt-in never could.
 * `push_preferences` stays the precedent for the four *alert* triggers only.
 */
export const digestEmailRecipients = pgTable(
  "digest_email_recipients",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Stored lowercased so the unique index also dedupes case variants. */
    email: text("email").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("digest_email_recipients_org_idx").on(t.organizationId),
    orgEmailUnique: uniqueIndex("digest_email_recipients_org_email_unique").on(
      t.organizationId,
      t.email,
    ),
  }),
);

/**
 * Per-org tuning for cost anomaly detection. One row per org that has ever
 * changed a knob; no row means the shipped defaults, the same way
 * `org_digest_settings` treats a missing row as disabled.
 *
 * Money is stored in USD cents and converted per series by
 * `cost/anomaly-detect.ts`, so one number means the same real amount against a
 * provider that bills in dollars and one that bills in yen. The values are
 * bounded by the API (`COST_ANOMALY_LIMITS`) — a sigma of 0 would alert on
 * every fluctuation and a negative floor is meaningless — so nothing here can
 * store a setting that turns detection into a pager storm.
 *
 * The last two columns are the Twilio half, and they are a pair: `sms_alerts`
 * is the opt-in (default `'off'`, because every org that already has Twilio set
 * up for budgets would otherwise start getting anomaly texts), and
 * `sms_last_paged_at` is the *claim* that bounds their rate, in the same
 * protocol `org_drift_alert_settings.last_notified_at` uses — one conditional
 * UPDATE, whoever wins it sends, rolled back when the text reached nobody.
 */
export const orgCostAnomalySettings = pgTable("org_cost_anomaly_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Standard deviations above the trailing mean that count as a spike. */
  sigmas: doublePrecision("sigmas").notNull().default(3),
  /** Minimum rise over the baseline before a spike alerts, in USD cents. */
  minDeltaCents: integer("min_delta_cents").notNull().default(1000),
  /** Minimum first-day spend before a new spend source alerts, in USD cents. */
  newSourceMinCents: integer("new_source_min_cents").notNull().default(2500),
  /**
   * Which anomaly kinds also text the org's Twilio recipients:
   * `'off'` (default) | `'new_source'` | `'all'`. Nested rather than two
   * booleans — see `CostAnomalySmsMode` in `client-core/src/costs.ts`.
   */
  smsAlerts: text("sms_alerts", { enum: ["off", "new_source", "all"] })
    .notNull()
    .default("off"),
  /**
   * When the org last sent an anomaly SMS. A claim, not bookkeeping: the send
   * is gated on one conditional UPDATE of this column, so two poller replicas
   * evaluating the same org produce one text.
   */
  smsLastPagedAt: timestamp("sms_last_paged_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Per-org filtering and throttling for resource-drift alerts, plus the claim
 * column that makes the throttle exactly-once across poller replicas. One row
 * per org that has either tuned the settings or been alerted; no row means the
 * shipped defaults.
 *
 * Drift is the highest-volume signal in the product — a single sync pass can
 * record hundreds of `resource_changes` rows — so this table exists to make the
 * *notification* rate independent of the change rate:
 *
 * - `lastNotifiedAt` is a claim, not bookkeeping. `drift/alerts.ts` advances it
 *   with one conditional UPDATE (`last_notified_at IS NULL OR <= now -
 *   cooldown`), exactly like `org_digest_settings.last_sent_week_start` and the
 *   `workflow_pages` cooldown row: whoever wins the statement sends, everyone
 *   else is suppressed, so N poller replicas still produce one message. It is
 *   rolled back when every transport reached nobody, so a message no one got
 *   does not start a quiet period.
 * - `notifyUpdated` defaults **off** while created/deleted default on. A
 *   resource appearing or disappearing is news; a field moving is usually the
 *   provider restating a timestamp, and it is the bulk of the volume.
 * - `accountIds` (empty = every account) scopes alerting to the accounts worth
 *   waking up for, and `minChanges` suppresses windows too small to be worth a
 *   message.
 */
export const orgDriftAlertSettings = pgTable("org_drift_alert_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Alert on resources that appeared since the last window. */
  notifyCreated: boolean("notify_created").notNull().default(true),
  /** Alert on field-level updates. Off by default — this is the noisy kind. */
  notifyUpdated: boolean("notify_updated").notNull().default(false),
  /** Alert on resources that disappeared since the last window. */
  notifyDeleted: boolean("notify_deleted").notNull().default(true),
  /** Least time between drift notifications for this org. */
  cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
  /** Fewest matching changes in a window worth notifying about. */
  minChanges: integer("min_changes").notNull().default(1),
  /** Account ids to alert on; an empty array means every account. */
  accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),
  /** The cooldown claim — when this org last had a drift digest delivered. */
  lastNotifiedAt: timestamp("last_notified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Per-org settings and throttle state for expiry-radar alerts, modelled on
 * `org_drift_alert_settings`. One row per org that has either tuned the
 * settings or been through an alert scan; no row means the shipped defaults
 * (enabled, 60-day lead time).
 *
 * `lastNotifiedAt` is a claim, not bookkeeping, and it records the last
 * *completed alert scan*, not necessarily a delivered message: `expiry/alerts.ts`
 * advances it with one conditional upsert (`last_notified_at IS NULL OR
 * <= now - 24h`), exactly like the drift cooldown, so N poller replicas
 * evaluating the same org produce one scan per day. A scan that finds nothing
 * due keeps the window spent — deadlines move by whole days, so re-scanning a
 * quiet org every tick would buy nothing — while a scan whose message reached
 * nobody is rolled back so the next tick can retry.
 */
export const orgExpirySettings = pgTable("org_expiry_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Whether the poller sends expiry alerts for this org at all. */
  enabled: boolean("enabled").notNull().default(true),
  /** Days of lead time before a deadline counts as `upcoming` and alertable. */
  leadDays: integer("lead_days").notNull().default(60),
  /** The cooldown claim — when this org's expiry alert scan last completed. */
  lastNotifiedAt: timestamp("last_notified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Per-org settings and throttle state for posture-check alerts, modelled on
 * `org_expiry_settings` minus the lead time (findings have no clock). One row
 * per org that has either tuned the settings or been through an alert scan;
 * no row means the shipped defaults (enabled).
 *
 * `lastNotifiedAt` is a claim, not bookkeeping, and it records the last
 * *completed alert scan*, not necessarily a delivered message:
 * `posture/alerts.ts` advances it with one conditional upsert
 * (`last_notified_at IS NULL OR <= now - 24h`), exactly like the expiry
 * cooldown, so N poller replicas evaluating the same org produce one scan per
 * day. A scan that finds nothing alertable keeps the window spent, while a
 * scan whose message reached nobody is rolled back so the next tick can
 * retry.
 */
export const orgPostureSettings = pgTable("org_posture_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Whether the poller sends posture alerts for this org at all. */
  enabled: boolean("enabled").notNull().default(true),
  /** The cooldown claim — when this org's posture alert scan last completed. */
  lastNotifiedAt: timestamp("last_notified_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Sleep/wake schedules — "off at 19:00, on at 08:00, Mon–Fri" windows on
 * resources whose plugin declares a `lifecycle` start/stop action pair.
 *
 * `nextTransitionAt` is the due-time column AND the claim lease, exactly like
 * `accounts.next_poll_at`: the poller's schedule pass claims due rows with
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)` writing
 * `now() + lease` into it, so N replicas never double-fire, and the normal
 * completion path overwrites the lease with the true next transition.
 *
 * `lastTransitionKey` (`"<ISO instant>:<stop|start>"`) is the idempotency
 * record: the due transition is recomputed from the timing at claim time, and
 * a key that matches means the transition already ran (or was deliberately
 * skipped for a freeze) — the pass reschedules without re-invoking, so a
 * restart mid-lease can't fire the same window twice.
 *
 * `resourceId` is not a FK (the `resource_changes` stance) — resource rows
 * are churned by sync; cleanup rides the account cascade, and the pass skips
 * schedules whose resource row is gone.
 */
export const resourceSchedules = pgTable(
  "resource_schedules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    /** ISO weekdays 1 (Mon) – 7 (Sun) the resource is worked on. */
    daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull(),
    /** Wall-clock "HH:MM" in `timezone` at which the resource is stopped. */
    stopTime: text("stop_time").notNull(),
    /** Wall-clock "HH:MM" in `timezone` at which the resource is started. */
    startTime: text("start_time").notNull(),
    /** IANA zone the wall-clock times are computed in (DST-safe). */
    timezone: text("timezone").notNull(),
    paused: boolean("paused").notNull().default(false),
    /** Due time + claim lease; null while paused. */
    nextTransitionAt: timestamp("next_transition_at"),
    /** "stop" | "start" — what fires at `nextTransitionAt`. */
    nextTransitionAction: text("next_transition_action").$type<"stop" | "start">(),
    /** Idempotency record of the last executed/skipped transition. */
    lastTransitionKey: text("last_transition_key"),
    lastRunAt: timestamp("last_run_at"),
    lastRunAction: text("last_run_action").$type<"stop" | "start">(),
    /** "ok" | "failed" | "skipped_freeze" — failures are never silent. */
    lastRunStatus: text("last_run_status").$type<"ok" | "failed" | "skipped_freeze">(),
    lastRunError: text("last_run_error"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("resource_schedules_org_idx").on(t.organizationId),
    dueIdx: index("resource_schedules_due_idx").on(t.nextTransitionAt),
    /** One schedule per resource — two windows on one VM would fight. */
    resourceUnique: uniqueIndex("resource_schedules_org_resource_idx").on(
      t.organizationId,
      t.resourceId,
    ),
  }),
);

/**
 * Resource leases (TTL) — an optional "expires at" on any resource ("give me
 * a test cluster for 3 days"). Active leases ride the expiry radar (kind
 * `"lease"`), so the owner is nagged through the existing alert pass; a lease
 * with `autoDelete` additionally opts into the poller's lease pass, which
 * announces the deletion twice and then calls the plugin's `deleteResource`
 * at expiry (freeze-aware — a delete during a change freeze is deferred and
 * surfaced, never silently executed).
 *
 * `nextCheckAt` is the due-time column AND the claim lease for auto-delete
 * leases, the `resource_schedules.next_transition_at` protocol: the pass
 * claims due rows with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP
 * LOCKED)` writing `now() + lease` into it. Null means "due now" — a fresh
 * auto-delete lease is picked up on the next tick, which computes the first
 * warning instant and reschedules. Non-auto-delete leases keep it null and
 * are never claimed (the pass filters on `autoDelete`).
 *
 * `firstWarningAt` / `finalWarningAt` record the two mandatory announcements
 * (null until sent) — the pass never deletes until both are non-null AND the
 * expiry has passed, even when that pushes the delete later.
 *
 * `resourceId` is not a FK (the `resource_schedules` stance) — resource rows
 * are churned by sync; cleanup rides the account cascade. `displayName` is
 * denormalized so completion messages can name the resource after its row is
 * gone.
 */
export const resourceLeases = pgTable(
  "resource_leases",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceId: text("resource_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    /** Resource display name at lease time — survives the resource's deletion. */
    displayName: text("display_name").notNull(),
    /** The lease deadline. */
    expiresAt: timestamp("expires_at").notNull(),
    /** Opt-in: delete the resource at expiry (after two announcements). */
    autoDelete: boolean("auto_delete").notNull().default(false),
    /** Why/who-for, shown on the radar and in the announcements. */
    note: text("note"),
    /** "active" | "deleted" | "failed" | "canceled". */
    status: text("status")
      .$type<"active" | "deleted" | "failed" | "canceled">()
      .notNull()
      .default("active"),
    /** First announcement instant; null until sent. */
    firstWarningAt: timestamp("first_warning_at"),
    /** Final (second) announcement instant; null until sent. */
    finalWarningAt: timestamp("final_warning_at"),
    /** Due time + claim lease for the auto-delete pass; null = due. */
    nextCheckAt: timestamp("next_check_at"),
    deleteAttempts: integer("delete_attempts").notNull().default(0),
    /** Last failure/deferral detail — failures are never silent. */
    lastError: text("last_error"),
    /** When the lease reached a terminal status. */
    completedAt: timestamp("completed_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("resource_leases_org_idx").on(t.organizationId),
    dueIdx: index("resource_leases_due_idx").on(t.nextCheckAt),
    /** One lease per resource — two TTLs on one resource would fight. */
    resourceUnique: uniqueIndex("resource_leases_org_resource_idx").on(
      t.organizationId,
      t.resourceId,
    ),
  }),
);

/**
 * Log workspace saved queries — a named set of log-capable resources plus a
 * search expression, so a multi-resource tail workspace can be reopened.
 *
 * `alertEnabled` opts the query into the poller's log-alert pass:
 * `nextEvalAt` is the due-time column AND the claim lease (the
 * `resource_schedules.next_transition_at` protocol — `UPDATE … WHERE id IN
 * (SELECT … FOR UPDATE SKIP LOCKED)` writes `now() + lease` into it), so N
 * poller replicas never evaluate the same query twice. It is null while the
 * alert is off. `lastAlertedAt` anchors the notification cooldown so a query
 * that keeps matching doesn't re-fire every pass.
 *
 * `resources` is a jsonb array of stream selectors (`LogStreamSelector` in
 * client-core), not FK rows — resource rows are churned by sync (the
 * `resource_changes` stance); the pass and the UI simply report streams whose
 * resource is gone instead of breaking the whole query.
 */
export const logWorkspaceQueries = pgTable(
  "log_workspace_queries",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Stream selectors: {resourceId, accountId, pluginId, resourceTypeId, container?}. */
    resources: jsonb("resources")
      .$type<
        {
          resourceId: string;
          accountId: string;
          pluginId: string;
          resourceTypeId: string;
          container?: string;
        }[]
      >()
      .notNull(),
    /** Search expression (client-core `compileLogSearch` syntax); "" = match all. */
    search: text("search").notNull().default(""),
    alertEnabled: boolean("alert_enabled").notNull().default(false),
    /** Due time + claim lease for the alert pass; null while alerts are off. */
    nextEvalAt: timestamp("next_eval_at"),
    lastEvalAt: timestamp("last_eval_at"),
    /** Last evaluation that found at least one matching line. */
    lastMatchAt: timestamp("last_match_at"),
    /** Last dispatched notification — the cooldown anchor. */
    lastAlertedAt: timestamp("last_alerted_at"),
    /** Failure detail from the last evaluation; never silent. */
    lastEvalError: text("last_eval_error"),
    /** Truncated sample of the most recent matching line. */
    lastMatchSample: text("last_match_sample"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("log_workspace_queries_org_idx").on(t.organizationId),
    dueIdx: index("log_workspace_queries_due_idx").on(t.nextEvalAt),
    /** Names are the reopen handle — duplicates would be ambiguous. */
    nameUnique: uniqueIndex("log_workspace_queries_org_name_idx").on(t.organizationId, t.name),
  }),
);

/**
 * Rolling-window record of poller sync failures, used by the Twilio pager to
 * decide whether a (account, resourceType) has crossed its threshold. Rows
 * older than the org's `windowMinutes` are deleted on each tick.
 */
export const accountSyncFailures = pgTable(
  "account_sync_failures",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceTypeId: text("resource_type_id").notNull(),
    failedAt: timestamp("failed_at").notNull().defaultNow(),
    error: text("error"),
  },
  (t) => ({
    orgAccountTypeIdx: index("account_sync_failures_org_account_type_idx").on(
      t.organizationId,
      t.accountId,
      t.resourceTypeId,
    ),
    failedAtIdx: index("account_sync_failures_failed_at_idx").on(t.failedAt),
  }),
);

/**
 * One row per open or resolved incident. While `closedAt` is null the
 * incident is open; the pager re-pages every `cooldownMinutes` until the next
 * successful sync of the same (account, resourceType) closes it.
 */
export const pagingIncidents = pgTable(
  "paging_incidents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    resourceTypeId: text("resource_type_id").notNull(),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    /** Set when the next successful sync of this (account, type) clears the incident. */
    closedAt: timestamp("closed_at"),
    /** Last time we actually sent SMS/voice for this incident. */
    pagedAt: timestamp("paged_at"),
    /** Truncated error message captured when the incident was opened. */
    error: text("error"),
  },
  (t) => ({
    openIncidentIdx: uniqueIndex("paging_incidents_open_unique")
      .on(t.accountId, t.resourceTypeId)
      .where(sql`closed_at IS NULL`),
    orgIdx: index("paging_incidents_org_idx").on(t.organizationId),
  }),
);

/**
 * Expo push tokens for the mobile app. User-scoped, not org-scoped — a phone
 * belongs to a person and registers once regardless of org memberships. The
 * unique index on the token lets re-registration upsert and reassign the row
 * to the current user (phone handoffs, account switches).
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `ExponentPushToken[...]` string from expo-notifications. */
    expoPushToken: text("expo_push_token").notNull(),
    platform: text("platform").notNull().$type<"ios" | "android">(),
    deviceName: text("device_name"),
    /** Refreshed on every register call — the app re-registers on launch. */
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    /** Consecutive send failures; reset to 0 on success or re-register. */
    failureCount: integer("failure_count").notNull().default(0),
    /** Set after repeated send failures; cleared on re-register. */
    disabledAt: timestamp("disabled_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("push_devices_token_unique").on(t.expoPushToken),
    userIdx: index("push_devices_user_idx").on(t.userId),
  }),
);

/**
 * Per-(user, org) push trigger opt-outs. No row means everything is enabled —
 * registering a device is the opt-in act.
 */
export const pushPreferences = pgTable(
  "push_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    syncIncidents: boolean("sync_incidents").notNull().default(true),
    budgetAlerts: boolean("budget_alerts").notNull().default(true),
    /** Statistical spend-spike alerts (see `cost/anomaly-eval.ts`). */
    anomalyAlerts: boolean("anomaly_alerts").notNull().default(true),
    /** Metric threshold rule firings/recoveries (see `metric-alerts/eval.ts`). */
    metricAlerts: boolean("metric_alerts").notNull().default(true),
    /** Batched resource-drift digests. Defaults off — see `slackChannels`. */
    resourceDrift: boolean("resource_drift").notNull().default(false),
    /** Alerts raised by a workflow calling `infra.page(...)`. */
    workflowPages: boolean("workflow_pages").notNull().default(true),
    /** Provider status-page incidents overlapping the org's resources. */
    providerIncidents: boolean("provider_incidents").notNull().default(true),
    /** Approaching deadlines on synced resources (see `expiry/alerts.ts`). */
    expiryAlerts: boolean("expiry_alerts").notNull().default(true),
    /** Saved log-query matches (see `log-workspaces/pass.ts`). */
    logMatchAlerts: boolean("log_match_alerts").notNull().default(true),
    /** Critical/high security posture findings (see `posture/alerts.ts`). */
    postureAlerts: boolean("posture_alerts").notNull().default(true),
    /** Synthetic probe down/recovered transitions (see `probes/pass.ts`). */
    probeAlerts: boolean("probe_alerts").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    userOrgUnique: uniqueIndex("push_preferences_user_org_unique").on(t.userId, t.organizationId),
    orgIdx: index("push_preferences_org_idx").on(t.organizationId),
  }),
);

export const sshTunnelConfigs = pgTable(
  "ssh_tunnel_configs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sshHost: text("ssh_host").notNull(),
    sshPort: integer("ssh_port").notNull().default(22),
    sshUser: text("ssh_user").notNull().default("root"),
    remoteHost: text("remote_host").notNull().default("127.0.0.1"),
    remotePort: integer("remote_port").notNull(),
    /** AES-256-GCM encrypted SSH private key */
    encryptedPrivateKey: text("encrypted_private_key").notNull(),
    privateKeyIv: text("private_key_iv").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    accountUnique: uniqueIndex("ssh_tunnel_configs_account_unique").on(t.accountId),
    orgIdx: index("ssh_tunnel_configs_org_idx").on(t.organizationId),
  }),
);

/* -------------------------------------------------------------------------- */
/* AI chat — conversations + per-turn messages + pending-action approvals     */
/* + per-turn token usage rolled up for Stripe metered billing.               */
/* -------------------------------------------------------------------------- */

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Nullable, and `set null` rather than `cascade`, so deleting an account
     * retires its conversations instead of destroying them.
     *
     * `chat_usage` rows hang off the messages here and are billing records —
     * `stripe_usage_record_id` stays null until the reporting sweep claims
     * them. Cascading from the user would take unreported usage with it, so an
     * account deleted inside the sweep window silently cost the org its charge.
     *
     * Every read scopes conversations with `userId === auth.userId`, so a
     * null-owned row matches nobody and the history stops being reachable —
     * which is the intent. The usage rows underneath it survive to be billed.
     */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull().default("New chat"),
    /**
     * Must stay in step with `DEFAULT_CHAT_MODEL` in client-core (server-core
     * can't import it — no dependency that way). The API writes the model
     * explicitly, so this is only reached by a caller that forgets; it points
     * at the cheapest model so forgetting is cheap rather than expensive.
     */
    model: text("model").notNull().default("gemini-3.6-flash"),
    /** System prompt override; null means use the default from chat/agent.ts */
    systemPrompt: text("system_prompt"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgUserIdx: index("chat_conversations_org_user_idx").on(t.organizationId, t.userId),
    orgUpdatedIdx: index("chat_conversations_org_updated_idx").on(t.organizationId, t.updatedAt),
  }),
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    /** "user" | "assistant" | "tool" */
    role: text("role").notNull(),
    /**
     * Anthropic-shaped content blocks. For role=user this is the user's text
     * input plus any tool_result blocks returned from the previous turn. For
     * role=assistant it's the text + tool_use blocks the model emitted. Tool
     * results from approved-and-executed tool calls are stored as a follow-on
     * role=user message with tool_result blocks, mirroring the SDK shape.
     */
    content: jsonb("content").notNull(),
    /** Tokens reported by Anthropic for this individual turn (assistant rows only). */
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** Stop reason from the API: "end_turn" | "tool_use" | "max_tokens" | etc. */
    stopReason: text("stop_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    conversationCreatedIdx: index("chat_messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  }),
);

export const chatPendingActions = pgTable(
  "chat_pending_actions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    /** The assistant message that emitted this tool_use block. */
    messageId: text("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    /** Tool call id from the Anthropic SDK (toolu_*). Used to build tool_result. */
    toolUseId: text("tool_use_id").notNull(),
    toolName: text("tool_name").notNull(),
    toolInput: jsonb("tool_input").notNull(),
    /** "pending" | "approved" | "rejected" | "executed" | "errored" */
    status: text("status").notNull().default("pending"),
    /** Tool result text once executed; or rejection reason. */
    result: text("result"),
    isError: boolean("is_error").notNull().default(false),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index("chat_pending_actions_conversation_idx").on(t.conversationId),
    statusIdx: index("chat_pending_actions_status_idx").on(t.status),
  }),
);

export const chatUsage = pgTable(
  "chat_usage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    /** Total billable cost in micro-dollars after markup. */
    costMicros: integer("cost_micros").notNull(),
    /** Stripe usage record id once reported; null until reported. */
    stripeUsageRecordId: text("stripe_usage_record_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("chat_usage_org_created_idx").on(t.organizationId, t.createdAt),
    unreportedIdx: index("chat_usage_unreported_idx").on(t.stripeUsageRecordId),
  }),
);

/**
 * Cooldown rows for pages a server outside Infrawrench raised over
 * `POST /api/org/{orgId}/pages`. The workflow equivalent is `workflow_pages`;
 * these are keyed by a caller-chosen `source` instead of a workflow id, since
 * there is no row in this database to hang them off.
 */
export const externalPages = pgTable(
  "external_pages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Caller-chosen name for the system raising pages, e.g. "checkout-api". */
    source: text("source").notNull(),
    /** The caller-chosen throttle key; "default" when unspecified. */
    key: text("key").notNull(),
    /** When this key last delivered a page — the start of its cooldown. */
    lastPagedAt: timestamp("last_paged_at").notNull().defaultNow(),
    /** The message that was sent, for the settings UI. */
    lastMessage: text("last_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgSourceKeyUnique: uniqueIndex("external_pages_org_source_key_unique").on(
      t.organizationId,
      t.source,
      t.key,
    ),
    orgIdx: index("external_pages_org_idx").on(t.organizationId),
  }),
);

/**
 * Poll bookkeeping for provider status feeds — one row per plugin whose
 * manifest declares `statusFeed`. Global, not org-scoped: a provider's status
 * page is the same for everyone, so the cache is shared and correlation with
 * an org's resources happens at read time.
 *
 * `nextFetchAt` doubles as the claim lease, exactly like `accounts.nextPollAt`:
 * the poller claims due feeds with `UPDATE … WHERE plugin_id IN (SELECT … FOR
 * UPDATE SKIP LOCKED)`, so replicas never fetch the same feed twice in a tick.
 *
 * `lastStatus`/`lastError` exist because poller failures are otherwise
 * invisible: a feed that 500s or changes shape must leave a durable record a
 * UI or operator can read, not just a stdout line.
 */
export const providerStatusFeeds = pgTable(
  "provider_status_feeds",
  {
    pluginId: text("plugin_id").primaryKey(),
    nextFetchAt: timestamp("next_fetch_at"),
    lastFetchedAt: timestamp("last_fetched_at"),
    /** "ok" | "error" — outcome of the most recent fetch+parse attempt. */
    lastStatus: text("last_status"),
    /** Truncated fetch/parse error message from the most recent failure. */
    lastError: text("last_error"),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("provider_status_feeds_due_idx").on(t.nextFetchAt),
  }),
);

/**
 * Cached provider incidents, normalized by each plugin's `parseStatusFeed`.
 * One row per (plugin, provider-native incident id); the poller upserts on
 * every fetch. An incident the feed stops reporting without an explicit
 * `resolvedAt` is closed by the collector (feeds like Statuspage's
 * `unresolved.json` simply drop resolved incidents).
 *
 * `regions` hold plugin-native region ids (the strings plugins write into
 * `fields_json.region`), `resourceTypeIds` plugin resource type ids — the two
 * axes correlation matches on, plus `providerWide`.
 */
export const providerStatusIncidents = pgTable(
  "provider_status_incidents",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    /** Provider-native incident id, stable across polls. */
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    /** "investigating" | "identified" | "monitoring" | "resolved" */
    state: text("state").notNull(),
    /** "maintenance" | "minor" | "major" | "critical" */
    impact: text("impact").notNull(),
    url: text("url"),
    startedAt: timestamp("started_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
    lastUpdateAt: timestamp("last_update_at"),
    lastUpdateText: text("last_update_text"),
    regions: jsonb("regions").$type<string[]>().notNull().default([]),
    services: jsonb("services").$type<string[]>().notNull().default([]),
    resourceTypeIds: jsonb("resource_type_ids").$type<string[]>().notNull().default([]),
    providerWide: boolean("provider_wide").notNull().default(false),
    /** Last poll that still reported this incident — staleness marker. */
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pluginExternalUnique: uniqueIndex("provider_status_incidents_plugin_external_unique").on(
      t.pluginId,
      t.externalId,
    ),
    activeIdx: index("provider_status_incidents_active_idx").on(t.resolvedAt, t.pluginId),
    startedIdx: index("provider_status_incidents_started_idx").on(t.startedAt),
  }),
);

/**
 * Exactly-once bookkeeping for provider-incident notifications: one row per
 * (incident, org) that has been fanned out. The insert is the claim — the
 * replica whose `ON CONFLICT DO NOTHING` insert actually lands owns delivery,
 * mirroring the conditional-UPDATE claims in `drift/alerts.ts`. When no
 * transport delivers, the row is deleted so a later tick can retry
 * (`releaseUnlessDelivered` invariant).
 */
export const providerStatusNotifications = pgTable(
  "provider_status_notifications",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id")
      .notNull()
      .references(() => providerStatusIncidents.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** How many of the org's resources matched at notification time. */
    affectedResourceCount: integer("affected_resource_count").notNull().default(0),
    notifiedAt: timestamp("notified_at").notNull().defaultNow(),
  },
  (t) => ({
    incidentOrgUnique: uniqueIndex("provider_status_notifications_incident_org_unique").on(
      t.incidentId,
      t.organizationId,
    ),
    orgIdx: index("provider_status_notifications_org_idx").on(t.organizationId),
  }),
);

export * from "./core-schema.js";
export * from "./workflow-schema.js";
export * from "./custom-graph-schema.js";
export * from "./deployment-schema.js";
export * from "./agent-schema.js";
