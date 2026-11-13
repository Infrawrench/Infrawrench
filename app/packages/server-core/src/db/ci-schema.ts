/**
 * CI (`ci-runner/`, reached through `app/packages/ci-proxy`): which GitHub
 * accounts an organization runs CI for, every run and its approval, and the
 * usage each run and each hour of cache storage is billed for.
 *
 * Lives in its own module and is re-exported from `schema.ts`, the
 * satellite-schema convention.
 */
import {
  type AnyPgColumn,
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

import type { CiEvent } from "@infrawrench/client-core";

import { accounts, organizations, users } from "./core-schema.js";

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
  | "awaiting_approval"
  | "queued"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "error"
  | "rejected"
  | "cancelled";

/**
 * One pipeline a run triggers, as the runners read it before the run starts
 * (`POST /v1/concurrency`), with its `concurrency:` group. Every triggered
 * pipeline is listed, grouped or not, so a run whose grouped pipelines are
 * all cancelled before it starts is known to have nothing left to run.
 */
export interface CiConcurrencyEntry {
  /** The pipeline file, as the runner names it in the run's report. */
  file: string;
  /** The pipeline's `name:`. */
  pipeline: string;
  /** As the runner substituted it; compared lowercased (groups ignore case). */
  group: string | null;
  cancelInProgress: boolean;
  /** Cancelled by a newer run of its group. */
  cancelled?: boolean;
  /** The runner has been told (or a run that never started needs no telling). */
  cancelSent?: boolean;
}

/**
 * One job's references to things the organization lends CI, as the runners'
 * `POST /v1/concurrency` answer names them (per job key, not per matrix entry).
 */
export interface CiJobAccess {
  pipeline: string;
  job: string;
  connections?: Array<{ name: string; namespace?: string }>;
  sshKeys?: string[];
  /** Grant CI name to the outputs the job reads. */
  resources?: Record<string, string[]>;
  envFrom?: string[];
  cloud?: Record<string, string>;
}

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
    event: text("event").$type<CiEvent>().notNull(),
    /**
     * A scheduled run's pipeline: the file whose `on.schedule` fired, and
     * its text as read from `sha`, which the runner runs instead of the
     * commit's other pipelines. Null for pushes and pull requests.
     */
    pipelineFile: text("pipeline_file"),
    pipelineText: text("pipeline_text"),
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
    /** The run this one retries: same commit, branch and event. */
    retryOfRunId: text("retry_of_run_id").references((): AnyPgColumn => ciRuns.id, {
      onDelete: "set null",
    }),
    /** Run every `task-cache:` job rather than replay a passing run's entry. */
    noTaskCache: boolean("no_task_cache").notNull().default(false),
    /**
     * Its pipelines and their `concurrency:` groups, read before dispatch;
     * null until then. A run holds its groups from the moment it is admitted
     * (queued with this set, or running) until it ends.
     */
    concurrency: jsonb("concurrency").$type<CiConcurrencyEntry[]>(),
    /**
     * What each of its jobs names to be lent (`connections:`, `ssh-keys:`,
     * `resources.*`, `env-from:`) and its `cloud:` block, read with its
     * pipelines before dispatch; null until then, and for runs from before.
     */
    access: jsonb("access").$type<CiJobAccess[]>(),
    /** Someone asked to cancel the whole run, and when the runner was told. */
    cancelRequestedAt: timestamp("cancel_requested_at"),
    cancelSentAt: timestamp("cancel_sent_at"),
    status: text("status").$type<CiRunStatus>().notNull(),
    /** Why a run errored or was rejected. */
    statusReason: text("status_reason"),
    /** Unique per delivery target, so a redelivered webhook makes no second run. */
    dedupeKey: text("dedupe_key").notNull(),
    proxyRunId: text("proxy_run_id"),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    /**
     * One GitHub check per job key, beside the run's own: by
     * `${pipeline}\u0000${key}`, its check run id and the state last sent,
     * so a poll only calls GitHub for a job whose state changed.
     */
    jobChecks: jsonb("job_checks")
      .$type<Record<string, { id: number; sent: string }>>()
      .notNull()
      .default({}),
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
    retryOfIdx: index("ci_runs_retry_of_idx").on(t.retryOfRunId),
    repoStatusIdx: index("ci_runs_repo_status_idx").on(t.installationId, t.repoFullName, t.status),
  }),
);

/** One pipeline file with `on.schedule`, as the runners read it. */
export interface CiScheduleEntry {
  file: string;
  name: string;
  cron: string[];
  /** The file's text at `ci_schedules.sha`, sent with each scheduled run. */
  text: string;
}

/**
 * A repository's `on.schedule` pipelines on its default branch, which the
 * `ci` poller pass fires (the runners keep no clock). A row appears with the
 * first push to the default branch the app sees, is re-read on every later
 * one (and hourly while it schedules anything, in case a webhook was lost),
 * and goes when a read finds the repository gone.
 */
export const ciSchedules = pgTable(
  "ci_schedules",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    /** `owner/name`, as GitHub spells it. */
    repoFullName: text("repo_full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    /** The default branch's head the pipelines were read from; null before the first read. */
    sha: text("sha"),
    pipelines: jsonb("pipelines").$type<CiScheduleEntry[]>().notNull().default([]),
    /** Why the last read failed, or which files did not parse. */
    error: text("error"),
    /** When to read the default branch again; a push sets it to now. */
    refreshAfter: timestamp("refresh_after").notNull().defaultNow(),
    refreshedAt: timestamp("refreshed_at"),
    /** The last read that succeeded: a repository unreadable for a day is dropped. */
    readOkAt: timestamp("read_ok_at"),
    /** Every minute up to this one has been fired; null before the first fire pass. */
    firedThrough: timestamp("fired_through"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    repoIdx: uniqueIndex("ci_schedules_repo_idx").on(t.installationId, t.repoFullName),
    orgIdx: index("ci_schedules_org_idx").on(t.organizationId),
    refreshIdx: index("ci_schedules_refresh_idx").on(t.refreshAfter),
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

/**
 * What an organization lets CI do with one connection: run jobs on it (cloud
 * jobs, `cloud:` in a pipeline), lend its credentials to jobs (`connections:`),
 * or both. Off unless a row turns it on. A null repository list means every
 * repository the organization runs CI for; a branch pattern narrows it to
 * branches that match (`main`, `release/*`).
 */
export const ciConnectionAccess = pgTable(
  "ci_connection_access",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    jobsEnabled: boolean("jobs_enabled").notNull().default(false),
    /** The kinds (`vm`, `container`, ...) jobs may use; the plugin declares which exist. */
    jobKinds: jsonb("job_kinds").$type<string[]>().notNull().default([]),
    maxConcurrentJobs: integer("max_concurrent_jobs").notNull().default(2),
    maxJobMinutes: integer("max_job_minutes").notNull().default(60),
    jobRepos: jsonb("job_repos").$type<string[] | null>(),
    jobBranchPattern: text("job_branch_pattern"),
    /** The last preflight per kind, as the plugin answered it. */
    jobPreflight: jsonb("job_preflight")
      .$type<
        Record<
          string,
          {
            ok: boolean;
            missing: Array<{ permission: string; label: string }>;
            problems: string[];
            region?: string;
            checkedAt: string;
          }
        >
      >()
      .notNull()
      .default({}),
    lendEnabled: boolean("lend_enabled").notNull().default(false),
    lendRepos: jsonb("lend_repos").$type<string[] | null>(),
    lendBranchPattern: text("lend_branch_pattern"),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: uniqueIndex("ci_connection_access_account_idx").on(t.accountId),
    orgIdx: index("ci_connection_access_org_idx").on(t.organizationId),
  }),
);

/**
 * One resource CI jobs may read, granted one by one: `${{ resources.<ciName>.<output> }}`
 * and `env-from: [<ciName>]`. Only the ticked outputs (or the secret's value, for
 * a secret-manager resource) are read, fresh at each dispatch.
 */
export const ciResourceGrants = pgTable(
  "ci_resource_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The resource's id as the plugin lists it; not a foreign key, since syncs replace rows. */
    resourceId: text("resource_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    resourceName: text("resource_name").notNull(),
    /** The name a pipeline uses: `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, unique in the organization. */
    ciName: text("ci_name").notNull(),
    outputs: jsonb("outputs").$type<string[]>().notNull().default([]),
    /**
     * For a secret-manager resource: `latest` (the newest enabled version) or a
     * version id, read as the output `value`. Null when it grants no secret value.
     */
    secretVersion: text("secret_version"),
    repos: jsonb("repos").$type<string[] | null>(),
    branchPattern: text("branch_pattern"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Who last changed it (widened it, perhaps): the audit names them as who allowed a read. */
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgNameIdx: uniqueIndex("ci_resource_grants_org_name_idx").on(t.organizationId, t.ciName),
    accountIdx: index("ci_resource_grants_account_idx").on(t.accountId),
  }),
);

export type CiCloudJobState = "claiming" | "starting" | "running" | "tearing_down" | "done";

/**
 * One cloud job (`cloud:` in a pipeline) the executor claimed: where it runs,
 * the plugin's handle to it, and how far teardown has got. The claim's secret
 * part (the claim token, the job's env and files) is kept encrypted only until
 * the job ends; the machine fetches it with its own token, of which only a hash
 * is kept.
 */
export const ciCloudJobs = pgTable(
  "ci_cloud_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => ciRuns.id, { onDelete: "cascade" }),
    proxyRunId: text("proxy_run_id").notNull(),
    /** The runner's job id (`build[app/web]` for a matrix entry). */
    jobId: text("job_id").notNull(),
    jobName: text("job_name").notNull(),
    pipeline: text("pipeline").notNull(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    pluginId: text("plugin_id").notNull(),
    kind: text("kind").notNull(),
    machine: text("machine"),
    image: text("image"),
    region: text("region"),
    state: text("state").$type<CiCloudJobState>().notNull(),
    /** How the job ended, once it has: `passed`, `failed`, `error`, `cancelled`, `lost`, `timed-out`. */
    outcome: text("outcome"),
    reason: text("reason"),
    /** The plugin's handle (`CiHandle`), once it started something. */
    handle: jsonb("handle").$type<{
      id: string;
      region?: string;
      label: string;
      data?: Record<string, string>;
    }>(),
    /** SHA-256 of the machine's callback token. */
    callbackTokenHash: text("callback_token_hash").notNull(),
    /** AES-GCM: the claim token, env, files and transfer URLs. Cleared when the job ends. */
    encryptedClaim: text("encrypted_claim"),
    claimIv: text("claim_iv"),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    /** When the machine last called back. */
    lastSeenAt: timestamp("last_seen_at"),
    claimedAt: timestamp("claimed_at").notNull().defaultNow(),
    finishedAt: timestamp("finished_at"),
    /** Claims that failed for a passing reason (the proxy busy, the network). */
    claimAttempts: integer("claim_attempts").notNull().default(0),
    teardownAttempts: integer("teardown_attempts").notNull().default(0),
    teardownError: text("teardown_error"),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    runJobIdx: uniqueIndex("ci_cloud_jobs_run_job_idx").on(t.proxyRunId, t.jobId),
    tokenIdx: uniqueIndex("ci_cloud_jobs_token_idx").on(t.callbackTokenHash),
    stateIdx: index("ci_cloud_jobs_state_idx").on(t.state, t.nextAttemptAt),
    accountIdx: index("ci_cloud_jobs_account_idx").on(t.accountId, t.state),
  }),
);
