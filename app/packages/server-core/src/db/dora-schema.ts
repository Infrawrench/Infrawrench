/**
 * DORA metrics: the three tables the Delivery page reads beside the ones it
 * joins (`deployment_runs`, `incidents`, `resource_changes`).
 *
 * `deploy_events` is a **record**, not a cache. A provider's listing keeps a
 * handful of recent deploys (Netlify five per site, Render ten per service),
 * so the synced `resources` rows of a deploy type roll over within days; the
 * metrics need months. Each row is written when sync first sees the deploy and
 * updated while it moves (building to ready), and nothing deletes it but the
 * account cascade and retention. Infrafile runs are deliberately **not** copied
 * in: `deployment_runs` is already a durable record and is read directly.
 *
 * Kept in its own module with self-contained imports; re-exported from
 * schema.ts so Drizzle picks it up.
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

import { accounts, organizations, users } from "./core-schema.js";

export const deployEvents = pgTable(
  "deploy_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `plugin` (a synced deploy row), `github` (the GitHub App) or `api` (pushed in). */
    source: text("source").$type<"plugin" | "github" | "api">().notNull(),
    /**
     * Unique per org: the deploy's resource id for `plugin`, `<repo>#<id>` for
     * `github`, the caller's id for `api`. Re-seeing a deploy updates its row.
     */
    externalKey: text("external_key").notNull(),
    /** Null for `github`/`api`; cascades so disconnecting an account removes its history. */
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id"),
    resourceTypeId: text("resource_type_id"),
    /** The deploy's own resource id. Not a FK: the deploy outlives the synced row. */
    resourceId: text("resource_id"),
    /** The project/service/site resource the deploy belongs to. Not a FK, same reason. */
    targetResourceId: text("target_resource_id"),
    kind: text("kind").$type<"deployment" | "pipeline">().notNull().default("deployment"),
    name: text("name").notNull(),
    environment: text("environment"),
    /** Normalized to `owner/name` where it is a GitHub/GitLab/Bitbucket URL. */
    repository: text("repository"),
    commitSha: text("commit_sha"),
    /** When the provider said when the commit was authored; else `dora_commit_times` resolves it. */
    commitAt: timestamp("commit_at", { withTimezone: true }),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull(),
    status: text("status").$type<"success" | "failure" | "in_progress" | "canceled">().notNull(),
    isRollback: boolean("is_rollback").notNull().default(false),
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("deploy_events_org_key_unique").on(t.organizationId, t.externalKey),
    // Every read is "this org, this window".
    index("deploy_events_org_deployed_idx").on(t.organizationId, t.deployedAt),
    index("deploy_events_account_idx").on(t.accountId),
  ],
);

/**
 * Commit authored-at times, looked up once per (repository, SHA) through the
 * org's GitHub App installation, so lead time works for every source that
 * names a commit but not its time (which is all of them but Render).
 * `committed_at` null with `checked_at` set means "asked, nobody could say":
 * the lookup is never repeated, which is what keeps a repository the App
 * cannot see from costing a request every tick.
 */
export const doraCommitTimes = pgTable(
  "dora_commit_times",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repository: text("repository").notNull(),
    /** As the deploy named it, which may be abbreviated. */
    commitSha: text("commit_sha").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dora_commit_times_unique").on(t.organizationId, t.repository, t.commitSha)],
);

/**
 * The org's DORA settings singleton. A missing row means the shipped
 * defaults (`DORA_SETTINGS_DEFAULTS` in client-core).
 */
export const orgDoraSettings = pgTable("org_dora_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  failureWindowHours: integer("failure_window_hours").notNull().default(24),
  productionEnvironments: jsonb("production_environments").$type<string[]>().notNull(),
  pipelinePatterns: jsonb("pipeline_patterns").$type<string[]>().notNull(),
  countFailedDeploys: boolean("count_failed_deploys").notNull().default(false),
  includeResourceChanges: boolean("include_resource_changes").notNull().default(false),
  digestEnabled: boolean("digest_enabled").notNull().default(true),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
