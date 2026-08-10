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
    /**
     * Dedupe key for budget triggers: `"<YYYY-MM>:<metric>:<percent>"` of the
     * crossing that last fired. A conditional UPDATE on this column is what
     * makes a budget trigger fire exactly once per month across competing
     * poller replicas — and re-arms immediately when the threshold is edited.
     */
    budgetLastFiredKey: text("budget_last_fired_key"),
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
 * Cooldown state for `infra.page(...)`, one row per (workflow, page key).
 *
 * A monitoring cron finds the same problem on every tick, so paging is
 * throttled per key rather than per run. `lastPagedAt` is only advanced when a
 * page is actually sent, and the send is gated by a conditional upsert on this
 * row — that single statement is what keeps two poller replicas racing the same
 * workflow from double-paging. `infra.page.clear(key)` deletes the row so a
 * recovered-then-recurring condition alerts again immediately.
 */
export const workflowPages = pgTable(
  "workflow_pages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** The author-chosen throttle key; "default" when unspecified. */
    key: text("key").notNull(),
    /** When this key last delivered a page — the start of its cooldown. */
    lastPagedAt: timestamp("last_paged_at").notNull().defaultNow(),
    /** The message that was sent, for the run log and the settings UI. */
    lastMessage: text("last_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    workflowKeyUnique: uniqueIndex("workflow_pages_workflow_key_unique").on(t.workflowId, t.key),
    orgIdx: index("workflow_pages_org_idx").on(t.organizationId),
  }),
);

/**
 * A human-approval gate raised by `infra.waitForApproval(...)` inside a run.
 *
 * The run's worker inserts a `pending` row, notifies the org, and then polls
 * this row until a decision lands or `expiresAt` passes (which counts as a
 * denial). The decision endpoints flip `status` with a conditional UPDATE
 * (`status = 'pending' AND expires_at > now()`), so two members racing the
 * same request produce exactly one decision.
 */
export const workflowApprovals = pgTable(
  "workflow_approvals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    /** The run that is suspended on this request. */
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    /** Short headline for the approval card (defaults to the workflow name). */
    title: text("title").notNull(),
    /** What the approver is deciding. */
    message: text("message").notNull(),
    /** "pending" | "approved" | "denied" | "expired" */
    status: text("status").notNull().default("pending"),
    /** When the pending request is treated as denied. */
    expiresAt: timestamp("expires_at").notNull(),
    decidedAt: timestamp("decided_at"),
    decidedByUserId: text("decided_by_user_id"),
    /** Display name/email snapshot of the decider, for the run log and UI. */
    decidedByName: text("decided_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgStatusIdx: index("workflow_approvals_org_status_idx").on(t.organizationId, t.status),
    runIdx: index("workflow_approvals_run_idx").on(t.runId),
    workflowIdx: index("workflow_approvals_workflow_idx").on(t.workflowId),
  }),
);

/**
 * One `infra.ai(...)` call's token usage and billable cost. The AI-chat
 * equivalent is `chat_usage`; kept as its own table because chat rows hang off
 * a conversation/message, which a workflow run doesn't have. The org's monthly
 * AI spend cap sums both tables plus in-flight {@link aiSpendReservations}
 * (see ../billing/ai-usage.ts).
 *
 * `workflow_id` and `run_id` are plain columns, not foreign keys, on purpose:
 * these are billing records, and deleting a workflow (or pruning its runs) must
 * not delete the spend it caused — an org could otherwise reset its free tier
 * by deleting the workflow that spent it.
 */
export const workflowAiUsage = pgTable(
  "workflow_ai_usage",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").notNull(),
    runId: text("run_id"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    /** Total billable cost in micro-dollars after markup. */
    costMicros: integer("cost_micros").notNull(),
    /** Stripe meter-event identifier once reported; null until reported. */
    stripeUsageRecordId: text("stripe_usage_record_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index("workflow_ai_usage_org_created_idx").on(t.organizationId, t.createdAt),
    unreportedIdx: index("workflow_ai_usage_unreported_idx").on(t.stripeUsageRecordId),
  }),
);

/**
 * In-flight hold on an org's monthly AI spend pool. Chat turns and workflow
 * `infra.ai()` calls both insert here under an org advisory lock before talking
 * to a provider, so concurrent consumers cannot all clear the same below-cap
 * check. `expiresAt` is pushed forward while the call is still running
 * (see `touchAiSpendReservation`); a process that dies mid-call stops
 * refreshing and the row is purged so it cannot permanently block the org.
 */
export const aiSpendReservations = pgTable(
  "ai_spend_reservations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    estimatedCostMicros: integer("estimated_cost_micros").notNull(),
    /** When this hold stops counting; refreshed by long-running callers. */
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgExpiresIdx: index("ai_spend_reservations_org_expires_idx").on(t.organizationId, t.expiresAt),
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
