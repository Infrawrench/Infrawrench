/**
 * Desktop renderer side of the workflow execution bridge.
 *
 * The QuickJS/WASM sandbox runs in the Electron main process: it needs Node's
 * `Buffer`, which Chromium doesn't have (see electron/workflow-host.ts). This
 * module keeps the *real* WorkflowHost here in the renderer, where plugin
 * clients, the local SQLite DB, and the prompt UI live, and answers the
 * host-capability calls the run streams back (`WorkflowRun`, in
 * `shared/rpc/groups/workflows.ts`).
 */
import { Effect, Predicate, Stream } from "effect";
import type { RunLogEntry, RunResult, WorkflowHost } from "@infrawrench/workflow-runtime/client";
import { DesktopRpcClient, runRpc } from "./rpc/client";

function toError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return err.stack ? { message: err.message, stack: err.stack } : { message: err.message };
  }
  return { message: typeof err === "string" ? err : "Workflow host error" };
}

/** Run one host method the sandbox asked for, by name, with its positional args. */
async function callHost(host: WorkflowHost, method: string, args: readonly unknown[]) {
  const fn: unknown = Reflect.get(host, method);
  if (!Predicate.isFunction(fn)) {
    throw new Error(`Workflow host has no method "${method}".`);
  }
  const value: unknown = await Reflect.apply(fn, host, args);
  return value;
}

/** Answer a host call; a reply the main process can no longer place is dropped there. */
function answerHostCall(
  host: WorkflowHost,
  callId: number,
  method: string,
  args: readonly unknown[],
) {
  void callHost(host, method, args)
    .then(
      (value) =>
        runRpc(DesktopRpcClient.use((rpc) => rpc.WorkflowHostReply({ _tag: "Ok", callId, value }))),
      (err: unknown) =>
        runRpc(
          DesktopRpcClient.use((rpc) =>
            rpc.WorkflowHostReply({ _tag: "Failed", callId, error: toError(err) }),
          ),
        ),
    )
    .catch((err: unknown) => console.error("[workflow] could not answer a host call:", err));
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
    /** Electron main loads this workflow's assigned secret snapshot from SQLite. */
    workflowId: string;
    onStart?: (stop: () => void) => void;
    onLog?: (entry: RunLogEntry) => void;
  },
): Promise<RunResult> {
  const runToken = crypto.randomUUID();
  opts.onStart?.(() => {
    void runRpc(DesktopRpcClient.use((rpc) => rpc.WorkflowStop({ runToken }))).catch(
      () => undefined,
    );
  });
  const result = await runRpc(
    Effect.gen(function* () {
      const rpc = yield* DesktopRpcClient;
      let done: RunResult | undefined;
      yield* Stream.runForEach(
        rpc.WorkflowRun({
          runToken,
          source,
          interactive,
          workflowId: opts.workflowId,
          ...(opts.debug ? { debug: true } : {}),
        }),
        (event) =>
          Effect.sync(() => {
            if (event._tag === "HostCall")
              answerHostCall(host, event.callId, event.method, event.args);
            else if (event._tag === "Log") opts.onLog?.(event.entry);
            else done = event.result;
          }),
      );
      return done;
    }),
  );
  if (!result) throw new Error("The workflow run ended without a result.");
  return result;
}
