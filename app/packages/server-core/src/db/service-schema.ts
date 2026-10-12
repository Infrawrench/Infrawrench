/**
 * Services and scorecards.
 *
 * A **service** groups resources across providers into the thing people
 * actually talk about ("checkout API"), names who owns it and links the
 * reliability objects that already exist on their own: SLOs, runbooks and an
 * on-call schedule. A **scorecard** grades every service against the org's
 * own operational bar.
 *
 * Membership is explicit rows plus rules. `service_members` holds what was
 * picked by hand (`mode = 'include'`) and what a rule matched but somebody
 * removed (`mode = 'exclude'`); the rules themselves live on the service and
 * are evaluated on read against synced inventory, so a newly tagged resource
 * joins without anybody editing the service. `resource_id` is **not** a
 * foreign key, the resource ownership sidecar stance: membership must survive
 * sync churn, and cleanup rides the `account_id` cascade.
 *
 * SLO and runbook links are a polymorphic join (`service_links`) rather than a
 * `service_id` column on those tables: a runbook can serve several services,
 * and the link must not be able to delete the objective or the procedure.
 * Targets are not foreign keys; a deleted SLO simply stops being listed.
 *
 * Scorecard evaluation keeps the **current** result per (scorecard, service)
 * in `scorecard_results`, which is also the claim column for the level-drop
 * alert (a conditional update on `level`, so N replicas announce one drop
 * once), and one row per UTC day in `scorecard_history`.
 *
 * Lives in its own module (importing only `core-schema.js` and the
 * satellites it references) and is re-exported from `schema.ts`.
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  doublePrecision,
  jsonb,
  timestamp,
  date,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  ScorecardCheck,
  ScorecardCheckResult,
  ScorecardLevel,
  ServiceLink,
  ServiceMembershipRule,
} from "@infrawrench/client-core";

import { accounts, organizations, users } from "./core-schema.js";
import { onCallSchedules } from "./on-call-schema.js";

export const services = pgTable(
  "services",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** URL- and CLI-friendly handle, unique per org. */
    slug: text("slug").notNull(),
    description: text("description"),
    /** 1 (most critical) to 4; null when untiered. */
    tier: integer("tier"),
    /** Free-text owning team: display-only, never routed. */
    ownerTeam: text("owner_team"),
    links: jsonb("links").$type<ServiceLink[]>().notNull().default([]),
    /** Set null when the schedule is deleted: the service outlives its rota. */
    onCallScheduleId: text("on_call_schedule_id").references(() => onCallSchedules.id, {
      onDelete: "set null",
    }),
    rules: jsonb("rules").$type<ServiceMembershipRule[]>().notNull().default([]),
    monthlyBudget: doublePrecision("monthly_budget"),
    budgetCurrency: text("budget_currency"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("services_org_idx").on(t.organizationId),
    orgSlugUnique: uniqueIndex("services_org_slug_unique").on(t.organizationId, t.slug),
    orgNameUnique: uniqueIndex("services_org_name_unique").on(t.organizationId, t.name),
    tierRange: check("services_tier_range", sql`${t.tier} IS NULL OR ${t.tier} BETWEEN 1 AND 4`),
  }),
);

/** Routable owners. Cascades with the user: an ex-member owns nothing. */
export const serviceOwners = pgTable(
  "service_owners",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serviceId, t.userId] }),
    userIdx: index("service_owners_user_idx").on(t.userId),
  }),
);

export const serviceMembers = pgTable(
  "service_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Not a FK: see the module note. */
    resourceId: text("resource_id").notNull(),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    /** Denormalized so a member that disappeared upstream still has a name. */
    resourceName: text("resource_name").notNull(),
    /** "include" (picked by hand) | "exclude" (a rule matched it; it does not belong). */
    mode: text("mode").$type<"include" | "exclude">().notNull().default("include"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    serviceResourceUnique: uniqueIndex("service_members_service_resource_unique").on(
      t.serviceId,
      t.resourceId,
    ),
    orgResourceIdx: index("service_members_org_resource_idx").on(t.organizationId, t.resourceId),
    accountIdx: index("service_members_account_idx").on(t.accountId),
    modeAllowed: check("service_members_mode_allowed", sql`${t.mode} IN ('include', 'exclude')`),
  }),
);

export const serviceLinks = pgTable(
  "service_links",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** "slo" | "runbook" */
    kind: text("kind").$type<"slo" | "runbook">().notNull(),
    /** `slos.id` / `runbooks.id`. Not a FK: see the module note. */
    targetId: text("target_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.serviceId, t.kind, t.targetId] }),
    orgTargetIdx: index("service_links_org_target_idx").on(t.organizationId, t.kind, t.targetId),
    kindAllowed: check("service_links_kind_allowed", sql`${t.kind} IN ('slo', 'runbook')`),
  }),
);

export const scorecards = pgTable(
  "scorecards",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    checks: jsonb("checks").$type<ScorecardCheck[]>().notNull().default([]),
    /** Sorted lowest first on write. */
    levels: jsonb("levels").$type<ScorecardLevel[]>().notNull().default([]),
    /** Tiers (1-4) the scorecard applies to; empty means every service. */
    applicableTiers: jsonb("applicable_tiers").$type<number[]>().notNull().default([]),
    alertOnLevelDrop: boolean("alert_on_level_drop").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    /** The one seeded for the org. Informational: it is edited and deleted like any other. */
    isDefault: boolean("is_default").notNull().default(false),
    lastEvaluatedAt: timestamp("last_evaluated_at"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("scorecards_org_idx").on(t.organizationId),
    orgNameUnique: uniqueIndex("scorecards_org_name_unique").on(t.organizationId, t.name),
  }),
);

export const scorecardResults = pgTable(
  "scorecard_results",
  {
    scorecardId: text("scorecard_id")
      .notNull()
      .references(() => scorecards.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 0-100; null when no check applied. */
    score: doublePrecision("score"),
    /** Level key; null below the lowest level. The level-drop claim column. */
    level: text("level"),
    checkResults: jsonb("check_results").$type<ScorecardCheckResult[]>().notNull().default([]),
    evaluatedAt: timestamp("evaluated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scorecardId, t.serviceId] }),
    orgIdx: index("scorecard_results_org_idx").on(t.organizationId),
    serviceIdx: index("scorecard_results_service_idx").on(t.serviceId),
  }),
);

export const scorecardHistory = pgTable(
  "scorecard_history",
  {
    scorecardId: text("scorecard_id")
      .notNull()
      .references(() => scorecards.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** UTC day; the last evaluation of the day wins. */
    day: date("day", { mode: "string" }).notNull(),
    score: doublePrecision("score"),
    level: text("level"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.scorecardId, t.serviceId, t.day] }),
    serviceDayIdx: index("scorecard_history_service_day_idx").on(t.serviceId, t.day),
  }),
);

/**
 * One row per org: the seeding marker and the evaluation claim.
 *
 * `default_seeded_at` is what stops a default scorecard the org deleted from
 * coming back: seeding happens once, on first read or at org creation.
 * `next_eval_at` is the due time **and** the lease, the metric-alert
 * protocol: the pass pushes it forward in the claiming statement.
 */
export const orgScorecardSettings = pgTable("org_scorecard_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  defaultSeededAt: timestamp("default_seeded_at"),
  nextEvalAt: timestamp("next_eval_at"),
  lastEvalAt: timestamp("last_eval_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
