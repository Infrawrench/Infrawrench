/**
 * Workflows schema (TypeScript automations run in a V8/WASM isolate).
 *
 * Kept in its own module with self-contained imports; re-exported from schema.ts
 * so Drizzle + `@infrawrench/server-core/db/schema` consumers pick it up.
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

import { organizations, dashboards } from "./core-schema.js";

export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** The user-authored TypeScript source. */
    source: text("source").notNull().default(""),
    /** WorkflowTrigger JSON: { kind: "manual" | "cron" | "git", ... } */
    trigger: jsonb("trigger").notNull().default({ kind: "manual" }),
    /** MetricDef[] declared in the UI; surfaced in generated typings. */
    metricDefs: jsonb("metric_defs").notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    /** Shared secret used to match inbound git/webhook triggers (web only). */
    webhookToken: text("webhook_token"),
    /**
     * HMAC secret the git provider signs delivery bodies with. When set, an
     * unsigned or badly-signed delivery is rejected — the token alone is not
     * enough. Null on workflows created before signing existed, and on
     * providers that don't sign.
     */
    webhookSecret: text("webhook_secret"),
    /** Last commit SHA the github-watcher saw for a git trigger's repo/branch. */
    gitLastSha: text("git_last_sha"),
    /** Next scheduled run for cron triggers (poller picks these up). */
    nextRunAt: timestamp("next_run_at"),
    lastRunAt: timestamp("last_run_at"),
    createdByUserId: text("created_by_user_id"),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("workflows_org_idx").on(t.organizationId),
    dueIdx: index("workflows_due_idx").on(t.nextRunAt),
    webhookIdx: index("workflows_webhook_idx").on(t.webhookToken),
  }),
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** "pending" | "running" | "success" | "failure" | "canceled" */
    status: text("status").notNull().default("pending"),
    /** "manual" | "cron" | "git" | "api" */
    triggerSource: text("trigger_source").notNull().default("manual"),
    logs: jsonb("logs").notNull().default([]),
    output: jsonb("output"),
    error: jsonb("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    durationMs: integer("duration_ms"),
    syncVersion: integer("sync_version").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    workflowIdx: index("workflow_runs_workflow_idx").on(t.workflowId),
    orgIdx: index("workflow_runs_org_idx").on(t.organizationId),
  }),
);

export const workflowMetrics = pgTable(
  "workflow_metrics",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    /** "number" | "string" | "boolean" */
    type: text("type").notNull().default("number"),
    unit: text("unit"),
    /** Current value as JSON (number | string | boolean | null). */
    value: jsonb("value"),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    workflowKeyIdx: uniqueIndex("workflow_metrics_workflow_key_idx").on(t.workflowId, t.key),
  }),
);

/**
 * A GitHub App installation connected to an org. The github-watcher uses the
 * installation id to mint short-lived installation tokens (acting as the app /
 * bot) to list repos and read branch heads. Repos a workflow watches are stored
 * on the workflow's git trigger (jsonb); this row authorizes access to them.
 */
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** GitHub's numeric installation id. */
    installationId: integer("installation_id").notNull(),
    /** The account the app is installed on (org or user login). */
    accountLogin: text("account_login"),
    accountType: text("account_type"),
    createdByUserId: text("created_by_user_id"),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("github_installations_org_idx").on(t.organizationId),
    installationIdx: uniqueIndex("github_installations_installation_idx").on(t.installationId),
  }),
);

/**
 * Pins a workflow onto a dashboard so its metrics render as a card. Mirrors
 * `dashboardPins` (resource pins) but points at a workflow.
 */
export const dashboardWorkflowPins = pgTable(
  "dashboard_workflow_pins",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    gridX: integer("grid_x").notNull().default(0),
    syncVersion: integer("sync_version").notNull().default(0),
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    dashboardWorkflowPinUnique: uniqueIndex("dashboard_workflow_pin_unique").on(
      t.dashboardId,
      t.workflowId,
    ),
    dashboardWorkflowPinDashboardIdx: index("dashboard_workflow_pin_dashboard_idx").on(
      t.dashboardId,
    ),
  }),
);
