/**
 * The QuickJS (WASM) isolate itself, factored out of the workflow runner so
 * more than one kind of program can be executed inside it.
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
 *
 * Callers own everything *around* the isolate — assembling the program, reading
 * the accounts tree, persisting the run. {@link runIsolate} owns only the parts
 * that must not be reimplemented per program kind: the execution budget, the
 * pause accounting, and the interrupt/refusal pair that makes `Stop` responsive.
 */
import { loadAsyncQuickJs } from "@sebastianwessel/quickjs";
import releaseAsyncVariant from "@jitl/quickjs-ng-wasmfile-release-asyncify";

import { dispatch, type WorkflowHost, type WorkflowRunContext } from "./host.js";
import type { RunLimits, RunResult } from "./types.js";

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
export const PAUSED_METHODS: ReadonlySet<string> = new Set([
  "prompt",
  "line",
  "ssh.exec",
  "ssh.streamStart",
  "ssh.streamRead",
  "ssh.probe",
]);

export interface IsolateEnvValues {
  /** JSON `WorkflowPluginInfo[]` — the read-only accounts tree. */
  accountsTree: string;
  /** JSON `Record<string, MetricValue>` snapshot the prelude proxies. */
  metrics: string;
  /** JSON `WorkflowEvent` describing what started this run. */
  event: string;
}

export interface RunIsolateOptions {
  /** The complete guest program: prelude + transpiled body + epilogue. */
  program: string;
  /** Required unless a custom {@link RunIsolateOptions.dispatcher} is given. */
  host?: WorkflowHost;
  /**
   * Routes `__host` RPCs instead of the workflow {@link dispatch}. Program
   * kinds with their own (narrower) host surface — custom graphs — supply one
   * so unknown methods fail closed rather than reaching workflow powers.
   */
  dispatcher?: (method: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Log/output sink shared with the caller, which owns the accumulated arrays. */
  ctx: WorkflowRunContext;
  env: IsolateEnvValues;
  limits: RunLimits;
  /** Abort the run (Stop): the interrupt handler ends execution when aborted. */
  signal?: AbortSignal;
  /**
   * Host methods excluded from the execution budget *in addition to*
   * {@link PAUSED_METHODS} — for RPCs a particular program kind blocks on for
   * minutes at a time (an image build, say) without executing guest code.
   */
  extraPausedMethods?: readonly string[];
}

/**
 * How the isolate ended. An `error` means the run failed — either the guest
 * threw (reported through the `__error` sentinel) or the isolate itself did.
 */
export interface IsolateOutcome {
  error?: RunResult["error"];
}

export async function runIsolate(opts: RunIsolateOptions): Promise<IsolateOutcome> {
  const { limits } = opts;
  const hostForDispatch = opts.host;
  if (!opts.dispatcher && !hostForDispatch) {
    throw new Error("runIsolate needs a host or a dispatcher.");
  }
  const route =
    opts.dispatcher ??
    ((method: string, args: Record<string, unknown>) =>
      dispatch(hostForDispatch!, opts.ctx, method, args));
  const paused =
    opts.extraPausedMethods && opts.extraPausedMethods.length > 0
      ? new Set([...PAUSED_METHODS, ...opts.extraPausedMethods])
      : PAUSED_METHODS;

  // Guest-thrown error, surfaced via the __error sentinel RPC.
  let guestError: RunResult["error"] | undefined;

  // Pause-aware execution budget: the interrupt deadline (set below) is frozen
  // while the guest is suspended in a paused host call, so an SSH host-key
  // prompt or a waitUntilReachable() poll doesn't consume the run's time.
  // State is per-run (closed over here).
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
    __accountsTree: opts.env.accountsTree,
    __metrics: opts.env.metrics,
    __event: opts.env.event,
    __host: async (method: string, argsJson: string): Promise<string> => {
      const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      // Completion sentinel emitted by the program wrapper for guest errors.
      if (method === "__error") {
        guestError = toError(args);
        return "";
      }
      const pause = paused.has(method);
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
        const result = await route(method, args);
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
      return evalCode(opts.program);
    }, sandboxOptions);

    const envelope = result as { ok: boolean; data?: unknown; error?: unknown };
    if (envelope && envelope.ok === false) {
      return { error: toError(envelope.error) };
    }
    // A guest-thrown error is reported via the __error sentinel.
    if (guestError) return { error: guestError };
    return {};
  } catch (err) {
    return { error: toError(err) };
  }
}

/**
 * The epilogue every program kind shares: await the body, forward guest throws
 * through the `__error` sentinel, then flush buffered metric writes.
 *
 * Metric assignments are buffered in the prelude (property writes can't be
 * async); persist the final value of every touched metric once the body
 * settles — even on failure, so partial progress is saved.
 */
export const FLUSH_METRICS_EPILOGUE = [
  `try {`,
  `  if (globalThis.__flushMetrics) await globalThis.__flushMetrics();`,
  `} catch (e) {`,
  `  await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`,
  `}`,
].join("\n");

/** Forward a guest throw to the host over the `__error` sentinel RPC. */
export const REPORT_GUEST_ERROR = `await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`;

export function toError(err: unknown, prefix?: string): RunResult["error"] {
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
