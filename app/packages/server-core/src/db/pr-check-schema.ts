import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PrCheckReport } from "@infrawrench/client-core";

import { organizations } from "./core-schema.js";

/**
 * Pull request checks: cost and blast radius posted as a GitHub check run on
 * infrastructure pull requests, through the org's existing GitHub App
 * installation (`github_installations`). One row per configured repository;
 * the github-watcher polls the enabled ones.
 *
 * A row per repository rather than one settings document, because each
 * repository is edited (and managed from Terraform) on its own and nothing
 * about one depends on another's position.
 */
export const prCheckRepositories = pgTable(
  "pr_check_repositories",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    installationId: integer("installation_id").notNull(),
    /** `owner/name`. */
    repo: text("repo").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    commentEnabled: boolean("comment_enabled").notNull().default(false),
    /** Monthly increase that trips `threshold_conclusion`; null never does. */
    costThreshold: doublePrecision("cost_threshold"),
    thresholdConclusion: text("threshold_conclusion").notNull().default("neutral"),
    /** Path prefixes to look in; empty is the whole repository. */
    directories: jsonb("directories").$type<string[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgRepoIdx: uniqueIndex("pr_check_repositories_org_repo_idx").on(t.organizationId, t.repo),
    conclusionValid: check(
      "pr_check_repositories_threshold_conclusion_valid",
      sql`${t.thresholdConclusion} IN ('neutral', 'failure')`,
    ),
  }),
);

/**
 * One analysed head commit of one pull request. The unique index on
 * (repository, pull, head sha) is the claim: a watcher replica inserts the
 * row before doing any work, so a commit is checked exactly once however many
 * replicas see it. The comment id is carried forward from the previous run of
 * the same pull request so the summary comment is edited, never re-posted.
 */
export const prCheckRuns = pgTable(
  "pr_check_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => prCheckRepositories.id, { onDelete: "cascade" }),
    pullNumber: integer("pull_number").notNull(),
    pullTitle: text("pull_title"),
    pullUrl: text("pull_url"),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha"),
    status: text("status").notNull().default("running"),
    conclusion: text("conclusion"),
    checkRunId: bigint("check_run_id", { mode: "number" }),
    checkRunUrl: text("check_run_url"),
    commentId: bigint("comment_id", { mode: "number" }),
    commentUrl: text("comment_url"),
    report: jsonb("report").$type<PrCheckReport | null>(),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    claimIdx: uniqueIndex("pr_check_runs_claim_idx").on(t.repositoryId, t.pullNumber, t.headSha),
    orgCreatedIdx: index("pr_check_runs_org_created_idx").on(t.organizationId, t.createdAt),
    statusValid: check(
      "pr_check_runs_status_valid",
      sql`${t.status} IN ('running', 'completed', 'failed')`,
    ),
  }),
);
