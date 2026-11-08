/**
 * CI (`ci-runner/`, reached through `app/packages/ci-proxy`): which GitHub
 * accounts an organization runs CI for, every run and its approval, and the
 * usage each run and each hour of cache storage is billed for.
 *
 * Lives in its own module and is re-exported from `schema.ts`, the
 * satellite-schema convention.
 */
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * A connected GitHub App installation (a GitHub organization or user) whose
 * repositories run CI. The installation itself is the org's
 * `github_installations` row; this row is the choice to run CI for it.
 */
export const ciAccounts = pgTable(
  "ci_accounts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    enabledByUserId: text("enabled_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    installationIdx: uniqueIndex("ci_accounts_installation_idx").on(t.installationId),
    orgIdx: index("ci_accounts_org_idx").on(t.organizationId),
  }),
);

export type CiRunStatus =
  "awaiting_approval" | "queued" | "running" | "passed" | "failed" | "error" | "rejected";

/** One run of a repository's pipelines for a push or a pull request. */
export const ciRuns = pgTable(
  "ci_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    /** `owner/name`. */
    repoFullName: text("repo_full_name").notNull(),
    /** The runner's owner key for storage, caches and usage: `github.com-<login>`. */
    ownerKey: text("owner_key").notNull(),
    /** The runner's repository id: the repository's name. */
    repoKey: text("repo_key").notNull(),
    event: text("event").$type<"push" | "pull-request">().notNull(),
    /** The branch, or `pull/<n>` for a pull request (its cache scope). */
    branch: text("branch").notNull(),
    /** The head branch's own name, for display. */
    headRef: text("head_ref").notNull(),
    /** The repository's default branch: a push to it saves caches the others read. */
    defaultBranch: text("default_branch").notNull(),
    sha: text("sha").notNull(),
    baseSha: text("base_sha"),
    pullNumber: integer("pull_number"),
    /** Where a pull request's head lives when it is not this repository. */
    headRepoFullName: text("head_repo_full_name"),
    /** A pull request from a fork: needs a maintainer's approval and never gets secrets. */
    fromFork: boolean("from_fork").notNull().default(false),
    /** Who opened the pull request or pushed. */
    actorLogin: text("actor_login"),
    status: text("status").$type<CiRunStatus>().notNull(),
    /** Why a run errored or was rejected. */
    statusReason: text("status_reason"),
    /** Unique per delivery target, so a redelivered webhook makes no second run. */
    dedupeKey: text("dedupe_key").notNull(),
    proxyRunId: text("proxy_run_id"),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at"),
    /** Dispatch attempts while every runner was busy or unreachable. */
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    /** Jobs and their statuses once finished, for the list (`CiJobSummary[]`). */
    jobs: jsonb("jobs").$type<unknown[]>(),
    vcpuSeconds: doublePrecision("vcpu_seconds"),
    memoryGibSeconds: doublePrecision("memory_gib_seconds"),
    /** Set once the run's usage has been sent to the Stripe meters. */
    usageReportedAt: timestamp("usage_reported_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    dedupeIdx: uniqueIndex("ci_runs_dedupe_idx").on(t.dedupeKey),
    orgCreatedIdx: index("ci_runs_org_created_idx").on(t.organizationId, t.createdAt),
    statusIdx: index("ci_runs_status_idx").on(t.status, t.nextAttemptAt),
  }),
);

/**
 * An hour of an owner's cache storage, sampled from the runners and sent to
 * the storage meter once. Unique per owner and hour, so a repeated sample
 * cannot bill an hour twice.
 */
export const ciStorageSamples = pgTable(
  "ci_storage_samples",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerKey: text("owner_key").notNull(),
    hour: timestamp("hour").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    reportedAt: timestamp("reported_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    ownerHourIdx: uniqueIndex("ci_storage_samples_owner_hour_idx").on(t.ownerKey, t.hour),
  }),
);
