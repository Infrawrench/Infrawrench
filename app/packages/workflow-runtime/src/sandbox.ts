/**
 * Executes a workflow in a sandboxed QuickJS (WASM) isolate.
 *
 * Why QuickJS-in-WASM rather than isolated-vm: it is pure WASM, so the *exact*
 * same code path runs in the Electron main process and the Node web server with
 * no native rebuild; the WASM boundary is itself a sandbox; and it offers a hard
 * memory limit plus a reliable execution timeout.
 *
 * We use the ASYNC (asyncify) build so guest code can `await __host(...)`: the
 * WASM module suspends until the host promise settles. The only powers granted
 * to guest code are the single async RPC `__host` and a read-only
 * `__accountsTree`, injected through the global `env` object; everything
 * ergonomic (`infra.*`) is pure JS built by the prelude on top of those.
 */
import { loadAsyncQuickJs } from "@sebastianwessel/quickjs";
import releaseAsyncVariant from "@jitl/quickjs-ng-wasmfile-release-asyncify";

import { dispatch, type WorkflowHost, type WorkflowRunContext } from "./host.js";
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

/**
 * Host RPCs whose wall-clock duration is excluded from the run's execution
 * budget: interactive prompts and SSH calls — the latter may pop a host-key
 * confirmation dialog or wait minutes for a VM to boot. A runaway pure-JS loop
 * stays bounded (its CPU time still counts); only genuine waits are paused.
 *
 * `fetch` is deliberately NOT here. Each call is already bounded by its own
 * timeout, and counting them keeps `while (true) await fetch(...)` inside the
 * run's budget — pausing would make that loop unkillable.
 */
const PAUSED_METHODS = new Set([
  "prompt",
  "line",
  "ssh.exec",
  "ssh.streamStart",
  "ssh.streamRead",
  "ssh.probe",
]);

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
    `    await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`,
    `  }`,
    `})();`,
    `await __task;`,
    // Metric assignments are buffered in the prelude (property writes can't be
    // async); persist the final value of every touched metric once the body
    // settles — even on failure, so partial progress is saved.
    `try {`,
    `  if (globalThis.__flushMetrics) await globalThis.__flushMetrics();`,
    `} catch (e) {`,
    `  await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`,
    `}`,
  ].join("\n");
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<RunResult> {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...opts.limits };
  const startedAt = Date.now();
  const logs: RunLogEntry[] = [];
  let output: unknown;
  // Guest-thrown error, surfaced via the __error sentinel RPC.
  let guestError: RunResult["error"] | undefined;

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

  // Pause-aware execution budget: the interrupt deadline (set below) is frozen
  // while the guest is suspended in a {@link PAUSED_METHODS} host call, so an
  // SSH host-key prompt or a waitUntilReachable() poll doesn't consume the run's
  // time. State is per-run (closed over here).
  let execStart = 0;
  let pausedMs = 0;
  let pauseStart: number | null = null;
  const pauseTimeout = (): void => {
    if (pauseStart === null) pauseStart = Date.now();
  };
  const resumeTimeout = (): void => {
    if (pauseStart !== null) {
      pausedMs += Date.now() - pauseStart;
      pauseStart = null;
    }
  };

  /** Milliseconds of budget consumed so far (host waits excluded, see above). */
  const elapsed = (): number => {
    const livePause = pauseStart !== null ? Date.now() - pauseStart : 0;
    return Date.now() - execStart - pausedMs - livePause;
  };

  const env = {
    __accountsTree: JSON.stringify(tree),
    __metrics: JSON.stringify(metricsSnapshot),
    __event: JSON.stringify(opts.event ?? { kind: "manual" }),
    __host: async (method: string, argsJson: string): Promise<string> => {
      const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      // Completion sentinel emitted by the program wrapper for guest errors.
      if (method === "__error") {
        guestError = toError(args);
        return "";
      }
      const pause = PAUSED_METHODS.has(method);
      // The interrupt handler below is the isolate's only other exit, and
      // QuickJS consults it on an instruction count — a loop that spends its
      // time *suspended* in host calls executes very few instructions, so it
      // can overrun the budget by a wide margin before the handler is asked.
      // Refusing to serve a call once the run is over (or stopped) closes that:
      // the loop that outlives its budget is exactly the loop that has to come
      // back here for its next request.
      if (opts.signal?.aborted) throw new Error("Workflow stopped.");
      if (!pause && limits.timeoutMs > 0 && elapsed() > limits.timeoutMs) {
        throw new Error(`Workflow exceeded its ${limits.timeoutMs}ms execution budget.`);
      }
      if (pause) pauseTimeout();
      try {
        const result = await dispatch(opts.host, ctx, method, args);
        return result === undefined ? "" : JSON.stringify(result);
      } finally {
        if (pause) resumeTimeout();
      }
    },
  };

  try {
    const { runSandboxed } = await loadAsyncQuickJs(
      releaseAsyncVariant as unknown as Parameters<typeof loadAsyncQuickJs>[0],
    );
    const program = buildProgram(userJs, debug);

    const sandboxOptions = {
      env,
      allowFetch: false,
      allowFs: false,
      // `executionTimeout` is intentionally omitted: the library would install a
      // fixed wall-clock deadline that counts time the guest spends suspended in
      // host calls. We install a *pause-aware* interrupt handler below instead.
      memoryLimit: limits.memoryBytes,
      maxStackSize: limits.maxStackBytes,
    };

    const result = await runSandboxed(({ ctx, evalCode }) => {
      execStart = Date.now();
      ctx.runtime.setInterruptHandler(() => {
        // Stop: abort as soon as the guest is executing again.
        if (opts.signal?.aborted) return true;
        if (limits.timeoutMs <= 0) return false;
        return elapsed() > limits.timeoutMs;
      });
      return evalCode(program);
    }, sandboxOptions);

    const envelope = result as { ok: boolean; data?: unknown; error?: unknown };
    if (envelope && envelope.ok === false) {
      return finish("failure", toError(envelope.error));
    }
    // A guest-thrown error is reported via the __error sentinel.
    if (guestError) {
      return finish("failure", guestError);
    }
    return finish("success");
  } catch (err) {
    return finish("failure", toError(err));
  }
}

function toError(err: unknown, prefix?: string): RunResult["error"] {
  let base: { message: string; stack?: string };
  if (err instanceof Error) {
    base = err.stack ? { message: err.message, stack: err.stack } : { message: err.message };
  } else if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    const e = err as { message: string; stack?: string };
    base =
      typeof e.stack === "string" ? { message: e.message, stack: e.stack } : { message: e.message };
  } else {
    base = { message: typeof err === "string" ? err : safeStringify(err) };
  }
  return prefix ? { ...base, message: `${prefix}: ${base.message}` } : base;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
