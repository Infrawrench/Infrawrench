/** Shared UI-side shapes for workflows. Kept decoupled from server types. */

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
    };

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string | null;
  source: string;
  trigger: WorkflowTrigger;
  metricDefs: WorkflowMetricDef[];
  enabled: boolean;
  webhookToken?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  updatedAt?: string;
}

export interface WorkflowRunLog {
  at: number;
  level: string;
  message: string;
}

export interface WorkflowRunRow {
  id: string;
  status: string;
  triggerSource: string;
  logs: WorkflowRunLog[];
  output?: unknown;
  error?: { message: string; stack?: string } | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
  createdAt?: string;
}

/** A repo a connected GitHub App installation can access (for the git-trigger picker). */
export interface GitRepoOption {
  installationId: number;
  fullName: string;
  defaultBranch: string;
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
  run(id: string, debug?: DebugSession): Promise<{ runId: string; result: WorkflowRunRow }>;
  listRuns(id: string): Promise<WorkflowRunRow[]>;
  listMetrics(id: string): Promise<WorkflowMetricRow[]>;
}
