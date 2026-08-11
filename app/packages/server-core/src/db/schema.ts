import {
  pgTable,
  text,
  type AnyPgColumn,
  boolean,
  integer,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
  check,
  numeric,
  date,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  AlertCondition,
  AlertDestination,
  BillingRuleAdjustment,
  BillingRuleMatch,
  EscalationPolicy,
  QuietHours,
} from "@infrawrench/client-core";

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
    /** "cost_graph" | "cost_report" | "budget" | "custom_graph" */
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
    /**
     * Which number the budget tracks: "cash" (what the provider charged) or
     * "amortized" (commitment fees spread over the term they buy). Defaulted
     * rather than nullable so every existing budget keeps measuring cash, which
     * is what it has been measuring.
     */
    costBasis: text("cost_basis").notNull().default("cash"),
    /**
     * A `saved_cost_filters` row applied by reference and AND-composed with
     * `filters` at evaluation time; null is none. A real column rather than a
     * key inside the `filters` jsonb (which is an array), and deliberately
     * without a foreign key: saved filters are soft-deleted, so referential
     * integrity is enforced above the database — deletion is *refused* while
     * anything references the filter (services/saved-cost-filters.ts), and a
     * reference that fails to resolve anyway errors the budget's evaluation
     * rather than silently widening it to all spend.
     */
    savedFilterId: text("saved_filter_id"),
    /**
     * A `cost_scenario_models` row this budget's **forecast** thresholds are
     * measured against; null — the default, and the value for every budget
     * nobody deliberately opts in — means the bare trend.
     *
     * Nullable rather than defaulted for exactly the reason the column exists:
     * a scenario is somebody's hypothesis about the future, and a hypothesis
     * must never quietly change when a real person gets paged. Opting in is a
     * per-budget act, it is shown on the card, and it is named in the alert
     * body. `actual` thresholds ignore this entirely — they measure money
     * already spent.
     *
     * No foreign key, for the same reason `saved_filter_id` has none: deletion
     * of a referenced model is refused above the database, and a reference that
     * fails to resolve anyway errors the evaluation rather than silently
     * dropping the assumptions the budget was set against.
     */
    scenarioModelId: text("scenario_model_id"),
    /**
     * Measure this budget against **billing-rule-adjusted** spend rather than
     * collected spend. False for every budget, always, until somebody says
     * otherwise.
     *
     * The same refusal `scenario_model_id` encodes, for a sharper reason. A
     * billing rule is org policy — a markup that recovers overhead, a
     * negotiated discount — and a budget threshold decides when a real person
     * is paged. Letting a markup silently raise every budget's measured spend
     * would mean editing one settings page moves an on-call rota, and the page
     * (or the missing page) would carry no evidence of why. Opting in is a
     * per-budget act, it is shown on the card, and the alert body says the
     * figure is adjusted.
     *
     * Unlike scenarios this affects `actual` thresholds too, and must: an
     * adjusted budget is measuring the internal figure, and month-to-date
     * internal spend is exactly as marked up as the forecast is.
     */
    useAdjustedSpend: boolean("use_adjusted_spend").notNull().default(false),
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
 * Scenario models — named, reusable sets of adjustments an org overlays on a
 * cost forecast.
 *
 * The trend forecast is a least-squares fit over trailing daily totals: it can
 * only ever extrapolate what already happened. Everything an org *knows* is
 * coming — a reserved-instance purchase next quarter, a team starting in
 * September, a migration that takes a fifth off compute — is invisible to it.
 * This table is where those facts are written down, so a projection can include
 * them without anybody hand-editing a chart.
 *
 * The adjustments live inline as jsonb rather than in a child table: they are
 * created, edited and reasoned about as one object (like `saved_cost_filters`'
 * `filters`), nothing ever queries across them, and a model is meaningless
 * without all of its rows.
 */
export const costScenarioModels = pgTable(
  "cost_scenario_models",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * The one currency every amount in this model is denominated in. A model
     * that could hold two would produce a projection that is the sum of two
     * kinds of money, so the write path refuses it rather than converting
     * behind the user's back at a rate they may not have stated.
     */
    currency: text("currency").notNull().default("USD"),
    /** A non-empty `CostScenarioAdjustment[]`. */
    adjustments: jsonb("adjustments").notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Soft delete, matching `budgets` and `saved_cost_filters`. */
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_scenario_models_org_idx").on(t.organizationId),
    /** Names address the model from the CLI and from a chart's label. */
    orgNameUnique: uniqueIndex("cost_scenario_models_org_name_unique")
      .on(t.organizationId, t.name)
      .where(sql`deleted_at IS NULL`),
  }),
);

/**
 * Named, reusable cost filter sets ("prod only", "team platform's accounts").
 *
 * Graphs, reports and budgets reference a row here **by id** and the server
 * resolves it at query time — never a copy at pick time — so editing the
 * filter once changes everything using it. `filters` is a `CostFilter[]`
 * (`@infrawrench/client-core`), the same shape those configs hold inline; the
 * cost-query-language text form is derived from it on read and guaranteed
 * derivable by input validation (a tag term must carry its key).
 *
 * Soft-deleted like budgets and reports, but with one extra rule enforced in
 * services/saved-cost-filters.ts: deletion is refused (409) while any budget,
 * report or dashboard graph still references the row. Deleting a referenced
 * filter would silently widen every referent's scope to all spend — for a
 * budget, that can fire or suppress alerts — so the referents are surfaced and
 * the user detaches them deliberately.
 */
export const savedCostFilters = pgTable(
  "saved_cost_filters",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Free text shown under the name in the list; null is no description. */
    description: text("description"),
    /** The filter itself — a non-empty `CostFilter[]`. */
    filters: jsonb("filters").notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Soft delete, matching `budgets` — set, never cleared. */
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("saved_cost_filters_org_idx").on(t.organizationId),
    /**
     * Names are how the CLI (`--filter <name>`) and humans address these, so
     * they must be unambiguous per org — among *live* rows only, hence the
     * partial index: a soft-deleted "prod only" must not squat on the name
     * forever.
     */
    orgNameUnique: uniqueIndex("saved_cost_filters_org_name_unique")
      .on(t.organizationId, t.name)
      .where(sql`deleted_at IS NULL`),
  }),
);

/**
 * Named, addressable saved cost graphs.
 *
 * A `cost_graph` dashboard widget stores its config inline and belongs to one
 * card; a report owns the same config as an org object, so it can be linked to,
 * run by id, and referenced from many dashboards at once through the
 * `cost_report` widget kind. Deleting a report removes those cards with it
 * (services/cost-reports.ts), the same rule budgets and custom graphs follow —
 * a card whose target is gone renders as a permanent "unavailable" tile that no
 * amount of dashboard editing explains.
 */
/**
 * Folders for the Reports list — organization only, never meaning.
 *
 * A report's identity, URL, dashboard cards and run-by-id behaviour are
 * unchanged by where it is filed, which is why both foreign keys pointing here
 * are ON DELETE SET NULL: deleting a folder drops its reports and subfolders
 * back to the top level and destroys nothing. Hard-deleted (no `deletedAt`)
 * for the same reason — a folder carries no config worth resurrecting, and the
 * valuable objects inside it are never at risk.
 *
 * Nesting is bounded at COST_REPORT_FOLDER_LIMITS.maxDepth (3) — enforced in
 * services/cost-report-folders.ts, not here, because "how deep is this folder"
 * is a walk up `parentFolderId` the database cannot cheaply constrain. The
 * same service rejects reparenting a folder under its own descendant, the only
 * write that could ever make this column cyclic.
 */
export const costReportFolders = pgTable(
  "cost_report_folders",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Self-reference for nesting; null is a top-level folder. SET NULL so
     * deleting a parent promotes its children to the top level rather than
     * cascading a subtree away.
     */
    parentFolderId: text("parent_folder_id").references((): AnyPgColumn => costReportFolders.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_report_folders_org_idx").on(t.organizationId),
  }),
);

export const costReports = pgTable(
  "cost_reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Free text shown under the title in the list; null is no description. */
    description: text("description"),
    /**
     * The saved graph — a `CostGraphConfig` from `@infrawrench/ui/cost/config`,
     * the same blob a `cost_graph` widget stores inline, validated against
     * `costGraphConfigSchema` at the API boundary.
     */
    config: jsonb("config").notNull(),
    /**
     * The folder the report is filed under; null is the top level of the
     * Reports list. SET NULL, deliberately: deleting a folder must never
     * delete a report — its contents fall back to the top level instead.
     */
    folderId: text("folder_id").references(() => costReportFolders.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Soft delete, matching `budgets` — set, never cleared. */
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_reports_org_idx").on(t.organizationId),
    /** Folder listings scan one folder within one org. */
    folderIdx: index("cost_reports_folder_idx").on(t.organizationId, t.folderId),
  }),
);

/**
 * Dated notes drawn over cost charts — "we migrated to Graviton here".
 *
 * A step change in spend is only self-explanatory for about a fortnight. These
 * rows are the explanation, stored next to nothing else: an annotation is an
 * overlay and never participates in a sum, so there is deliberately no amount,
 * no currency and no filter here. It is a date, some words, and a scope.
 *
 * `start_date` / `end_date` rather than one date because a deploy is a moment
 * and a migration is a week. `end_date` null means the moment case; the
 * rendering treats [start, start] and [start, end] identically, so the nullable
 * column is the whole cost of supporting both.
 *
 * `cost_report_id` null means **org-wide**: the note appears on every cost
 * chart. That is the default worth having — an instance-type change is not a
 * fact about one report, and filing it under one would leave every other chart
 * showing the same step with no explanation. Set, it narrows the note to one
 * report's chart. CASCADE because a note scoped to a report has no meaning
 * without it; a *soft*-deleted report simply becomes unreachable, taking its
 * notes out of view with it.
 *
 * Hard-deleted, like `cost_report_folders`: a deleted note carries no config
 * anything else depends on, and a soft-delete column would only ever be a way
 * for withdrawn explanations to keep showing up.
 */
export const costAnnotations = pgTable(
  "cost_annotations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Scoped to one report, or null for org-wide — see above. */
    costReportId: text("cost_report_id").references(() => costReports.id, { onDelete: "cascade" }),
    /** Inclusive first day (UTC). A `date`, not a timestamp: spend is daily. */
    startDate: date("start_date").notNull(),
    /** Inclusive last day, or null when the note marks a single day. */
    endDate: date("end_date"),
    text: text("text").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Every read is "the notes this org's chart should draw", ordered by date —
     * one org's rows, sorted, is the whole access pattern.
     */
    orgDateIdx: index("cost_annotations_org_date_idx").on(t.organizationId, t.startDate),
    /** A report's own notes, for the list on its detail page. */
    reportIdx: index("cost_annotations_report_idx").on(t.organizationId, t.costReportId),
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
 *
 * Centres nest: a division holds teams, a team holds products. Nesting is a
 * *reporting* structure only — allocation still resolves every cost row to
 * exactly one centre, and the parent's subtree total is assembled from those
 * leaf numbers afterwards. An org that never sets a parent is a flat list of
 * roots and behaves exactly as it did before the column existed.
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
    /**
     * Self-reference for nesting; null is a top-level centre. SET NULL is a
     * backstop only — `deleteCostCentre` re-parents children onto the deleted
     * centre's own parent inside the delete transaction, so a subtree keeps
     * its shape instead of being flattened to the root.
     */
    parentId: text("parent_id").references((): AnyPgColumn => costCentres.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_centres_org_idx").on(t.organizationId),
    /** Children-of lookups when a delete re-parents a subtree. */
    parentIdx: index("cost_centres_parent_idx").on(t.parentId),
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
 * Billing rules — the org's own adjustments to collected spend: a markup that
 * recovers shared overhead, a discount negotiated outside the provider's
 * pricing, a shared cluster reallocated onto the teams that use it.
 *
 * **Nothing here is ever written into `cost_daily`.** These rows are compiled
 * into the cost query at read time (`clickhouse/cost-readers.ts`), so collected
 * spend stays exactly what the provider reported — the number an invoice
 * reconciles against — and editing or deleting a rule restates nothing. That is
 * the whole reason this is a rule table and not an ingestion step.
 *
 * `match` is the allocation vocabulary plus `chargeType`, deliberately reusing
 * `cost_allocation_rules`' shape rather than inventing a second dialect over
 * the same columns. `adjustment` is stored inline as jsonb like
 * `cost_scenario_models.adjustments`: it is created, edited and reasoned about
 * as one object with its rule, nothing queries across it, and which of its
 * fields are meaningful follows from `kind`.
 *
 * Evaluation order is ascending `priority`, then `created_at`, then `id`.
 * Within it, percentage rules **all** apply (two 10% markups compound to 21%)
 * while reallocation is first-match-wins, so a row moves at most once and the
 * organisation's total is conserved. See `client-core/src/billing-rules.ts`.
 */
export const costBillingRules = pgTable(
  "cost_billing_rules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Disabled rules are kept, not deleted — a markup switched off for a
     * quarter and back on for the next is the normal life of these objects, and
     * deleting it would lose the wording finance agreed to.
     */
    enabled: boolean("enabled").notNull().default(true),
    /** Lower fires first. */
    priority: integer("priority").notNull().default(0),
    match: jsonb("match").$type<BillingRuleMatch>().notNull().default({}),
    adjustment: jsonb("adjustment").$type<BillingRuleAdjustment>().notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_billing_rules_org_idx").on(t.organizationId),
    /**
     * Names address a rule from the CLI and from the "these rules are in force"
     * caption, so they must be unambiguous within an org. Hard-deleted rather
     * than soft, so no partial predicate is needed: a deleted rule is gone and
     * nothing references it — every number it ever affected is recomputed from
     * the rules that exist now, because none of it was ever stored.
     */
    orgNameUnique: uniqueIndex("cost_billing_rules_org_name_unique").on(t.organizationId, t.name),
  }),
);

/**
 * Managed accounts — the customers a managed service provider bills.
 *
 * Scope is stored as two id arrays rather than a join table for the same reason
 * `report_notifications` keeps its Slack channel ids inline: nothing queries
 * across them, they are edited as one object with the customer, and the
 * exclusivity rule ("a cost centre belongs to at most one customer") needs an
 * error message that names the *other* customer, which a unique constraint
 * cannot produce. See `managedAccountScopeConflicts` in client-core.
 *
 * There is deliberately **no match/rule column here.** Which spend belongs to a
 * customer is already answered by `cost_allocation_rules`; a second vocabulary
 * over the same `cost_daily` columns would eventually disagree with the first,
 * and the day it did, an invoice would stop reconciling against the showback
 * report the customer was shown.
 *
 * Soft-deleted, because an issued invoice names its customer and that name must
 * keep resolving for as long as the invoice does.
 */
export const managedAccounts = pgTable(
  "managed_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    billingAddress: text("billing_address"),
    /** ISO 4217 the customer is invoiced in. */
    billingCurrency: text("billing_currency").notNull(),
    /**
     * Amortized by default: charging a customer the whole cash value of a
     * three-year commitment in the month it was signed is not a bill anyone can
     * budget against.
     */
    costBasis: text("cost_basis").$type<"cash" | "amortized">().notNull().default("amortized"),
    /** Off means a pass-through contract — billed exactly what providers charged. */
    applyBillingRules: boolean("apply_billing_rules").notNull().default(true),
    notes: text("notes"),
    costCentreIds: jsonb("cost_centre_ids").$type<string[]>().notNull().default([]),
    accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("managed_accounts_org_idx").on(t.organizationId),
    /**
     * Names address a customer from the CLI and head an invoice, so they must
     * be unambiguous within an org. Partial on the live rows: a deleted
     * customer must not reserve its name forever.
     */
    orgNameUnique: uniqueIndex("managed_accounts_org_name_unique")
      .on(t.organizationId, t.name)
      .where(sql`deleted_at is null`),
  }),
);

/**
 * Invoices raised against a managed account.
 *
 * ## Why the figures are columns and not a query
 *
 * Collected spend restates for days after the fact. An invoice that silently
 * changed after it was sent to a customer is the single worst outcome this
 * feature could produce, so `lines`, `totals` and `derivation` are **written on
 * approval** and read back verbatim ever after. A `draft` leaves them null and
 * recomputes on every read; that is the only status that ever touches
 * ClickHouse for its numbers.
 *
 * `derivation` carries the exchange rates and the day they were read, the
 * billing rules in force, and the names everything in scope had at the time.
 * A later rate change, rename or rule edit therefore cannot restate history —
 * which is the entire point of storing it rather than joining to it.
 *
 * ## Void, never delete
 *
 * There is no delete path for an issued invoice and no update path either
 * (`cost/invoices.ts` refuses both through `managedInvoiceBlocker`). A wrong
 * invoice is voided with a reason and superseded by a corrective one; the pair
 * link through `supersedes_invoice_id` / `superseded_by_invoice_id` so the
 * correction is discoverable from either end.
 */
export const managedInvoices = pgTable(
  "managed_invoices",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Restrict, not cascade: an issued invoice outlives the customer record's
     * usefulness. `managed_accounts` soft-deletes, so this never fires in
     * practice — it is the backstop that makes that non-negotiable.
     */
    managedAccountId: text("managed_account_id")
      .notNull()
      .references(() => managedAccounts.id, { onDelete: "restrict" }),
    /** The customer's name at issue time; frozen with the figures. */
    managedAccountName: text("managed_account_name").notNull(),
    /**
     * `INV-2026-0001`. Null while draft — numbers are assigned at approval so a
     * deleted draft cannot leave a gap in the sequence.
     */
    number: text("number"),
    status: text("status").$type<"draft" | "approved" | "sent" | "void">().notNull(),
    periodFrom: date("period_from").notNull(),
    periodTo: date("period_to").notNull(),
    /** Frozen from the customer's billing currency when the draft is raised. */
    currency: text("currency").notNull(),
    notes: text("notes"),
    /** Null while draft; written once, at approval. */
    lines: jsonb("lines"),
    totals: jsonb("totals"),
    derivation: jsonb("derivation"),
    /** When the frozen figures were computed — the moment of approval. */
    computedAt: timestamp("computed_at"),
    issuedAt: timestamp("issued_at"),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sentAt: timestamp("sent_at"),
    sentByUserId: text("sent_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Delivery — where the frozen document went, kept strictly apart from what
     * it says. Nothing in this group can restate a figure; `cost/invoices.ts`
     * writes them from the send path and from nowhere else.
     *
     * Null on an invoice nobody has tried to email, including one marked sent
     * on a deployment with no mail provider: "a person said this went out" and
     * "we delivered it" are different claims, and only the second is recorded
     * here.
     */
    deliveryStatus: text("delivery_status").$type<
      "pending" | "succeeded" | "partial" | "failed" | "no_targets"
    >(),
    /** The addresses the last attempt was made to, as they were then. */
    deliveryRecipients: jsonb("delivery_recipients").$type<string[]>(),
    /** How many of them the transport accepted on the last attempt. */
    deliveryDelivered: integer("delivery_delivered"),
    deliveryAttemptedAt: timestamp("delivery_attempted_at"),
    /**
     * The last attempt that reached at least one address. This is the column
     * that decides whether sending again is a retry or a second copy in the
     * customer's inbox, so it is never cleared by a later failure.
     */
    deliveredAt: timestamp("delivered_at"),
    deliveryAttemptCount: integer("delivery_attempt_count").notNull().default(0),
    deliveryError: text("delivery_error"),
    voidedAt: timestamp("voided_at"),
    voidedByUserId: text("voided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    voidReason: text("void_reason"),
    supersedesInvoiceId: text("supersedes_invoice_id").references(
      (): AnyPgColumn => managedInvoices.id,
      { onDelete: "set null" },
    ),
    supersededByInvoiceId: text("superseded_by_invoice_id").references(
      (): AnyPgColumn => managedInvoices.id,
      { onDelete: "set null" },
    ),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("managed_invoices_org_idx").on(t.organizationId),
    accountIdx: index("managed_invoices_account_idx").on(t.managedAccountId),
    /**
     * An invoice number is quoted in a customer's remittance advice, so it must
     * identify exactly one document in the org. Partial because drafts have no
     * number yet and Postgres would otherwise treat every null as distinct
     * anyway — stating it keeps the intent readable.
     */
    orgNumberUnique: uniqueIndex("managed_invoices_org_number_unique")
      .on(t.organizationId, t.number)
      .where(sql`number is not null`),
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
    /**
     * When somebody explained this finding, and who. Null is "nobody has said
     * what this was yet", which is the only state the unexplained count in the
     * anomalies list is derived from.
     *
     * Acknowledging never deletes the row and never suppresses detection: the
     * finding was correct, and the same key spiking again next month is a new
     * finding with its own row. It only stops the row nagging.
     *
     * Re-acknowledging replaces the sentence and restamps this, so the
     * timestamp is "when the current explanation was recorded" rather than
     * "when it was first noticed" — a corrected explanation dated to the
     * original mistake would be a lie about what was known when.
     */
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedByUserId: text("acknowledged_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * What they said, stored here as well as in the annotation it created.
     *
     * The duplication is deliberate and is the whole reason deleting the note
     * cannot un-explain the anomaly: the annotation is a living overlay anyone
     * may reword or remove, while this is the record of what was said when this
     * finding was closed. They are written together and can drift afterwards;
     * re-acknowledging rewrites both.
     */
    explanation: text("explanation"),
    /**
     * The annotation the acknowledgement created — the artifact, drawn on every
     * chart covering the anomalous day.
     *
     * SET NULL rather than CASCADE: deleting the note removes the marker, not
     * the acknowledgement. The row stays explained, keeps its sentence, and
     * simply stops pointing at a chart marker that no longer exists.
     */
    annotationId: text("annotation_id").references(() => costAnnotations.id, {
      onDelete: "set null",
    }),
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
    /**
     * The reverse of the link: given an annotation, which finding did it
     * explain. Unique so that answer is one row rather than a list — each
     * acknowledgement mints its own note, and nothing attaches an existing one.
     * Partial because every unacknowledged anomaly holds null here and Postgres
     * would otherwise be storing millions of them in a unique index for nothing.
     */
    annotationUnique: uniqueIndex("cost_anomalies_annotation_unique")
      .on(t.annotationId)
      .where(sql`annotation_id is not null`),
  }),
);

/**
 * Change-based cost alerts — the third cost-alert family, distinct from the
 * other two on purpose:
 *
 * - **Budgets** (`budgets`) alert on an *absolute monthly total* you chose.
 * - **Anomalies** (`cost_anomalies`) alert on unconfigured *statistical
 *   outliers* against a learned baseline.
 * - **Change alerts** (this table) alert on a *configured relative change*:
 *   "tell me when spend on this scope moves more than X% (or $Y) versus the
 *   prior period", on a scope and cadence the user chose.
 *
 * Evaluated after each cost collection pass (`cost/change-eval.ts`), same
 * trigger point as budgets and anomalies; fired events land in
 * `cost_alert_events` and notify through the alert routing layer under the
 * `costChangeAlerts` trigger.
 */
export const costAlerts = pgTable(
  "cost_alerts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Which cost rows count — a `CostFilter[]` from `@infrawrench/client-core`,
     * the same jsonb vocabulary `budgets.filters` uses.
     */
    filters: jsonb("filters").notNull().default([]),
    /**
     * Optional per-group fan-out: a `CostDimensionId` (or null for one total).
     * With a groupBy set, each group's spend is compared to its own prior
     * window and each offending group fires its own event — "watch each
     * service" rather than "watch the sum".
     */
    groupBy: text("group_by"),
    /** Required when `groupBy === "tag"`; the tag key to group on. */
    groupByTagKey: text("group_by_tag_key"),
    /**
     * Comparison cadence — which window is compared to which (exact
     * definitions in `cost/change-detect.ts`):
     * - `daily`: one complete UTC day vs the same weekday one week earlier.
     * - `weekly`: the last 7 complete UTC days vs the 7 before them.
     * - `monthly`: month-to-date (complete days) vs the *same-length* window
     *   at the start of the prior month — never MTD vs the full prior month.
     */
    cadence: text("cadence").$type<"daily" | "weekly" | "monthly">().notNull(),
    /**
     * Fire when spend moved by at least this percent of the prior window.
     * Null means no percent condition. At least one of the two thresholds is
     * always set (API-enforced); when **both** are set, **both** must hold —
     * a 50% jump on $2 of spend clears no absolute floor and stays quiet.
     */
    thresholdPercent: integer("threshold_percent"),
    /** Fire when spend moved by at least this many cents. Null = no floor. */
    thresholdAmountCents: integer("threshold_amount_cents"),
    /** Which direction of movement matters. */
    direction: text("direction").$type<"increase" | "decrease" | "both">().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Stamped by each evaluation pass, fired or not — "is this alert live". */
    lastEvaluatedAt: timestamp("last_evaluated_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Soft delete, matching `budgets` — set, never cleared. */
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("cost_alerts_org_idx").on(t.organizationId),
  }),
);

/**
 * Fired cost-change-alert events. The unique index makes each (alert, period,
 * group, currency) fire at most once — the `budget_alert_events`
 * once-per-month unique is the precedent: evaluation inserts with
 * `onConflictDoNothing` and only a fresh insert can notify, so re-evaluating
 * a window inside the restatement horizon re-fires nothing.
 *
 * `periodKey` is the cadence period the current window belongs to, not the
 * exact span: the day for `daily`, the ISO week (`2026-W32`) of the window's
 * end for `weekly`, the month (`2026-08`) for `monthly`. Weekly and monthly
 * windows grow/slide day by day as complete days accrue, and keying on the
 * exact span would fire a sustained change once per day; keying on the period
 * fires it once per cadence period, which is what a cadence means.
 */
export const costAlertEvents = pgTable(
  "cost_alert_events",
  {
    id: text("id").primaryKey(),
    alertId: text("alert_id")
      .notNull()
      .references(() => costAlerts.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Dedup key — see the table comment. */
    periodKey: text("period_key").notNull(),
    /** Current window, inclusive UTC days. */
    windowFrom: text("window_from").notNull(),
    windowTo: text("window_to").notNull(),
    /** Prior window the current one was compared against, inclusive UTC days. */
    previousFrom: text("previous_from").notNull(),
    previousTo: text("previous_to").notNull(),
    /** The offending group's key; "" when the alert watches one total. */
    groupKey: text("group_key").notNull().default(""),
    /**
     * Currency both amounts are in. Comparison is per currency — or in the
     * org display currency when the org configured one and stated rates; a
     * currency with no rate is compared in its own currency, never dropped.
     */
    currency: text("currency").notNull(),
    previousAmountCents: integer("previous_amount_cents").notNull(),
    currentAmountCents: integer("current_amount_cents").notNull(),
    /**
     * Signed percent change, rounded. Null when the prior window had no spend
     * (new spend — the change is infinite, not a number); -100 when the group
     * vanished entirely.
     */
    changePercent: integer("change_percent"),
    /** Which way spend moved — what the alert's `direction` matched. */
    direction: text("direction").$type<"increase" | "decrease">().notNull(),
    firedAt: timestamp("fired_at").notNull().defaultNow(),
    /** Null until some transport (or a quiet-hours hold) took the alert. */
    notifiedAt: timestamp("notified_at"),
  },
  (t) => ({
    onceUnique: uniqueIndex("cost_alert_events_once_unique").on(
      t.alertId,
      t.periodKey,
      t.groupKey,
      t.currency,
    ),
    orgIdx: index("cost_alert_events_org_idx").on(t.organizationId),
    alertIdx: index("cost_alert_events_alert_idx").on(t.alertId),
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

/**
 * Public status pages — a read-only view of a chosen set of synthetic probes,
 * served unauthenticated at `/status/:slug` for anyone the org gives the link
 * to. The monitoring already exists (`synthetic_probes`); this table only
 * decides which of it is publishable and under what words.
 *
 * Two safety properties are structural rather than remembered:
 *
 * - `published` defaults to **false**. A page is created, previewed by the
 *   org, and only then made reachable — creating one can never accidentally
 *   expose an endpoint.
 * - The slug is the only credential, so it is generated with real entropy
 *   (`generateStatusPageSlug`) rather than derived from the title. It is
 *   globally unique, not per-org: the public URL has no org in it, because
 *   putting one there would leak the organization id to every visitor.
 *
 * What a visitor may learn is bounded by the *wire assembly*, not by this
 * table: labels, current state, and uptime history. Probe URLs, resource ids,
 * account names and error text never leave the org-scoped API.
 */
export const statusPages = pgTable(
  "status_pages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The public URL segment; the page's only access credential. */
    slug: text("slug").notNull(),
    /** Headline shown to visitors, e.g. "Acme API status". */
    title: text("title").notNull(),
    /** Optional paragraph under the headline. */
    description: text("description"),
    /** False until someone deliberately publishes — see the note above. */
    published: boolean("published").notNull().default(false),
    /** Render the 90-day uptime bars, or just the current state. */
    showHistory: boolean("show_history").notNull().default(true),
    /** Show the per-component 24h uptime percentage. */
    showUptime: boolean("show_uptime").notNull().default(true),
    /** Optional "contact support" link rendered in the footer. */
    supportUrl: text("support_url"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("status_pages_org_idx").on(t.organizationId),
    slugUnique: uniqueIndex("status_pages_slug_unique").on(t.slug),
  }),
);

/**
 * Which probes a status page publishes, and what it calls them.
 *
 * `label` exists because a probe's internal name ("prod-api-lb health, eu-w1")
 * is an operations detail, and the public equivalent ("API") is a product one.
 * The public payload always renders `label`, falling back to the probe name
 * only when the org left it blank — that fallback is a deliberate choice by
 * the org, not an accident of the schema.
 *
 * `probeId` IS a FK with cascade, unlike the `resource_id` sidecars elsewhere:
 * a deleted probe has no state left to publish, so the component must vanish
 * with it rather than render a permanent "unknown" tile to the public.
 */
export const statusPageComponents = pgTable(
  "status_page_components",
  {
    id: text("id").primaryKey(),
    statusPageId: text("status_page_id")
      .notNull()
      .references(() => statusPages.id, { onDelete: "cascade" }),
    probeId: text("probe_id")
      .notNull()
      .references(() => syntheticProbes.id, { onDelete: "cascade" }),
    /** Public name; null falls back to the probe's own name. */
    label: text("label"),
    /** Optional heading this component sits under, e.g. "Core services". */
    groupName: text("group_name"),
    /** Ascending display order within the page. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pageIdx: index("status_page_components_page_idx").on(t.statusPageId, t.position),
    pageProbeUnique: uniqueIndex("status_page_components_page_probe_unique").on(
      t.statusPageId,
      t.probeId,
    ),
  }),
);

/**
 * Ownership metadata on a resource — who owns it, what it is for, and the
 * ticket that authorized it.
 *
 * This is the sidecar stance `resource_schedules` and `resource_leases`
 * established, for the same reason: `resource_id` is deliberately **not** a
 * foreign key. Resource rows are churned by sync, and the answer to "whose is
 * this?" must survive a resource disappearing and coming back — losing it on
 * every re-sync would make the field useless exactly when someone needs it.
 * Cleanup rides the `account_id` cascade instead.
 *
 * Owner is modelled twice on purpose:
 *
 * - `owner_user_id` is a real org member, and is what makes an alert
 *   *routable* — the orphan finder can name a person and the notifier can
 *   reach them. `onDelete: "set null"` so removing a user orphans the
 *   ownership row rather than deleting the purpose and ticket with it.
 * - `owner_label` is free text for the cases a user id cannot express — a
 *   team, a squad rota, a contractor. It is display-only and never routed.
 *
 * A row with neither is still worth keeping: purpose and ticket alone answer
 * most of "why does this exist?".
 */
export const resourceOwnership = pgTable(
  "resource_ownership",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Not a FK — see above. */
    resourceId: text("resource_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    /** Denormalized so an owner report can name a resource that has gone. */
    resourceName: text("resource_name").notNull(),
    /** The routable owner: an org member. Null = owned by nobody in-app. */
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Free-text owner for teams/externals; display-only, never routed. */
    ownerLabel: text("owner_label"),
    /** What the resource is for, in the org's own words. */
    purpose: text("purpose"),
    /** Link to the ticket/issue/PR that authorized it. */
    ticketUrl: text("ticket_url"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgResourceUnique: uniqueIndex("resource_ownership_org_resource_unique").on(
      t.organizationId,
      t.resourceId,
    ),
    orgIdx: index("resource_ownership_org_idx").on(t.organizationId),
    ownerIdx: index("resource_ownership_owner_idx").on(t.organizationId, t.ownerUserId),
    accountIdx: index("resource_ownership_account_idx").on(t.accountId),
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
 * A Slack channel an org can route alerts to.
 *
 * The row is now **identity only** — which channel, in which install. It used
 * to carry one boolean per trigger, which made it half of a routing table with
 * no way to express a condition: a channel could take "all budget alerts" or
 * none, never "budget alerts over $500 on prod". Routing moved to
 * `alert_rules`, which references this row by id; see
 * `client-core/src/alert-routing.ts` for why that also made adding a trigger a
 * one-line change instead of a six-file one.
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
    /**
     * Which table `approval_id` points at: "workflow" (`workflow_approvals`),
     * "chat" (`chat_pending_actions`) or "access" (`access_requests`).
     * Widening this is a `$type` change only — the column is already `text`.
     */
    kind: text("kind").$type<"workflow" | "chat" | "access">().notNull(),
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
 * A Microsoft Teams channel an org can route alerts to, identified by the
 * webhook URL of a Teams "Workflows" automation (or a legacy Office 365
 * connector).
 *
 * Like `slackChannels`, this row is identity and credential only; which alerts
 * reach it is decided by `alert_rules`.
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
 * Per-org tuning for the three *efficiency* detectors — commitment expiry,
 * idle commitments, and unit-cost regression. `org_cost_anomaly_settings`'
 * protocol exactly: one row per org that has ever changed a knob, no row means
 * the shipped defaults (`DEFAULT_COST_EFFICIENCY_SETTINGS` in
 * `client-core/src/costs.ts`), and the API bounds every value
 * (`COST_EFFICIENCY_LIMITS`) so a stored setting cannot turn a detector into a
 * pager storm or a permanent silence.
 *
 * One table for three detectors rather than three tables, because an org tunes
 * them as one decision — "how noisy is the slow lane" — and because the three
 * are read together, once per evaluation pass, by three drivers that already
 * run back to back.
 *
 * Money is USD cents and restated per currency by each detector, the same rule
 * the anomaly settings follow.
 */
export const orgCostEfficiencySettings = pgTable("org_cost_efficiency_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),

  commitmentExpiryEnabled: boolean("commitment_expiry_enabled").notNull().default(true),
  /**
   * Days of notice, each firing once per commitment per term end. JSON rather
   * than an `integer[]`: the list is read whole, written whole, and never
   * queried by element, so the array operators a Postgres array would buy are
   * operators nothing here uses.
   */
  commitmentExpiryHorizonDays: jsonb("commitment_expiry_horizon_days")
    .$type<number[]>()
    .notNull()
    .default([60, 30, 7]),
  /** Whether a commitment that lapsed unwarned raises one alert at horizon 0. */
  commitmentExpiryAlertOnExpired: boolean("commitment_expiry_alert_on_expired")
    .notNull()
    .default(true),

  commitmentIdleEnabled: boolean("commitment_idle_enabled").notNull().default(true),
  commitmentIdleThresholdPercent: integer("commitment_idle_threshold_percent")
    .notNull()
    .default(70),
  commitmentIdleWindowDays: integer("commitment_idle_window_days").notNull().default(30),
  /**
   * Days inside the window that must carry cost data before anything is
   * judged. The guard that keeps a collection outage from reading as an idle
   * commitment — see `commitments/utilization.ts`.
   */
  commitmentIdleMinMeasuredDays: integer("commitment_idle_min_measured_days").notNull().default(14),
  /** Least wasted money before alerting, USD cents. */
  commitmentIdleMinWasteCents: integer("commitment_idle_min_waste_cents").notNull().default(5000),

  unitCostRegressionEnabled: boolean("unit_cost_regression_enabled").notNull().default(true),
  unitCostThresholdPercent: integer("unit_cost_threshold_percent").notNull().default(20),
  unitCostWindowDays: integer("unit_cost_window_days").notNull().default(14),
  /** Reported, positive metric days required in **each** window. */
  unitCostMinReportedDays: integer("unit_cost_min_reported_days").notNull().default(10),
  /** Least current-window spend before alerting, USD cents. */
  unitCostMinSpendCents: integer("unit_cost_min_spend_cents").notNull().default(10000),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Fired unit-cost regressions: one row per (metric, currency, window end).
 *
 * The `budget_alert_events` once-per-period protocol, with the period being
 * the current window's last day — evaluation inserts with
 * `onConflictDoNothing` and only a fresh insert notifies. That alone would
 * still re-fire daily while a regression persists (the window slides), so the
 * driver adds the `cost_anomalies` cross-day cooldown on top: a metric that
 * was *notified* inside the trailing cooldown stores its row but stays quiet.
 * Counting only notified rows matters for the same reason it does there — a
 * suppressed row must not extend its own silence, and a row nobody received
 * must not suppress the alert that would have told them.
 *
 * Per currency because unit costs are: a metric whose spend lands in EUR and
 * USD has two unit costs and neither divides the other's denominator.
 */
export const unitCostRegressionEvents = pgTable(
  "unit_cost_regression_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    metricId: text("metric_id")
      .notNull()
      .references(() => businessMetrics.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    /** Current window, inclusive UTC days. */
    windowFrom: text("window_from").notNull(),
    windowTo: text("window_to").notNull(),
    /** Prior window it was compared against, inclusive UTC days. */
    previousFrom: text("previous_from").notNull(),
    previousTo: text("previous_to").notNull(),
    /**
     * The two ratios, in currency units per metric unit. Not cents: a unit
     * cost is routinely sub-cent (cost per request, cost per event) and
     * rounding it to the currency's minor unit would store `0` — the same lie
     * `cost/unit-costs.ts` refuses to draw.
     */
    previousUnitCost: doublePrecision("previous_unit_cost").notNull(),
    currentUnitCost: doublePrecision("current_unit_cost").notNull(),
    /** Signed percent change of the unit cost, rounded. */
    changePercent: integer("change_percent").notNull(),
    /** Current window's spend, in currency units — the "is this worth reading" number. */
    currentSpend: doublePrecision("current_spend").notNull(),
    /** Summed metric value on each side, over the reported days only. */
    previousMetricValue: doublePrecision("previous_metric_value").notNull(),
    currentMetricValue: doublePrecision("current_metric_value").notNull(),
    /** Days in each window that carried a reported, positive value. */
    previousReportedDays: integer("previous_reported_days").notNull(),
    currentReportedDays: integer("current_reported_days").notNull(),
    firedAt: timestamp("fired_at").notNull().defaultNow(),
    notifiedAt: timestamp("notified_at"),
  },
  (t) => ({
    onceUnique: uniqueIndex("unit_cost_regression_once_unique").on(
      t.metricId,
      t.currency,
      t.windowTo,
    ),
    /** The read: one org's recent firings, newest first. */
    orgFiredIdx: index("unit_cost_regression_events_org_fired_idx").on(t.organizationId, t.firedAt),
    /**
     * The cooldown probe — "this metric's notified rows inside a day range" —
     * needs no index of its own: `onceUnique` is already
     * `(metric_id, currency, window_to)`, which is equality on the first two
     * and a range on the third, exactly the shape of that query.
     */
  }),
);

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
 * Accepted posture findings — "yes, that bucket is public on purpose".
 *
 * Keyed by `(organization, resource, rule)` rather than by a finding row:
 * findings have no identity, they are recomputed from stored fields on every
 * read. Both halves of the key are stable — resource ids come from the
 * plugin's lister and are the id upserted on every sync, rule ids are
 * declared in the plugin manifest — so a dismissal survives syncs and stops
 * applying by itself the moment the rule stops matching.
 *
 * `resourceId` is not a FK, the `resource_changes` stance: resource rows are
 * churned by sync and soft-deleted, and a dismissal that outlives its
 * resource is inert anyway (the feed only reports dismissals whose rule still
 * matches). Cleanup rides the organization cascade.
 *
 * `dismissedBy` is nulled rather than cascaded when the user is deleted — the
 * decision stays on the record even when the person who made it is gone.
 */
export const postureDismissals = pgTable(
  "posture_dismissals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Infrawrench resource id, as the plugin's lister reports it. */
    resourceId: text("resource_id").notNull(),
    /** The matched rule's id, unique within its plugin. */
    ruleId: text("rule_id").notNull(),
    /** The operator's note, when they left one. */
    reason: text("reason"),
    dismissedBy: text("dismissed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("posture_dismissals_org_idx").on(t.organizationId),
    /** One decision per (resource, rule) — dismissing twice is an update. */
    findingUnique: uniqueIndex("posture_dismissals_finding_idx").on(
      t.organizationId,
      t.resourceId,
      t.ruleId,
    ),
  }),
);

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
 * Per-(user, org) push trigger opt-outs. No row means the shipped defaults —
 * registering a device is the opt-in act.
 *
 * This is the one half of the old boolean matrix that did **not** become a
 * routing rule, and the distinction is the point. An `alert_rules` row is an
 * org decision about where the org is told; this is a member's decision about
 * whether their own phone rings at 3am. Folding it into the org table would
 * have let an admin un-mute somebody else's notifications, so it stayed
 * personal — it just stopped being one column per trigger.
 *
 * `mutedTriggers` names the triggers this member has turned **off**; an unknown
 * or new trigger is therefore on by default, which is why adding one needs no
 * migration here. The shipped defaults for a member with no row live in
 * `DEFAULT_MUTED_TRIGGERS` (`client-core/src/alert-routing.ts`) — currently
 * just `resourceDrift`, which is the same decision its `false` column default
 * used to encode.
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
    /** Trigger ids this member has muted. Empty array = everything on. */
    mutedTriggers: text("muted_triggers")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    userOrgUnique: uniqueIndex("push_preferences_user_org_unique").on(t.userId, t.organizationId),
    orgIdx: index("push_preferences_org_idx").on(t.organizationId),
  }),
);

/**
 * An org's alert routing table: ordered rules that decide which destinations
 * hear about an alert, evaluated by `routeAlertRules` in
 * `client-core/src/alert-routing.ts`.
 *
 * **No row means the shipped default**, the same contract `org_digest_settings`
 * and `org_cost_anomaly_settings` use: an org that has never opened the editor
 * behaves as if it had one "everything except drift → every channel and every
 * phone" rule, which is exactly what the boolean matrix did with every box
 * ticked. That is what keeps "connect Slack, get alerts" true on day one.
 *
 * Everything variable about a rule is JSON rather than columns, deliberately.
 * Conditions and destinations are a discriminated union that will grow; columns
 * would put us back where we started, adding one per new idea. The shapes are
 * validated by `validateAlertRule` on the way in, so the JSON is never
 * unchecked — it is just not the database's job to check it.
 */
export const alertRules = pgTable(
  "alert_rules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Ascending evaluation order. Ties break on id so the order is total. */
    position: integer("position").notNull().default(0),
    /**
     * Empty matches every alert.
     *
     * `$type` here documents the shape and spares every reader a cast; it is
     * *not* a guarantee. These columns outlive the build that wrote them, so
     * `alerts/rules.ts` still re-checks each one on the way out — see `toRule`.
     */
    conditions: jsonb("conditions").$type<AlertCondition[]>().notNull().default([]),
    /** Empty is legal: a rule that swallows alerts. */
    destinations: jsonb("destinations").$type<AlertDestination[]>().notNull().default([]),
    /** False (the default) makes the list first-match-wins. */
    continueOnMatch: boolean("continue_on_match").notNull().default(false),
    /** Hold matching alerts until the window closes. */
    quietHours: jsonb("quiet_hours").$type<QuietHours>(),
    /** Re-send elsewhere if nobody acknowledges. */
    escalation: jsonb("escalation").$type<EscalationPolicy>(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgPositionIdx: index("alert_rules_org_position_idx").on(t.organizationId, t.position),
  }),
);

/**
 * The follow-up queue: one row per (rule, alert) that is not finished when
 * `routeAlert` returns.
 *
 * Two features share it because they are the same shape — an alert with a
 * deadline and a claim column:
 *
 *   * **held** — quiet hours caught it. `deliverAfter` is when the window
 *     closes, and the flush pass claims it exactly the way the poller claims a
 *     due account: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`,
 *     writing a lease into the due column itself. N replicas send once.
 *   * **awaiting_ack** — the rule asked to escalate. `escalateAt` is the second
 *     deadline and is claimed by the same statement shape.
 *
 * `payload` is the whole `AlertEvent` because the pass that sends it runs
 * minutes or hours after the thing that raised it, in a different process, and
 * re-deriving an anomaly's wording from the cost tables at flush time would be
 * a second implementation of the message. Storing the rendered alert means the
 * held copy says exactly what the immediate copy would have said.
 *
 * This table is **not** part of the cooldown/claim protocol that decides
 * whether an alert is raised at all — those live with each detector
 * (`inCooldown`, `PageCooldownStore`, `org_drift_alert_settings`) and are
 * untouched. A row only ever appears here after such a claim was already won.
 */
export const alertDeliveries = pgTable(
  "alert_deliveries",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * The rule that produced this leg. Nulled rather than cascaded when the
     * rule is deleted: a held alert must still be delivered, and an escalation
     * already in flight must still be able to complete.
     */
    ruleId: text("rule_id").references(() => alertRules.id, { onDelete: "set null" }),
    /** Snapshot of the rule's name, so a deleted rule still explains the row. */
    ruleName: text("rule_name"),
    trigger: text("trigger").notNull(),
    severity: text("severity").notNull(),
    /**
     * `held` | `awaiting_ack` | `sent` | `acknowledged` | `escalated` |
     * `expired` — the `AlertDeliveryState` union in client-core. `sent` is what
     * `flushHold` writes for a released hold whose rule does not escalate;
     * everything else is terminal or waiting on one of the two deadlines.
     */
    state: text("state").notNull(),
    /**
     * The full `AlertEvent`, rendered — see the note above. Left untyped
     * because `AlertEvent` is declared in `alerts/route.ts`, which imports this
     * module; naming it here would close the cycle.
     */
    payload: jsonb("payload").notNull(),
    /** The destinations this leg is for. */
    destinations: jsonb("destinations").$type<AlertDestination[]>().notNull().default([]),
    /** Snapshotted at raise time, so a later rule edit cannot change it. */
    escalation: jsonb("escalation").$type<EscalationPolicy>(),
    /** Quiet-hours release instant, and the flush pass's claim column. */
    deliverAfter: timestamp("deliver_after"),
    /** Escalation deadline, and the escalation pass's claim column. */
    escalateAt: timestamp("escalate_at"),
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedByUserId: text("acknowledged_by_user_id"),
    /** How the acknowledgement arrived, e.g. `slack`. For the audit line. */
    acknowledgedVia: text("acknowledged_via"),
    /** Bumped by every claim, so a permanently failing row can be given up on. */
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("alert_deliveries_org_idx").on(t.organizationId, t.createdAt),
    // Partial-shaped in practice: both passes scan one state and one timestamp,
    // so leading with `state` keeps each claim an index range scan even when
    // the table is mostly finished rows.
    dueIdx: index("alert_deliveries_due_idx").on(t.state, t.deliverAfter),
    escalateIdx: index("alert_deliveries_escalate_idx").on(t.state, t.escalateAt),
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

/**
 * An org's connection to one Jira Cloud site, used to turn findings (cost
 * anomalies, orphans, oversized resources, posture findings, expiring
 * credentials, failed probes) into tracked issues.
 *
 * One row per org — an org files into a single site. Keyed by `organizationId`
 * rather than carrying its own `id` for the same reason `twilio_settings` is:
 * "configured or not" is a property of the org, and a primary key makes the
 * upsert in `setJiraIntegration` a plain `onConflictDoUpdate` on the org.
 *
 * Auth is Jira Cloud basic auth: `Authorization: Basic base64(email:apiToken)`.
 * The API token is a bearer credential for the whole Atlassian account, so it
 * is encrypted at rest exactly like the Twilio auth token and the Teams webhook
 * URL, and never leaves the server — the API returns {@link tokenHint} instead.
 */
export const jiraIntegrations = pgTable("jira_integrations", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * Site base URL with no trailing slash, e.g. `https://acme.atlassian.net`.
   * Kept in the clear: it is not a secret, it is shown in the settings UI, and
   * issue links are built from it.
   */
  siteUrl: text("site_url").notNull(),
  /** Atlassian account email — the username half of the basic-auth pair. */
  accountEmail: text("account_email").notNull(),
  /** AES-256-GCM encrypted Jira API token. AAD: `jira:<orgId>:apiToken`. */
  encryptedApiToken: text("encrypted_api_token").notNull(),
  apiTokenIv: text("api_token_iv").notNull(),
  /**
   * Non-secret display marker, e.g. `…a7f2`. Lets the settings UI show that a
   * token is stored, and which one, without ever returning the token itself.
   */
  tokenHint: text("token_hint").notNull(),
  /** Project the "File a Jira issue" modal preselects, e.g. `OPS`. */
  defaultProjectKey: text("default_project_key"),
  /** Issue type id the modal preselects within {@link defaultProjectKey}. */
  defaultIssueTypeId: text("default_issue_type_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * The Jira issue a finding was filed as. This is what lets a list view render
 * "PROJ-412" on a row instead of offering the file button a second time.
 *
 * The unique constraint spans (org, kind, source, issue key) so re-filing the
 * same finding as the same issue is idempotent rather than an error, while
 * still permitting a deliberate second issue for the same finding (a different
 * key) — the UI never offers that, but a caller with `jira:write` may.
 */
export const jiraIssueLinks = pgTable(
  "jira_issue_links",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Which detector produced the finding. Constrained in the database as well
     * as in the route's zod schema — these rows outlive any one code path, and
     * an unknown kind would strand the link where no UI looks for it.
     */
    sourceKind: text("source_kind").notNull(),
    /**
     * The finding's own id, opaque here. Not a foreign key: the six sources
     * live in six different tables, and some (cost anomalies) are recomputed
     * rather than stored, so referential integrity is not available.
     */
    sourceId: text("source_id").notNull(),
    /** Jira issue key, e.g. `OPS-412`. */
    issueKey: text("issue_key").notNull(),
    /** Browse URL, e.g. `https://acme.atlassian.net/browse/OPS-412`. Stored
     * rather than derived so the link still resolves after the org points the
     * integration at a different site. */
    issueUrl: text("issue_url").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgSourceIssueUnique: uniqueIndex("jira_issue_links_org_source_issue_unique").on(
      t.organizationId,
      t.sourceKind,
      t.sourceId,
      t.issueKey,
    ),
    /** Backs the batch `GET /links?sourceKind=&sourceId=` a list view calls once. */
    orgKindIdx: index("jira_issue_links_org_kind_idx").on(t.organizationId, t.sourceKind),
    sourceKindValid: check(
      "jira_issue_links_source_kind_valid",
      sql`${t.sourceKind} IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe')`,
    ),
  }),
);

/**
 * An org's connection to one Linear workspace — the second issue tracker next
 * to `jira_integrations`, covering the same six finding kinds. Deliberately a
 * parallel table rather than a generalized "trackers" table: an org may
 * connect either or both, and two tables keep the integrations independently
 * removable.
 *
 * One row per org, keyed by `organizationId` for the same reason
 * `jira_integrations` is: "configured or not" is a property of the org, and a
 * primary key makes the upsert in `setLinearIntegration` a plain
 * `onConflictDoUpdate` on the org.
 *
 * Auth is a Linear personal API key sent as `Authorization: <key>` (no Bearer
 * prefix — see server-core/linear.ts). No site URL column: Linear has one
 * fixed GraphQL endpoint for every workspace. The key is a bearer credential
 * for everything the Linear user can see, so it is encrypted at rest exactly
 * like the Jira API token, and never leaves the server — the API returns
 * {@link keyHint} instead.
 */
export const linearIntegrations = pgTable("linear_integrations", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** AES-256-GCM encrypted Linear personal API key. AAD: `linear:<orgId>:apiKey`. */
  encryptedApiKey: text("encrypted_api_key").notNull(),
  apiKeyIv: text("api_key_iv").notNull(),
  /**
   * Non-secret display marker, e.g. `…a7f2`. Lets the settings UI show that a
   * key is stored, and which one, without ever returning the key itself.
   */
  keyHint: text("key_hint").notNull(),
  /**
   * Team the "File in Linear" modal preselects. A team id (UUID), not a key:
   * `issueCreate` takes `teamId`, and the settings UI only ever writes values
   * picked from the API's team list.
   */
  defaultTeamId: text("default_team_id"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * The Linear issue a finding was filed as — the exact counterpart of
 * `jira_issue_links`, with the issue identifier (`ENG-123`) where Jira has an
 * issue key. Same idempotency story: the unique constraint spans (org, kind,
 * source, identifier) so re-filing the same finding as the same issue is a
 * no-op, while a deliberate second issue for the same finding stays possible.
 */
export const linearIssueLinks = pgTable(
  "linear_issue_links",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Which detector produced the finding. Constrained in the database as well
     * as in the route's zod schema — these rows outlive any one code path, and
     * an unknown kind would strand the link where no UI looks for it.
     */
    sourceKind: text("source_kind").notNull(),
    /**
     * The finding's own id, opaque here. Not a foreign key, for the same
     * reason as `jira_issue_links.source_id`: the six sources live in six
     * different tables and some are recomputed rather than stored.
     */
    sourceId: text("source_id").notNull(),
    /** Linear issue identifier, e.g. `ENG-123`. */
    issueIdentifier: text("issue_identifier").notNull(),
    /** Issue URL as Linear returned it. Stored rather than derived — the URL
     * embeds the workspace slug, which this table does not otherwise know. */
    issueUrl: text("issue_url").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgSourceIssueUnique: uniqueIndex("linear_issue_links_org_source_issue_unique").on(
      t.organizationId,
      t.sourceKind,
      t.sourceId,
      t.issueIdentifier,
    ),
    /** Backs the batch `GET /links?sourceKind=&sourceId=` a list view calls once. */
    orgKindIdx: index("linear_issue_links_org_kind_idx").on(t.organizationId, t.sourceKind),
    sourceKindValid: check(
      "linear_issue_links_source_kind_valid",
      sql`${t.sourceKind} IN ('cost_anomaly', 'orphan', 'oversized', 'posture_finding', 'expiring', 'probe')`,
    ),
  }),
);

/**
 * The org's display currency for cost reporting — one row per org, the same
 * missing-row-means-defaults protocol as `org_tag_policies` and
 * `org_cost_anomaly_settings`.
 *
 * Cost data is stored per currency and never merged, and that stays the
 * default: an org with no row here, or with a null `display_currency`, sees
 * exactly the per-currency numbers it saw before this table existed. Setting a
 * currency is an explicit, org-level opt-in to seeing one number instead — and
 * only takes effect for currencies the org has also stated a rate for in
 * `org_exchange_rates`, because Infrawrench never fetches live FX.
 */
export const orgCurrencySettings = pgTable("org_currency_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * ISO 4217 code every converted amount is expressed in, or NULL for "do not
   * convert".
   *
   * Nullable rather than defaulted, deliberately: there is no sensible default
   * display currency (USD would silently start converting a EUR-billing org's
   * spend), and NULL lets an org clear the setting and get its honest
   * per-currency view back without deleting the row.
   */
  displayCurrency: text("display_currency"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * The exchange rates an org states for itself, with the date each starts
 * applying.
 *
 * These are the org's rates, not ours. A finance team reconciles a converted
 * total against the rate their accounting system booked the period at — not
 * today's mid-market quote — so nothing in the product fetches live FX. A rate
 * is a row somebody with `org:settings:write` created, `created_by` records
 * who, and a historical day converts at whichever rate was in force then.
 *
 * Lookup for a given day is "the row with the greatest `effective_from` that is
 * `<= day`". A day earlier than every stated rate has no rate, and the amount
 * is reported unconverted rather than dropped.
 *
 * Rates are stated **to** the display currency in one hop. The code never
 * inverts a rate (EUR→USD implying USD→EUR) or chains two, because both
 * produce a number the org never stated and cannot reconcile.
 */
export const orgExchangeRates = pgTable(
  "org_exchange_rates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** ISO 4217 code the rate converts *from*, e.g. `EUR`. Upper-cased at the API. */
    fromCurrency: text("from_currency").notNull(),
    /**
     * ISO 4217 code the rate converts *to*. Stored per row rather than read
     * from `org_currency_settings.display_currency` so that changing the
     * display currency cannot silently re-interpret every historical rate as
     * pointing somewhere it never pointed.
     */
    toCurrency: text("to_currency").notNull(),
    /**
     * Multiply an amount in `from_currency` by this to get `to_currency`.
     *
     * **`numeric(20, 10)` — an exact decimal, not a float.** Three reasons, in
     * order of how much they matter:
     *
     *  1. The number the org typed must be the number stored and echoed back.
     *     `double precision` cannot hold 0.92; it holds 0.9199999999999999,
     *     and a finance user who types the rate their accounting system used
     *     and reads back a different one has no reason to trust any other
     *     figure on the page. Reconciliation is the entire purpose of this
     *     table.
     *  2. Drizzle returns `numeric` as a **string**, so the exact decimal
     *     survives the round trip to the API and the form. It becomes a float
     *     exactly once, in `cost/currency-convert.ts`, at the multiply.
     *  3. 10 decimal places covers the low-value currencies with room to
     *     spare — a VND→USD rate of ~0.0000395 still keeps six significant
     *     figures — while 20 total digits leaves the integer side unbounded in
     *     practice.
     *
     * An integer scaled fixed-point column (rate × 10^10 in a `bigint`) would
     * store the same values just as exactly, and was rejected: it puts the
     * scale in application code rather than in the column type, so every
     * reader — the API, the CLI, a psql session, a future migration — has to
     * know the magic constant to interpret the number, and getting it wrong is
     * silent and off by a factor of ten billion. `numeric` says what it means.
     */
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    /**
     * Inclusive `YYYY-MM-DD` from which this rate applies, as a `date`.
     *
     * A date, not a timestamp: a rate applies to a *day* of spend, and
     * `cost_daily` is keyed by day. A timestamp would invite a timezone
     * question that has no answer here.
     */
    effectiveFrom: date("effective_from").notNull(),
    /**
     * User who stated the rate. Nullable because the user row can be deleted
     * and the rate must outlive them — the converted history stays valid, and
     * a null author is more honest than reassigning one.
     */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    /**
     * One rate per (org, from, to, day). Two rates effective the same day for
     * the same pair would make "the rate that applied then" ambiguous, and the
     * total would depend on row order.
     */
    orgPairDayUnique: uniqueIndex("org_exchange_rates_org_pair_day_unique").on(
      t.organizationId,
      t.fromCurrency,
      t.toCurrency,
      t.effectiveFrom,
    ),
    /** Backs the one query that matters: load an org's whole rate table. */
    orgIdx: index("org_exchange_rates_org_idx").on(t.organizationId),
  }),
);

/**
 * A recurring dump of the org's cost rows into a warehouse or object store.
 *
 * Cost data is readable through the API and the UI, but neither is a way to
 * feed a finance system: that wants raw rows, on a schedule, landing somewhere
 * it already reads from. This table is the definition of one such feed. The
 * poller claims due rows (`cost_exports/pass.ts`), streams `cost_daily` out of
 * ClickHouse, and writes **one object per period** to the destination.
 *
 * Two things about the design are load-bearing:
 *
 *   * `nextRunAt` is both the due-time column and the claim lease, exactly like
 *     `metric_alert_rules.next_eval_at` — one conditional
 *     `UPDATE … FOR UPDATE SKIP LOCKED` claims a row, and an instance that dies
 *     mid-run simply lets the lease expire. No extra schema, replica-safe.
 *   * `restatementDays` exists because provider spend is **restated for days
 *     after the fact**. An export whose objects were written once and never
 *     revisited would drift away from the provider's own invoice within a
 *     week. Every run re-writes the periods overlapping the trailing window at
 *     their existing keys, and because the key is deterministic
 *     (`COST_EXPORT_KEY_TEMPLATE` in client-core) that overwrites rather than
 *     duplicates. Rows additionally carry the collection watermark so a
 *     consumer can tell a settled period from a still-moving one.
 *
 * Destination credentials are AES-256-GCM encrypted with the same mechanism as
 * `twilio_settings`, `msteams_webhooks` and `jira_integrations`, and are never
 * returned by any route — {@link credentialHint} is what the API answers with.
 */
export const costExports = pgTable(
  "cost_exports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** User-facing name, e.g. `Finance warehouse (daily)`. */
    name: text("name").notNull(),
    /** `csv` | `ndjson` — how the row stream is serialised. */
    format: text("format").notNull().default("csv"),
    /**
     * The query scope, as a `CostExportQuery`: the same `CostFilter[]` and cost
     * dimension vocabulary dashboards, budgets and reports store, plus which
     * identity columns survive into the output. Reusing that shape rather than
     * inventing an export-only filter language is what keeps "filtered to
     * account X" meaning one thing across the product.
     */
    query: jsonb("query").$type<Record<string, unknown>>().notNull(),
    /**
     * `daily` | `weekly` | `monthly`. Doubles as the *period* definition — a
     * run writes one object per calendar day, ISO week, or calendar month.
     */
    cadence: text("cadence").notNull().default("daily"),
    /** Local hour (0–23) in {@link timezone} a run fires at. */
    hour: integer("hour").notNull().default(4),
    /**
     * IANA zone the schedule and the period boundaries are expressed in, e.g.
     * `Europe/Berlin`. Modelled on `org_digest_settings.timezone`: `UTC` is the
     * default and is validated server-side against `Intl`.
     */
    timezone: text("timezone").notNull().default("UTC"),
    /**
     * Trailing days of already-written periods each run re-exports. 0 means
     * "write the newest complete period and never look back", which is only
     * correct for an org whose providers never restate — see the table comment.
     */
    restatementDays: integer("restatement_days").notNull().default(7),
    enabled: boolean("enabled").notNull().default(true),
    /** `s3` | `http`. Kept as its own column so the due query can filter on it. */
    destinationKind: text("destination_kind").notNull(),
    /**
     * Non-secret destination config (bucket, prefix, region, endpoint, method,
     * URL hint). Everything here is shown back to the user; anything secret
     * lives in {@link encryptedCredentials}.
     */
    destination: jsonb("destination").$type<Record<string, unknown>>().notNull(),
    /**
     * AES-256-GCM encrypted JSON credential bundle — `{accessKeyId, secretAccessKey}`
     * for S3, `{url}` for HTTP (a pre-signed URL carries its own signature, so
     * it is a bearer credential). AAD: `costExport:<exportId>:credentials`.
     */
    encryptedCredentials: text("encrypted_credentials"),
    credentialsIv: text("credentials_iv"),
    /**
     * Non-secret display marker, e.g. `AKIA…7F2Q` or `warehouse.acme.com/…a7f2`.
     * Lets the settings UI show that a credential is stored, and which one,
     * without any route ever returning the credential itself.
     */
    credentialHint: text("credential_hint"),
    /** When the last run finished (successfully or not). */
    lastRunAt: timestamp("last_run_at"),
    /** `pending` before the first run, then `succeeded` | `failed`. */
    lastStatus: text("last_status").notNull().default("pending"),
    /** Human-readable reason for the last failure, for the settings UI. */
    lastError: text("last_error"),
    /** Objects written and rows streamed by the last successful run. */
    lastObjectCount: integer("last_object_count"),
    lastRowCount: integer("last_row_count"),
    /**
     * Due time AND claim lease. Null while disabled (the claim never sees it);
     * the claim pushes it a lease ahead, and the run replaces it with the true
     * next fire time.
     */
    nextRunAt: timestamp("next_run_at"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    /**
     * Soft delete. A deleted export stops running immediately (the claim
     * filters on it) but its row survives, so an audit entry naming it still
     * resolves to something.
     */
    deletedAt: timestamp("deleted_at"),
  },
  (t) => ({
    orgIdx: index("cost_exports_org_idx").on(t.organizationId),
    dueIdx: index("cost_exports_due_idx").on(t.nextRunAt),
    hourRange: check("cost_exports_hour_range", sql`${t.hour} >= 0 AND ${t.hour} <= 23`),
    /**
     * 90 days is an upper bound on how far back any provider we collect from
     * restates, and it bounds the work one run can queue up: a run re-exports
     * every period overlapping this window, so an unbounded value would be an
     * unbounded run.
     */
    restatementRange: check(
      "cost_exports_restatement_days_range",
      sql`${t.restatementDays} >= 0 AND ${t.restatementDays} <= 90`,
    ),
  }),
);

/**
 * Scheduled delivery of a saved cost report to Slack, Teams and email — one row
 * per schedule, several schedules per report.
 *
 * This is the **digest pattern, not the alert-routing one**: a report delivery
 * is a scheduled, composed summary sent to destinations someone picked when
 * they created the schedule, exactly like `org_digest_settings` — it is not an
 * alert, has no severity, and deliberately does not go through
 * `alerts/route.ts`'s routing rules. Do not "fix" it onto the routing table:
 * a routing rule answers "where do alerts of this kind go", while a schedule
 * here answers "who asked for this report, when" — per-report, per-schedule
 * state that a shared rule set cannot express.
 *
 * `cost_report_id` cascades: **a deleted report takes its schedules with it —
 * that cascade IS the design.** A schedule is meaningless without the report
 * it delivers, and a surviving row would be a claim the poller keeps trying to
 * honour against a report that no longer exists. (Soft deletes don't fire the
 * FK, so `softDeleteCostReport` disables the schedules explicitly and the
 * poller pass double-checks the report is still live.)
 *
 * Scheduling is modelled on `org_digest_settings` (cadence + local hour + IANA
 * zone) but claimed like `cost_exports`: `next_send_at` is both the due time
 * and the claim lease — null while disabled, pushed a lease ahead by the
 * claim, replaced with the true next fire (or a bounded retry backoff) when
 * the run records its outcome.
 */
export const reportNotifications = pgTable(
  "report_notifications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** See the table comment: the cascade is the design. */
    costReportId: text("cost_report_id")
      .notNull()
      .references(() => costReports.id, { onDelete: "cascade" }),
    /** `daily` | `weekly` | `monthly`. */
    cadence: text("cadence").notNull().default("weekly"),
    /** ISO day of week (1 = Monday … 7 = Sunday); read only when `cadence` is weekly. */
    sendDay: integer("send_day").notNull().default(1),
    /**
     * Day of month (1–31); read only when `cadence` is monthly. A day the
     * month doesn't have clamps to its last day — "the 31st" means "month end"
     * in April, which is what someone scheduling a month-end report meant.
     */
    sendDayOfMonth: integer("send_day_of_month").notNull().default(1),
    /** Local hour (0–23) in {@link timezone} the delivery fires at. */
    hour: integer("hour").notNull().default(8),
    /** IANA zone, validated server-side against `Intl` like the digest's. */
    timezone: text("timezone").notNull().default("UTC"),
    /**
     * Opted-in `slack_channels` row ids. Row ids rather than raw channel ids,
     * matching `alert_rules` destinations: the row carries the install, and a
     * disconnected install silently drops out at send time.
     */
    slackChannelIds: jsonb("slack_channel_ids").$type<string[]>().notNull().default([]),
    /** Opted-in `msteams_webhooks` row ids. */
    teamsWebhookIds: jsonb("teams_webhook_ids").$type<string[]>().notNull().default([]),
    /**
     * Plain addresses, stored lowercased — the digest's recipient model: an
     * address list reaches a finance alias with no Infrawrench login, which a
     * member opt-in never could.
     */
    emailRecipients: jsonb("email_recipients").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Due time AND claim lease (see the table comment). Null while disabled,
     * so "has a due time" and "should run" are the same statement, exactly as
     * `cost_exports.next_run_at` works.
     */
    nextSendAt: timestamp("next_send_at"),
    /** When a delivery last actually reached someone. Null while only failures. */
    lastSentAt: timestamp("last_sent_at"),
    /** Attempts made for the current occurrence; reset on success or give-up. */
    attemptCount: integer("attempt_count").notNull().default(0),
    /** When the last attempt (successful or not) ran. */
    lastAttemptAt: timestamp("last_attempt_at"),
    /** `pending` | `succeeded` | `partial` | `failed` | `no_targets`. */
    lastStatus: text("last_status"),
    /** Human-readable reason for the last non-success, for the report page. */
    lastError: text("last_error"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("report_notifications_org_idx").on(t.organizationId),
    /** The report page lists one report's schedules. */
    reportIdx: index("report_notifications_report_idx").on(t.costReportId),
    /** The poller's due scan. */
    dueIdx: index("report_notifications_due_idx").on(t.nextSendAt),
    hourRange: check("report_notifications_hour_range", sql`${t.hour} >= 0 AND ${t.hour} <= 23`),
    sendDayRange: check(
      "report_notifications_send_day_range",
      sql`${t.sendDay} >= 1 AND ${t.sendDay} <= 7`,
    ),
    dayOfMonthRange: check(
      "report_notifications_day_of_month_range",
      sql`${t.sendDayOfMonth} >= 1 AND ${t.sendDayOfMonth} <= 31`,
    ),
  }),
);

/**
 * Business metric definitions — the denominators unit costs divide by.
 *
 * "Cost per customer" needs two halves: the spend (already in `cost_daily`) and
 * a count of customers, which only the org knows. This row is the declaration
 * of that second half: what it is called, what one of it is called, whether it
 * is a quantity or money, and — through `cost_scope` — which slice of spend it
 * is the denominator *of*.
 *
 * `kind` is what makes margin safe. `(revenue − cost) ÷ revenue` is only
 * defined when the denominator is money in a stated currency; a `count` metric
 * can never be asked for it, and a `currency` metric must carry a currency code
 * (the check constraint below enforces both directions of that). Modelling it
 * as a property of the metric rather than a flag on the query means the rule is
 * declared once, at definition time, instead of re-derived by every caller.
 */
export const businessMetrics = pgTable(
  "business_metrics",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /**
     * Stable lowercase slug. Workflows, the CLI and the values endpoint address
     * the metric by this, so it is unique per org among live rows and survives a
     * rename of `name` — which is the whole reason both columns exist.
     */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Singular unit label for display: "customer", "request", "GB". */
    unit: text("unit").notNull(),
    description: text("description"),
    /** "count" | "currency" — see the table comment. */
    kind: text("kind").notNull().default("count"),
    /** ISO-4217 code; set exactly when `kind = 'currency'`. */
    currency: text("currency"),
    /** `CostFilter[]` — the spend this metric divides. Empty is all spend. */
    costScope: jsonb("cost_scope").notNull().default([]),
    /**
     * A `saved_cost_filters` row AND-composed with `cost_scope`, resolved at
     * query time; null is none. No foreign key, for the same reason
     * `budgets.saved_filter_id` has none: saved filters are soft-deleted and
     * deletion is refused while anything references them, so integrity is
     * enforced above the database and a dangling reference errors the query
     * rather than silently widening the numerator to all spend.
     */
    savedFilterId: text("saved_filter_id"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Soft delete, matching budgets and saved filters — set, never cleared. */
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("business_metrics_org_idx").on(t.organizationId),
    /**
     * Among *live* rows only: a soft-deleted "active-customers" must not squat
     * on the key a workflow is still writing to forever.
     */
    orgKeyUnique: uniqueIndex("business_metrics_org_key_unique")
      .on(t.organizationId, t.key)
      .where(sql`deleted_at IS NULL`),
    /**
     * Both directions. A `currency` metric with no currency cannot have margin
     * computed against it, and a `count` metric carrying one would suggest its
     * numbers are money when they are requests — either way the row would be a
     * trap for a later reader rather than a rejected write.
     */
    currencyMatchesKind: check(
      "business_metrics_currency_matches_kind",
      sql`(${t.kind} = 'currency') = (${t.currency} IS NOT NULL)`,
    ),
  }),
);

/**
 * One reported day of one business metric.
 *
 * **Postgres, not ClickHouse, and not because it is small.** These values are
 * joined against ClickHouse spend on every unit-cost query, and a cross-store
 * join *per point* would indeed be the thing to avoid — but that is not the
 * join this feature performs. Both sides are aggregated to the query's buckets
 * first (ClickHouse sums the numerator, this table sums the denominator), and
 * the two are combined once, in application code, at the bucket level — at most
 * a few hundred numbers meeting a few hundred numbers, exactly the way
 * `cost/currency-convert.ts` folds stated rates into an already-aggregated
 * series.
 *
 * With the per-point join gone, Postgres wins on everything else: the
 * `(metric, day)` unique index makes restatement a single `ON CONFLICT DO
 * UPDATE` with no ReplacingMergeTree `FINAL` and no "which version won"
 * question; the metric definition is a Postgres row already, so keeping its
 * values here means one store owns the object rather than half of it; and
 * `updated_by_user_id` gives a surprising number an author, which a columnar
 * append-only table would not.
 */
export const businessMetricValues = pgTable(
  "business_metric_values",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    metricId: text("metric_id")
      .notNull()
      .references(() => businessMetrics.id, { onDelete: "cascade" }),
    /** The UTC day this value belongs to. Daily, to match `cost_daily`. */
    day: date("day").notNull(),
    value: doublePrecision("value").notNull(),
    /** "api" | "workflow" — who wrote it, for reading a surprising point. */
    source: text("source").notNull().default("api"),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    /**
     * The restatement key. Re-reporting a day updates it in place rather than
     * appending, which is what makes a nightly job safe to retry — an ingest
     * that accumulated would double every number the first time it re-ran.
     */
    metricDayUnique: uniqueIndex("business_metric_values_metric_day_unique").on(t.metricId, t.day),
    /** The read: one metric's values across a date range, in day order. */
    metricDayIdx: index("business_metric_values_metric_day_idx").on(t.metricId, t.day),
    orgIdx: index("business_metric_values_org_idx").on(t.organizationId),
  }),
);

export * from "./core-schema.js";
export * from "./workflow-schema.js";
export * from "./ssh-recording-schema.js";
export * from "./access-schema.js";
export * from "./credit-schema.js";
export * from "./custom-graph-schema.js";
export * from "./deployment-schema.js";
export * from "./agent-schema.js";
export * from "./commitment-schema.js";
