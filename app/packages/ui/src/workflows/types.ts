/** Shared UI-side shapes for workflows. Kept decoupled from server types. */

/**
 * A value a prompt can resolve to. Mirrors the runtime's `MetricValue`; `null`
 * means the user dismissed the prompt.
 *
 * Declared here rather than imported from `@infrawrench/workflow-runtime`
 * because this package must not depend on the sandbox — its main entry pulls in
 * QuickJS, and keeping that out of the browser bundle is load-bearing.
 */
export type MetricValue = number | string | boolean | null;

/**
 * A request for input raised by `infra.prompt(...)`, or by an Infrafile's
 * `select(...)` (which routes through the same host method). Mirrors the
 * runtime's `PromptSpec`.
 */
export interface PromptSpec {
  message: string;
  /** Input shape to render. Defaults to "text". `code` is a multiline editor. */
  kind?: "text" | "password" | "number" | "date" | "boolean" | "select" | "code";
  /** Options for `kind: "select"`. */
  options?: { label: string; value: string }[];
  defaultValue?: string;
}

export interface WorkflowMetricDef {
  key: string;
  label: string;
  type: "number" | "string" | "boolean";
  unit?: string;
}

/**
 * Loose shape of a workflow metric def as persisted (jsonb/text column) and
 * read back by dashboard pins. Older rows may carry `unit: null` and `type`
 * is unvalidated on this read path — see {@link WorkflowMetricDef} for the
 * strict editor-side shape.
 */
export interface StoredWorkflowMetricDef {
  key: string;
  label: string;
  unit?: string | null;
  type?: string;
}

export type WorkflowTrigger =
  | { kind: "manual" }
  | { kind: "cron"; expression: string; timezone?: string }
  | {
      kind: "git";
      provider?: string;
      repo?: string;
      branch?: string;
      events?: string[];
      installationId?: number;
    }
  | {
      kind: "budget";
      /** The budget being watched (`budgets.id`). */
      budgetId: string;
      /** Percentage of the budget amount that fires the run. Defaults to 100. */
      percent?: number;
      /** Compare month-to-date spend or the projected month-end total. */
      metric?: "actual" | "forecast";
    };

/** A budget the workflow panel can offer as a trigger source (cloud only). */
export interface BudgetOption {
  id: string;
  name: string;
  /** Monthly limit in the currency's minor unit. */
  amountCents: number;
  currency: string;
}

/**
 * Budget surface passed into the panel (web only — budgets are a cloud
 * feature, so the desktop/local client leaves this out and the Budget trigger
 * option stays hidden).
 */
export interface BudgetIntegration {
  budgets: BudgetOption[];
  loading?: boolean;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string | null;
  source: string;
  trigger: WorkflowTrigger;
  metricDefs: WorkflowMetricDef[];
  enabled: boolean;
  webhookToken?: string | null;
  /**
   * Whether a git-webhook signing secret is configured. The secret itself is
   * write-only — the API never returns it, so this boolean is all a client
   * sees after saving one.
   */
  hasWebhookSecret?: boolean;
  /** Write-only. Send to set or rotate the signing secret; `null` clears it. */
  webhookSecret?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  updatedAt?: string;
}

export interface WorkflowRunLog {
  at: number;
  level: string;
  message: string;
}

/**
 * Outcome of a single run as returned by `run()`. This is the sandbox's
 * `RunResult` shape (status/logs/output/error/duration) — not a persisted
 * run row: it has no id/triggerSource, and its timestamps (when present)
 * are epoch numbers rather than ISO strings, so they are deliberately
 * omitted here. Fetch `listRuns()` for the full row.
 */
export interface WorkflowRunResult {
  status: string;
  logs: WorkflowRunLog[];
  output?: unknown;
  error?: { message: string; stack?: string } | null;
  durationMs?: number | null;
}

export interface WorkflowRunRow extends WorkflowRunResult {
  id: string;
  triggerSource: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string;
}

/**
 * A human-approval request raised by `infra.waitForApproval(...)` inside a
 * run. Mirrors the `/workflow-approvals` HTTP shape (cloud only).
 */
export interface WorkflowApprovalRow {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  /** The run suspended on this request. */
  runId: string;
  title: string;
  message: string;
  status: "pending" | "approved" | "denied" | "expired";
  /** When a still-pending request is treated as denied (ISO). */
  expiresAt: string;
  decidedAt?: string | null;
  decidedByName?: string | null;
  createdAt: string;
}

/** A repo a connected GitHub App installation can access (for the git-trigger picker). */
export interface GitRepoOption {
  installationId: number;
  fullName: string;
  defaultBranch: string;
  private?: boolean;
}

/** GitHub integration surface passed into the panel (web only). */
export interface GitIntegration {
  /** Whether the server has a GitHub App configured at all. */
  configured: boolean;
  /** Repos available across the org's connected installations. */
  repos: GitRepoOption[];
  /** Open the GitHub install/configure flow (and refresh on return). */
  onConnect: () => void;
  loading?: boolean;
}

export interface WorkflowMetricRow {
  key: string;
  label: string;
  type: string;
  unit?: string | null;
  value: unknown;
}

/** Body accepted by create/update (uses `metrics`, mirroring the HTTP API). */
export interface WorkflowSaveBody {
  name?: string;
  description?: string | null;
  source?: string;
  trigger?: WorkflowTrigger;
  metrics?: WorkflowMetricDef[];
  enabled?: boolean;
}

/**
 * Live step-debugger session passed to `run()`. The UI owns `breakpoints` (and
 * mutates the set as the user toggles them); the client invokes the callbacks as
 * the run executes and fills in `resume`/`step`/`stop` so the toolbar can drive
 * a paused run. All fields are optional so non-debug runs ignore it.
 */
export interface DebugSession {
  /** 1-based source lines with breakpoints. Mutated live by the editor. */
  breakpoints: Set<number>;
  /** The line about to execute (live highlight). */
  onLine?: (line: number) => void;
  /** Streamed log line during the run. */
  onLog?: (entry: WorkflowRunLog) => void;
  /** Execution paused at a breakpoint on this line. */
  onPaused?: (line: number) => void;
  /** Execution resumed (left the paused state). */
  onResumed?: () => void;
  /** Filled in by the client so the UI can continue a paused run. */
  resume?: () => void;
  /** Filled in by the client: advance one line then pause again. */
  step?: () => void;
  /** Filled in by the client: abort the run. */
  stop?: () => void;
}

/**
 * Platform-provided transport. The web app implements this with `fetch` against
 * `/api/org/:org/workflows`; the desktop app implements it over IPC.
 */
export interface WorkflowClient {
  list(): Promise<WorkflowSummary[]>;
  create(body: WorkflowSaveBody): Promise<WorkflowSummary>;
  update(id: string, body: WorkflowSaveBody): Promise<WorkflowSummary>;
  remove(id: string): Promise<void>;
  getTypings(id: string): Promise<string>;
  /** Run a workflow. Pass `debug` for a live-debug (manual) run. */
  run(id: string, debug?: DebugSession): Promise<{ runId: string; result: WorkflowRunResult }>;
  listRuns(id: string): Promise<WorkflowRunRow[]>;
  listMetrics(id: string): Promise<WorkflowMetricRow[]>;
  /**
   * Pending approval requests for one workflow's runs. Optional — approvals
   * are cloud-only, so the desktop/local client omits both methods and the
   * panel hides the approvals card.
   */
  listPendingApprovals?(workflowId: string): Promise<WorkflowApprovalRow[]>;
  /** Land a decision on a pending request. Rejects on conflict (409). */
  decideApproval?(approvalId: string, decision: "approve" | "deny"): Promise<WorkflowApprovalRow>;
}
