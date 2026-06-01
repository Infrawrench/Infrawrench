/**
 * Desktop renderer side of the workflow execution bridge.
 *
 * The QuickJS/WASM sandbox runs in the Electron main process — it needs Node's
 * `Buffer`, which Chromium doesn't have (see electron/workflow-host.ts). This
 * module keeps the *real* WorkflowHost here in the renderer, where plugin
 * clients, the local SQLite DB, and the prompt UI live, and answers the
 * host-capability calls that main makes back during a run.
 */
import type { RunLogEntry, RunResult, WorkflowHost } from "@infrawrench/workflow-runtime/client";
import { invoke } from "./invoke";

interface HostCall {
  runToken: string;
  callId: number;
  method: keyof WorkflowHost;
  args: unknown[];
}

// runToken -> the host serving a currently-running workflow. Multiple manual
// runs can be in flight at once, so calls are routed by token.
const activeHosts = new Map<string, WorkflowHost>();
// runToken -> live log sink (for streaming logs to the editor during a run).
const logSinks = new Map<string, (entry: RunLogEntry) => void>();
let listening = false;

function toError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack ? { message: err.message, stack: err.stack } : { message: err.message };
  }
  return { message: typeof err === "string" ? err : "Workflow host error" };
}

/** Subscribe to main's host-capability calls exactly once. */
function ensureListening(): void {
  if (listening) return;
  listening = true;
  window.electronAPI.on("workflow_host_call", (payload) => {
    void handleHostCall(payload as HostCall);
  });
  window.electronAPI.on("workflow_log", (payload) => {
    const { runToken, entry } = payload as { runToken: string; entry: RunLogEntry };
    logSinks.get(runToken)?.(entry);
  });
}

async function handleHostCall({ runToken, callId, method, args }: HostCall): Promise<void> {
  const host = activeHosts.get(runToken);
  if (!host) {
    await invoke("workflow_host_reply", {
      callId,
      ok: false,
      error: { message: "No active workflow run for this token." },
    });
    return;
  }
  try {
    const fn = host[method] as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (typeof fn !== "function") {
      throw new Error(`Workflow host has no method "${String(method)}".`);
    }
    const value = await fn.apply(host, args);
    await invoke("workflow_host_reply", { callId, ok: true, value });
  } catch (err) {
    await invoke("workflow_host_reply", { callId, ok: false, error: toError(err) });
  }
}

/**
 * Run a workflow in the main-process sandbox, serving its host calls from this
 * renderer for the duration of the run.
 *
 * `opts.debug` instruments the run (per-line `host.line` calls for the editor's
 * highlight + breakpoints). `opts.onStart` receives a `stop()` that aborts the
 * run in the main process (for the Stop button when not paused at a breakpoint).
 */
export async function runWorkflowInMain(
  source: string,
  interactive: boolean,
  host: WorkflowHost,
  opts: {
    debug?: boolean;
    onStart?: (stop: () => void) => void;
    onLog?: (entry: RunLogEntry) => void;
  } = {},
): Promise<RunResult> {
  ensureListening();
  const runToken = crypto.randomUUID();
  activeHosts.set(runToken, host);
  if (opts.onLog) logSinks.set(runToken, opts.onLog);
  opts.onStart?.(() => {
    void invoke("workflow_stop", { runToken });
  });
  try {
    return await invoke<RunResult>("workflow_run", {
      source,
      interactive,
      runToken,
      ...(opts.debug ? { debug: true } : {}),
    });
  } finally {
    activeHosts.delete(runToken);
    logSinks.delete(runToken);
  }
}
