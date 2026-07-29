/**
 * Deployment history (Infrafile runs).
 *
 * Note what is *not* here: the Infrafile itself. It lives at the root of the
 * user's repository and is read fresh on every run — from disk by the CLI, from
 * git by the web app. Storing a copy would create a second source of truth that
 * silently drifts from the one in version control.
 *
 * What is stored is what happened: which environment, which commit, which
 * image, and the rendered Dockerfile — the last so a run is reproducible and
 * diffable without needing the repo state that produced it.
 *
 * Kept in its own module with self-contained imports; re-exported from schema.ts
 * so Drizzle + `@infrawrench/server-core/db/schema` consumers pick it up.
 */
import { sql } from "drizzle-orm";
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

import { organizations } from "./core-schema.js";

export const deploymentRuns = pgTable(
  "deployment_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Environment the Infrafile declared and this run targeted. */
    env: text("env").notNull(),
    /** `owner/name`. Null when a CLI run had no git remote. */
    repo: text("repo"),
    branch: text("branch"),
    gitSha: text("git_sha"),
    /** Fully-qualified image reference, once the build produced one. */
    image: text("image"),
    /** pending | running | success | failure | canceled */
    status: text("status").notNull().default("pending"),
    /** Which surface ran it: `web`, `cli`, or `trigger` (deploy-on-push). */
    origin: text("origin").notNull().default("web"),
    /** Last stage reached — plan | dockerfile | build | deploy. */
    stage: text("stage"),
    /** RunLogEntry[]. */
    logs: jsonb("logs").notNull().default([]),
    /** Whatever `plan()` returned. */
    planJson: jsonb("plan_json"),
    /** The *rendered* Dockerfile (stage 2's output), never the Infrafile. */
    dockerfile: text("dockerfile"),
    /** Notes the deploy stage emitted, newline-joined. */
    notes: text("notes"),
    /**
     * Whatever the run's `infra.output(...)` recorded — the queryable,
     * structured counterpart of `notes` (service URL, IPs); read back by
     * `infrawrench deploy outputs`.
     */
    output: jsonb("output_json"),
    /**
     * InfrafileCreatedResource[] — resources the run provisioned through
     * `infra.accounts.*.create(...)`. This is what lets a rollback offer to
     * undo the provisioning (`--delete-created`), not just re-ship the image.
     */
    createdResources: jsonb("created_resources").notNull().default([]),
    error: jsonb("error"),
    /**
     * Seconds of hosted build-worker time this run consumed. Null for a run
     * that built somewhere we don't pay for — the CLI's local daemon, or a
     * customer's own SSH host — so the column means "what it cost us", not
     * "how long it took".
     */
    buildSeconds: integer("build_seconds"),
    /** Which runner built it: `cloud-build`, `ssh`, or null when nothing built. */
    buildRunner: text("build_runner"),
    /**
     * Stripe meter-event identifier once build time was reported for billing.
     * Null with `build_seconds` set = consumed but unbilled — the rows a
     * replay job would look for, same arrangement as chat_usage.
     */
    meterEventId: text("meter_event_id"),
    createdByUserId: text("created_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    // The history view is always "this org, newest first".
    index("deployment_runs_org_idx").on(table.organizationId, table.startedAt),
    index("deployment_runs_env_idx").on(table.organizationId, table.env),
    /**
     * The per-environment deploy lock, enforced where it cannot race. The
     * application-level check reads then inserts, so two deploys arriving in
     * the same window both see zero running rows and both proceed — this index
     * makes the second insert conflict instead. Partial on `running` so
     * history rows (and plan-only previews, which start as `pending`) never
     * collide.
     */
    uniqueIndex("deployment_runs_one_running")
      .on(table.organizationId, table.env)
      .where(sql`${table.status} = 'running'`),
  ],
);

/**
 * "Deploy this repo's environment when that branch moves."
 *
 * This is config, not source — which is why it can live in the database while
 * the Infrafile deliberately cannot. The trigger says *when*; the Infrafile at
 * the branch head still says *what*, read fresh on every run.
 */
export const deploymentTriggers = pgTable(
  "deployment_triggers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `owner/name`. */
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    /** Environment to deploy. Must be one the Infrafile declares at run time. */
    env: text("env").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Answers for `select(key, …)`. A triggered deploy has nobody to ask, so a
     * key without an answer here fails the run naming it — the same contract
     * `--set` gives the CLI.
     */
    answers: jsonb("answers").$type<Record<string, string>>().notNull().default({}),
    /**
     * Last commit seen on the branch. First sight records it WITHOUT deploying:
     * enabling a trigger should not ship whatever happens to be at HEAD.
     */
    lastSha: text("last_sha"),
    /**
     * When this trigger last fired. Informational — the `lastSha` conditional
     * update is what serializes claims, and nothing reads this as a guard.
     */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("deployment_triggers_org_idx").on(table.organizationId),
    // The watcher sweeps enabled triggers across every org each tick.
    index("deployment_triggers_enabled_idx").on(table.enabled),
    // One trigger per destination; re-adding the same one updates it.
    uniqueIndex("deployment_triggers_unique").on(
      table.organizationId,
      table.repo,
      table.branch,
      table.env,
    ),
  ],
);
