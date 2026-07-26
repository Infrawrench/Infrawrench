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
    }
  | {
      kind: "budget";
      /** The `budgets.id` this workflow watches (cloud-only — budgets are a cloud feature). */
      budgetId: string;
      /**
       * Fire when spend reaches this percentage of the budget's monthly amount.
       * Defaults to 100 ("goes over budget").
       */
      percent?: number;
      /**
       * Which measure to compare: month-to-date `actual` spend (default) or the
       * projected month-end `forecast`.
       */
      metric?: "actual" | "forecast";
    };

export type WorkflowTriggerKind = WorkflowTrigger["kind"];

/** Default threshold for a budget trigger that doesn't specify one. */
export const DEFAULT_BUDGET_TRIGGER_PERCENT = 100;

/**
 * The budget crossing that started a run, handed to the workflow as
 * `infra.event`. Amounts are in the budget currency's minor unit (cents).
 */
export interface BudgetTriggerEvent {
  kind: "budget";
  budgetId: string;
  budgetName: string;
  /** Calendar month the crossing was observed in, `YYYY-MM`. */
  month: string;
  /** ISO-4217 code of every amount below. */
  currency: string;
  /** The budget's monthly limit. */
  amountCents: number;
  /** Which measure crossed the threshold. */
  metric: "actual" | "forecast";
  /** The threshold that fired, as a percentage of `amountCents`. */
  percent: number;
  /** Value of `metric` when it crossed. */
  observedCents: number;
  /** Month-to-date spend. */
  actualCents: number;
  /** Projected month-end spend; null when there wasn't enough data to fit one. */
  forecastCents: number | null;
}

/**
 * What started this run, exposed to the workflow body as `infra.event`. Only
 * budget triggers carry a payload today; every other trigger reports its kind
 * so a workflow can branch on how it was invoked.
 */
export type WorkflowEvent = { kind: "manual" | "cron" | "git" | "api" } | BudgetTriggerEvent;

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

export type RunTriggerSource = "manual" | "cron" | "git" | "api" | "budget";

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

/**
 * One day of spend a workflow reports via `infra.costs.write(...)`. Mirrors
 * plugin-base's `CostRow` (the shape provider plugins return from
 * `fetchCostData`) so custom sources land in exactly the same `cost_daily`
 * table the graphs, filters, and budgets already read — plus an optional
 * `accountId` to attribute the spend to one of the org's connected accounts.
 */
export interface WorkflowCostRow {
  /** UTC day the spend belongs to, `YYYY-MM-DD`. */
  date: string;
  /** ISO-4217 currency code, e.g. "USD". */
  currency: string;
  /** Money for this day/dimension combination. Negative for credits. */
  amount: number;
  /** Free-form service name, e.g. "Snowflake Compute". Becomes a group/filter value. */
  service?: string;
  region?: string;
  /** Opaque id of the thing being billed; groups the "resource" dimension. */
  resourceId?: string;
  /** Cost-allocation tags. Keys starting with `infrawrench:` are reserved. */
  tags?: Record<string, string>;
  /** Units consumed (for unit-cost reporting), if meaningful. */
  usageAmount?: number;
  usageUnit?: string;
  /**
   * Attribute this row to a connected account. Must belong to the caller's
   * organization. Omit to attribute it to the workflow itself.
   */
  accountId?: string;
}

/** Outcome of a `infra.costs.write(...)` call. */
export interface WorkflowCostWriteResult {
  /** How many rows were written. */
  written: number;
}

/**
 * Default throttle window for `infra.page(...)`. A monitoring cron that finds
 * the same problem every run should page once and then stay quiet, so repeat
 * pages under the same key are suppressed for an hour unless the author says
 * otherwise.
 */
export const DEFAULT_PAGE_COOLDOWN_MINUTES = 60;

/** Throttle key used when `infra.page(...)` is called without one. */
export const DEFAULT_PAGE_KEY = "default";

/** An alert raised by `infra.page(...)`. */
export interface PageSpec {
  /** The alert text. Becomes the SMS body and the notification body. */
  message: string;
  /** Short headline for the notification. Defaults to the workflow's name. */
  title?: string;
  /**
   * Throttle key. Pages sharing a key are suppressed while that key is in
   * cooldown, so a per-object key (a pod name, a cluster id) alerts per object
   * while the default single key alerts once for the whole workflow.
   */
  key?: string;
  /**
   * Minutes to suppress repeat pages under the same key. Defaults to
   * {@link DEFAULT_PAGE_COOLDOWN_MINUTES}; `0` sends every time.
   */
  cooldownMinutes?: number;
  /**
   * Also place a voice call to recipients who opted into voice. Off by
   * default — reserve it for things worth waking someone up for.
   */
  voice?: boolean;
}

/** What `infra.page(...)` reports back to the workflow. */
export interface PageResult {
  /** True when at least one recipient was reached on any transport. */
  delivered: boolean;
  /** True when the key was still in cooldown, so nothing was sent. */
  suppressed: boolean;
  /** Twilio deliveries (SMS + voice) that Twilio accepted. */
  sms: number;
  /** Push notifications accepted by Expo. */
  push: number;
  /** Slack channel posts Slack accepted. */
  slack: number;
  /** When suppressed, the ISO timestamp at which this key can page again. */
  retryAt?: string;
}

/** Wall-clock budget for one `fetch(...)` when the caller doesn't set one. */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/** Ceiling for `timeoutMs`. Longer than this and the run's own budget is the limit. */
export const MAX_FETCH_TIMEOUT_MS = 120_000;

/** Response bytes a `fetch(...)` will buffer before failing, by default. */
export const DEFAULT_FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Ceiling for `maxBytes` — the whole body is buffered in memory on both sides. */
export const MAX_FETCH_MAX_BYTES = 10 * 1024 * 1024;

/** Largest request body a workflow may send (base64 is decoded before this check). */
export const MAX_FETCH_BODY_BYTES = 2 * 1024 * 1024;

/** Request headers per call, and the size of each. */
export const MAX_FETCH_HEADERS = 50;
export const MAX_FETCH_HEADER_NAME_LENGTH = 128;
export const MAX_FETCH_HEADER_VALUE_LENGTH = 4096;

/** Methods a workflow may send. Anything else is rejected before the host runs. */
export const ALLOWED_FETCH_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/**
 * Headers a workflow can't set: they describe the connection rather than the
 * request, and letting a caller forge them would either confuse the proxy or
 * let it be used to smuggle a second request.
 */
export const FORBIDDEN_FETCH_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * One outbound HTTP request from a workflow, normalized by
 * {@link file://./host.ts} `dispatch` so every host receives the same validated
 * shape. Bodies cross as base64 because the sandbox bridge is JSON.
 */
export interface WorkflowFetchRequest {
  /** Absolute `http:`/`https:` URL. */
  url: string;
  /** Uppercased method from {@link ALLOWED_FETCH_METHODS}. */
  method: string;
  /** Lowercased header names; hop-by-hop headers are already stripped. */
  headers: Record<string, string>;
  /** Base64 request body, absent for bodyless methods. */
  bodyBase64?: string;
  /** Clamped to {@link MAX_FETCH_TIMEOUT_MS}. */
  timeoutMs: number;
  /** Clamped to {@link MAX_FETCH_MAX_BYTES}; a larger response fails the call. */
  maxBytes: number;
  /** "follow" (default, max 5 hops, each re-validated) or "manual". */
  redirect: "follow" | "manual";
}

/** What a host returns for a {@link WorkflowFetchRequest}. */
export interface WorkflowFetchResponse {
  status: number;
  statusText: string;
  /** Final URL after redirects (equals the request URL when none were followed). */
  url: string;
  /** Lowercased response header names. */
  headers: Record<string, string>;
  /** Base64 response body ("" for an empty body). */
  bodyBase64: string;
  /** True when the response came from a followed redirect. */
  redirected: boolean;
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

/**
 * A peer plugin reachable *through* a parent resource rather than through an
 * account of its own: a managed Kubernetes cluster (DOKS, EKS, GKE, …) exposes
 * the `kubernetes` plugin via its kubeconfig, and a managed database exposes
 * `postgres` / `mysql` / `redis` / `mongodb` via its connection string. Built
 * from the parent resource type's `peerIntegrations`, and surfaced on the
 * resource itself as `resource.<pluginId>.<group>` — e.g.
 * `cluster.kubernetes.pods.list()`.
 */
export interface WorkflowSidecarInfo {
  /** The peer plugin's id. Also the property name on the parent resource. */
  pluginId: string;
  displayName: string;
  /** Label the resource-detail UI gives this integration's tab ("Kubernetes"). */
  tabLabel: string;
  /** The peer plugin's resource types, as reached inside this parent. */
  resourceTypes: WorkflowResourceTypeInfo[];
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
   * Peer plugins reachable through a resource of this type. Empty/absent for
   * the overwhelming majority of types; only managed clusters and managed
   * databases carry one. Never nested — a sidecar's own types have none.
   */
  sidecars?: WorkflowSidecarInfo[];
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
