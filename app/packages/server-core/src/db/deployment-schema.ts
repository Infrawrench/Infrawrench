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
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
    /** Which surface ran it: `web` or `cli`. */
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
    createdByUserId: text("created_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    // The history view is always "this org, newest first".
    index("deployment_runs_org_idx").on(table.organizationId, table.startedAt),
    index("deployment_runs_env_idx").on(table.organizationId, table.env),
  ],
);
