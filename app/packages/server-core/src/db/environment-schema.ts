import { pgTable, text, integer, timestamp, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";

import type {
  EnvironmentInstanceStatus,
  EnvironmentMemberStatus,
  EnvironmentParameter,
  EnvironmentTemplateMember,
} from "@infrawrench/client-core";

import { accounts, organizations, users } from "./core-schema.js";

/**
 * Ephemeral environments — the template half.
 *
 * A template is a **document**, not a set of rows: `members` and `parameters`
 * are jsonb (`EnvironmentTemplateMember[]` / `EnvironmentParameter[]` in
 * client-core) because the pure code that orders, validates and instantiates
 * them works on the whole document at once, and splitting it into tables would
 * mean reassembling it on every read while gaining no query we ever run. The
 * one thing we *do* query — "which templates does this org have" — is the org
 * index.
 *
 * A member names an account, but not with a FK: an account can be disconnected
 * while a template that mentions it is still worth keeping (the instantiate
 * form lets you point it somewhere else). The same reasoning as
 * `resource_leases.resource_id`, one level up.
 */
export const environmentTemplates = pgTable(
  "environment_templates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Fields the user chose to vary — `EnvironmentParameter[]`. */
    parameters: jsonb("parameters").$type<EnvironmentParameter[]>().notNull().default([]),
    /** The captured resources — `EnvironmentTemplateMember[]`. */
    members: jsonb("members").$type<EnvironmentTemplateMember[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("environment_templates_org_idx").on(t.organizationId),
    orgNameUnique: uniqueIndex("environment_templates_org_name_idx").on(t.organizationId, t.name),
  }),
);

/**
 * One stamped-out copy.
 *
 * The row is written **before** the first provider call and every member row
 * with it, so a run that dies half-way still leaves something that names the
 * resources it created. That is the single correctness property this feature
 * turns on: a create that succeeded and was never recorded is a cloud resource
 * nobody can find, and it keeps billing.
 *
 * `templateId` is nullable and set null on delete — the template is a
 * convenience, the instance owns real resources and must outlive it. Hence
 * `templateName` denormalized.
 *
 * There is no teardown pass here: `expiresAt` is written onto a
 * `resource_leases` row per member, so expiry runs through the existing lease
 * pass (two announcements, freeze-deferring, retries, audit) and the ordinary
 * delete path. This table only records what belongs together.
 */
export const environmentInstances = pgTable(
  "environment_instances",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => environmentTemplates.id, {
      onDelete: "set null",
    }),
    /** Template name at instantiation — survives the template's deletion. */
    templateName: text("template_name").notNull(),
    name: text("name").notNull(),
    /** Slug prepended to every member's name field. */
    namePrefix: text("name_prefix").notNull(),
    parameters: jsonb("parameters").$type<Record<string, string>>().notNull().default({}),
    /** "creating" | "active" | "partial" | "tearing-down" | "deleted" | "failed". */
    status: text("status").$type<EnvironmentInstanceStatus>().notNull().default("creating"),
    /** The TTL deadline every member lease is set to. */
    expiresAt: timestamp("expires_at").notNull(),
    note: text("note"),
    /** Why a partial/failed instance is in that state — never silent. */
    error: text("error"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    orgIdx: index("environment_instances_org_idx").on(t.organizationId),
    templateIdx: index("environment_instances_template_idx").on(t.templateId),
    expiresIdx: index("environment_instances_expires_idx").on(t.expiresAt),
  }),
);

/**
 * A member of a live instance — the row that stops a created resource ever
 * being orphaned.
 *
 * It is inserted `pending` before the create runs and updated to `created`
 * with its `resourceId` the instant the plugin returns, so the window in which
 * a resource exists with nothing pointing at it is one database write wide
 * rather than the whole rest of the run.
 *
 * `resourceId` is not a FK for the usual reason (sync churns `resources`), and
 * `leaseId` is not either: the lease row is replaced in place when a lease is
 * re-armed, so pointing at it hard would make a teardown fail on bookkeeping.
 */
export const environmentInstanceMembers = pgTable(
  "environment_instance_members",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => environmentInstances.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The template member key this row was created from. */
    memberKey: text("member_key").notNull(),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Null until the create returns — and after a create that failed. */
    resourceId: text("resource_id"),
    externalId: text("external_id"),
    displayName: text("display_name").notNull(),
    /** "pending" | "created" | "failed" | "deleted". */
    status: text("status").$type<EnvironmentMemberStatus>().notNull().default("pending"),
    error: text("error"),
    /** The `resource_leases` row that auto-deletes this member at the TTL. */
    leaseId: text("lease_id"),
    /**
     * Due time **and** claim lease for the background repair pass, following
     * the `resource_leases.next_check_at` protocol: null = due, and claiming
     * writes `now() + lease` so N poller replicas never repair one member
     * twice. Repair is not idempotent — it creates leases and can delete a
     * resource — so it has to be claimed rather than merely bounded.
     */
    nextRepairAt: timestamp("next_repair_at"),
    repairAttempts: integer("repair_attempts").notNull().default(0),
    /** Why the last repair attempt failed. Never logged-and-forgotten. */
    repairError: text("repair_error"),
    /** Creation order — the topological order the plan ran in. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    instanceIdx: index("environment_instance_members_instance_idx").on(t.instanceId),
    orgIdx: index("environment_instance_members_org_idx").on(t.organizationId),
    resourceIdx: index("environment_instance_members_resource_idx").on(t.resourceId),
    repairDueIdx: index("environment_instance_members_repair_due_idx").on(t.nextRepairAt),
  }),
);

/**
 * The org's rails on how long an ephemeral environment may live. A singleton
 * per org, absent until someone changes it — the reader normalizes a missing
 * row into the shipped defaults, so nothing has to seed it.
 */
export const environmentSettings = pgTable("environment_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Longest TTL an instantiation may ask for, in hours. */
  maxTtlHours: integer("max_ttl_hours").notNull(),
  /** Pre-filled TTL in the instantiate form, in hours. */
  defaultTtlHours: integer("default_ttl_hours").notNull(),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
