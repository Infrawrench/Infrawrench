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

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...opts.limits };
  const startedAt = Date.now();
  const logs: RunLogEntry[] = [];
  let output: unknown;

  const ctx: WorkflowRunContext = {
    interactive: opts.interactive,
    log: (entry) => {
      logs.push(entry);
      opts.onLog?.(entry);
    },
    setOutput: (value) => {
      output = value;
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
    if (error !== undefined) result.error = error;
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
      event: JSON.stringify(opts.event ?? { kind: "manual" }),
    },
    limits,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  return outcome.error ? finish("failure", outcome.error) : finish("success");
}
