/** Shared UI-side shapes for workflows. Kept decoupled from server types. */

export interface WorkflowMetricDef {
  key: string;
  label: string;
  type: "number" | "string" | "boolean";
  unit?: string;
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
 * Platform-provided transport. The web app implements this with `fetch` against
 * `/api/org/:org/workflows`; the desktop app implements it over IPC.
 */
export interface WorkflowClient {
  list(): Promise<WorkflowSummary[]>;
  create(body: WorkflowSaveBody): Promise<WorkflowSummary>;
  update(id: string, body: WorkflowSaveBody): Promise<WorkflowSummary>;
  remove(id: string): Promise<void>;
  getTypings(id: string): Promise<string>;
  run(id: string): Promise<{ runId: string; result: WorkflowRunRow }>;
  listRuns(id: string): Promise<WorkflowRunRow[]>;
  listMetrics(id: string): Promise<WorkflowMetricRow[]>;
}
