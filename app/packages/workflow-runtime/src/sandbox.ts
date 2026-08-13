/**
 * Executes a workflow in the sandboxed QuickJS isolate.
 *
 * This module owns everything specific to *a workflow*: reading the accounts
 * tree and metric snapshot, transpiling the author's TypeScript, assembling the
 * guest program, and shaping the {@link RunResult}. The isolate itself — limits,
 * the pause-aware execution budget, the interrupt handler — lives in
 * {@link file://./isolate.ts} and is shared with the Infrafile runner.
 */
import { FLUSH_METRICS_EPILOGUE, REPORT_GUEST_ERROR, runIsolate, toError } from "./isolate.js";
import type { WorkflowHost, WorkflowRunContext } from "./host.js";
import { PRELUDE } from "./prelude.js";
import { transpileWorkflow } from "./transpile.js";
import {
  assertNoWorkflowSecretNameCollisions,
  DEFAULT_RUN_LIMITS,
  type MetricValue,
  type RunLimits,
  type RunLogEntry,
  type RunResult,
  type WorkflowEvent,
  type WorkflowPluginInfo,
} from "./types.js";

export interface RunWorkflowOptions {
  source: string;
  host: WorkflowHost;
  /** Assigned plaintext values, snapshotted into frozen `infra.secrets`. */
  secrets?: Readonly<Record<string, string>>;
  /** Manual/interactive (allows infra.prompt) vs automated. */
  interactive: boolean;
  limits?: Partial<RunLimits>;
  /** Live log sink (also accumulated into the returned RunResult). */
  onLog?: (entry: RunLogEntry) => void;
  /**
   * Instrument the source with per-line markers (`await __line(n)`) and route
   * them to `host.line` — powers the editor's live highlight + breakpoints.
   * Enable only for editor-driven manual runs, never automated triggers.
   */
  debug?: boolean;
  /** Abort the run (Stop): the interrupt handler ends execution when aborted. */
  signal?: AbortSignal;
  /**
   * Per-operation authorization gate — see `WorkflowRunContext.authorize`.
   * Omitted by hosts with nothing to authorize against (desktop).
   */
  authorize?: (method: string) => void;
  /**
   * What started this run, exposed to the body as `infra.event`. Defaults to
   * `{ kind: "manual" }`.
   */
  event?: WorkflowEvent;
}

/**
 * Assemble the full guest program. `env` values are exposed as a global `env`
 * object (not an importable module), so we lift `__host` / `__accountsTree` off
 * it, run the prelude to build `infra`, then run the user body inside an async
 * IIFE (`__task`). A trailing top-level `await __task` keeps the module's
 * evaluation pending until the body settles, so `runSandboxed` waits for the
 * whole run before resolving. Guest errors are forwarded to the host via the
 * `__error` sentinel RPC; the run's result is captured host-side through
 * `infra.output(...)`.
 *
 * The leading `export {}` selects module semantics so top-level await is
 * available (a bare script disallows it); `env` remains a global regardless.
 */
function buildProgram(userJs: string, debug: boolean): string {
  return [
    `export {};`,
    `const __host = env.__host;`,
    `const __accountsTree = env.__accountsTree;`,
    `const __metrics = env.__metrics;`,
    `const __secrets = env.__secrets;`,
    `const __event = env.__event;`,
    // Debug runs inject `await __line(n)` before each statement (see transpile);
    // route it to the host so the editor can highlight + pause at breakpoints.
    debug ? `const __line = (n) => __host("line", JSON.stringify({ line: n }));` : ``,
    PRELUDE,
    `const __task = (async () => {`,
    `  try {`,
    userJs,
    `  } catch (e) {`,
    `    ${REPORT_GUEST_ERROR}`,
    `  }`,
    `})();`,
    `await __task;`,
    FLUSH_METRICS_EPILOGUE,
  ].join("\n");
}

const SECRET_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const REDACTED = "[REDACTED]";

function prepareSecrets(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const snapshot: Record<string, string> = Object.create(null) as Record<string, string>;
  assertNoWorkflowSecretNameCollisions(Object.keys(input ?? {}));
  for (const [name, value] of Object.entries(input ?? {})) {
    if (!SECRET_NAME_RE.test(name)) {
      throw new Error(`Assigned workflow secret has invalid runtime name "${name}".`);
    }
    if (typeof value !== "string") {
      throw new Error(`Assigned workflow secret "${name}" has no plaintext value.`);
    }
    snapshot[name] = value;
  }
  return snapshot;
}

function secretRedactor(secrets: Readonly<Record<string, string>>) {
  const values = [...new Set(Object.values(secrets).filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  const text = (value: string): string => {
    let redacted = value;
    for (const secret of values) redacted = redacted.split(secret).join(REDACTED);
    return redacted;
  };
  const value = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input).map(([key, child]) => [text(key), value(child)]),
      );
    }
    return input;
  };
  const error = (input: RunResult["error"]): RunResult["error"] =>
    input
      ? {
          message: text(input.message),
          ...(input.stack ? { stack: text(input.stack) } : {}),
        }
      : undefined;
  return { text, value, error };
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...opts.limits };
  const startedAt = Date.now();
  const logs: RunLogEntry[] = [];
  let output: unknown;
  let secretsSnapshot: Record<string, string>;
  try {
    secretsSnapshot = prepareSecrets(opts.secrets);
  } catch (err) {
    const finishedAt = Date.now();
    return {
      status: "failure",
      logs,
      error: toError(err) ?? { message: "Failed to load assigned workflow secrets." },
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
  }
  const redact = secretRedactor(secretsSnapshot);

  const ctx: WorkflowRunContext = {
    interactive: opts.interactive,
    ...(opts.authorize ? { authorize: opts.authorize } : {}),
    log: (entry) => {
      const safeEntry = { ...entry, message: redact.text(entry.message) };
      logs.push(safeEntry);
      opts.onLog?.(safeEntry);
    },
    setOutput: (value) => {
      output = redact.value(value);
    },
  };

  const finish = (status: RunResult["status"], error?: RunResult["error"]): RunResult => {
    const finishedAt = Date.now();
    const result: RunResult = {
      status,
      logs,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
    if (output !== undefined) result.output = output;
    if (error !== undefined) {
      result.error = redact.error(error) ?? { message: "Workflow failed." };
    }
    return result;
  };

  let tree: WorkflowPluginInfo[];
  try {
    tree = await opts.host.listPlugins();
  } catch (err) {
    return finish("failure", toError(err));
  }

  // Snapshot declared metrics so the workflow can read them as typed,
  // synchronous properties (`infra.metrics.<key>`). Writes are buffered and
  // flushed after the run (see buildProgram).
  let metricsSnapshot: Record<string, MetricValue> = {};
  try {
    metricsSnapshot = await opts.host.listMetrics();
  } catch (err) {
    return finish("failure", toError(err, "Failed to read workflow metrics"));
  }

  const debug = Boolean(opts.debug);
  let userJs: string;
  try {
    userJs = (await transpileWorkflow(opts.source, { instrumentLines: debug })).code;
  } catch (err) {
    return finish("failure", toError(err, "Failed to compile workflow"));
  }

  const outcome = await runIsolate({
    program: buildProgram(userJs, debug),
    host: opts.host,
    ctx,
    env: {
      accountsTree: JSON.stringify(tree),
      metrics: JSON.stringify(metricsSnapshot),
      secrets: JSON.stringify(secretsSnapshot),
      event: JSON.stringify(opts.event ?? { kind: "manual" }),
    },
    limits,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return outcome.error ? finish("failure", outcome.error) : finish("success");
}
