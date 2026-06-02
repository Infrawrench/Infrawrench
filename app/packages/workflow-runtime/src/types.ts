/**
 * Shared types for the Infrawrench workflows runtime.
 *
 * These are platform-agnostic: the web server, the poller, and the Electron
 * main process all depend on this package and supply a {@link WorkflowHost}
 * implementation (see ./host) to actually reach accounts, prompt the user, and
 * persist metrics.
 */

/** How a workflow is kicked off. */
export type WorkflowTrigger =
  | { kind: "manual" }
  | { kind: "cron"; expression: string; timezone?: string }
  | {
      kind: "git";
      /** Provider is informational; the webhook is matched by token. */
      provider?: "github" | "gitlab" | "generic";
      repo?: string;
      /** Only run when the push targets this branch (e.g. "main"). */
      branch?: string;
      /** Which webhook events trigger a run. Defaults to ["push"]. */
      events?: string[];
      /** GitHub App installation that authorizes watching `repo` (github-watcher). */
      installationId?: number;
    };

export type WorkflowTriggerKind = WorkflowTrigger["kind"];

/** Value types a user-defined metric can hold. */
export type MetricValueType = "number" | "string" | "boolean";

export type MetricValue = number | string | boolean | null;

/**
 * A metric the user declares in the workflow UI. It shows up in the generated
 * `infra.metrics` typings and can be read/written from the workflow body.
 */
export interface MetricDef {
  key: string;
  label: string;
  type: MetricValueType;
  unit?: string;
  description?: string;
}

/** Persisted definition of a workflow. */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  /** The user's TypeScript source. */
  source: string;
  trigger: WorkflowTrigger;
  metrics: MetricDef[];
  enabled: boolean;
}

export type RunStatus = "pending" | "running" | "success" | "failure" | "canceled";

export type RunTriggerSource = "manual" | "cron" | "git" | "api";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RunLogEntry {
  /** Milliseconds since epoch, stamped by the host. */
  at: number;
  level: LogLevel;
  message: string;
}

/** Outcome of executing a workflow once. */
export interface RunResult {
  status: RunStatus;
  logs: RunLogEntry[];
  /** JSON-serializable value the workflow returned (or `infra.output(...)`). */
  output?: unknown;
  error?: { message: string; stack?: string };
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

/** Resource limits applied to a single execution. */
export interface RunLimits {
  /**
   * Wall-clock execution timeout in milliseconds. Default 300_000 (5 min).
   * This is a wall-clock deadline (it includes time spent awaiting host calls
   * like `resource.ssh()` / `waitUntilReachable()`), so it's generous enough to
   * let a workflow create a VM, wait for it to boot, and connect.
   */
  timeoutMs: number;
  /** Hard heap limit for the isolate in bytes. Default 128 MiB. */
  memoryBytes: number;
  /** Max stack size in bytes. Default 1 MiB. */
  maxStackBytes: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  timeoutMs: 300_000,
  memoryBytes: 128 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
};

/** A prompt request raised by `infra.prompt(...)` inside a workflow. */
export interface PromptSpec {
  message: string;
  /** Input shape the UI should render. Defaults to "text". `code` is a multiline code editor. */
  kind?: "text" | "password" | "number" | "boolean" | "select" | "code";
  /** Options for `kind: "select"`. */
  options?: { label: string; value: string }[];
  defaultValue?: string;
}

/** Lightweight account descriptor exposed to the bridge + codegen. */
export interface WorkflowAccountInfo {
  id: string;
  pluginId: string;
  displayName: string;
}

/**
 * One field of a resource type's create form, distilled from the plugin's
 * `getCreateConfig`. Drives typed `create({...})` autocomplete in codegen so the
 * author sees real field keys (and, where enumerable, real option values)
 * instead of a generic `Record<string, string>`.
 */
export interface WorkflowCreateFieldInfo {
  key: string;
  /** The plugin-base `CreateFieldKind` (kept as string to avoid a plugin dep here). */
  kind: string;
  required: boolean;
  /** Enumerable option ids (select/region/size/image/disk/policy), when known. */
  options?: string[];
  description?: string;
}

/** A resource type descriptor (subset of plugin-base ResourceTypeDefinition). */
export interface WorkflowResourceTypeInfo {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  outputs: { key: string; label: string }[];
  supportsCreate: boolean;
  supportsUpdate: boolean;
  supportsDelete: boolean;
  /** True when the owning plugin implements storage object listing. */
  storage?: boolean;
  /**
   * Distilled create-form fields (best-effort; populated by the host via
   * `getCreateConfig`). Absent → codegen falls back to `Record<string, string>`.
   */
  createFields?: WorkflowCreateFieldInfo[];
  /**
   * Which extended capabilities this resource type supports, so codegen only
   * types the applicable methods (ssh/query/kv/…) per type. Static flags
   * (ssh/sql/metrics/sftp) come from the type definition; the rest are
   * populated from the plugin's client method presence on the typings path.
   */
  capabilities?: WorkflowResourceCapabilities;
}

/** Per-resource-type capability flags that gate the generated `infra.d.ts`. */
export interface WorkflowResourceCapabilities {
  ssh?: boolean;
  sftp?: boolean;
  sql?: boolean;
  kv?: boolean;
  nosql?: boolean;
  logs?: boolean;
  describe?: boolean;
  manifest?: boolean;
  publish?: boolean;
  metrics?: boolean;
}

/** Everything codegen needs about one plugin that has at least one account. */
export interface WorkflowPluginInfo {
  pluginId: string;
  displayName: string;
  accounts: WorkflowAccountInfo[];
  resourceTypes: WorkflowResourceTypeInfo[];
  /** Plugin implements `importYaml` → `account.importYaml(...)` is typed. */
  supportsImportYaml?: boolean;
}
