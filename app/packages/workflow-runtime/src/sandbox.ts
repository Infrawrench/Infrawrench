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
  type RunLimits,
  type RunLogEntry,
  type RunResult,
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
function buildProgram(userJs: string): string {
  return [
    `export {};`,
    `const __host = env.__host;`,
    `const __accountsTree = env.__accountsTree;`,
    PRELUDE,
    `const __task = (async () => {`,
    `  try {`,
    userJs,
    `  } catch (e) {`,
    `    await __host("__error", JSON.stringify({ message: (e && e.message) ? String(e.message) : String(e), stack: (e && e.stack) ? String(e.stack) : undefined }));`,
    `  }`,
    `})();`,
    `await __task;`,
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

  let userJs: string;
  try {
    userJs = (await transpileWorkflow(opts.source)).code;
  } catch (err) {
    return finish("failure", toError(err, "Failed to compile workflow"));
  }

  const env = {
    __accountsTree: JSON.stringify(tree),
    __host: async (method: string, argsJson: string): Promise<string> => {
      const args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      // Completion sentinel emitted by the program wrapper for guest errors.
      if (method === "__error") {
        guestError = toError(args);
        return "";
      }
      const result = await dispatch(opts.host, ctx, method, args);
      return result === undefined ? "" : JSON.stringify(result);
    },
  };

  try {
    const { runSandboxed } = await loadAsyncQuickJs(
      releaseAsyncVariant as unknown as Parameters<typeof loadAsyncQuickJs>[0],
    );
    const program = buildProgram(userJs);

    const sandboxOptions = {
      env,
      allowFetch: false,
      allowFs: false,
      executionTimeout: limits.timeoutMs,
      memoryLimit: limits.memoryBytes,
      maxStackSize: limits.maxStackBytes,
    };

    const result = await runSandboxed(({ evalCode }) => evalCode(program), sandboxOptions);

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
