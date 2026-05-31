/**
 * Main-process workflow execution bridge.
 *
 * The QuickJS/WASM sandbox (via @sebastianwessel/quickjs → memfs) assumes
 * Node's `Buffer` and other core modules at module-load time, so it cannot run
 * in the Chromium renderer — Vite externalizes `node:buffer` there and the
 * sandbox crashes reading `Buffer.allocUnsafe` off `undefined`. We run
 * `runWorkflow` here in the Electron main process (real Node, native Buffer)
 * and bridge every WorkflowHost capability back to the renderer, where the
 * plugin clients, the local SQLite DB, and the prompt UI already live.
 *
 * The only thing that crosses into main is the sandbox itself; all data access
 * (resources, metrics, storage, prompts) stays renderer-side.
 *
 * Protocol:
 *   renderer  --invoke "workflow_run" {source, interactive, runToken}-->  main
 *   main      --send   "workflow_host_call" {runToken, callId, method, args}-->  renderer
 *   renderer  --invoke "workflow_host_reply" {callId, ok, value|error}-->  main
 *   main      --returns RunResult-->  renderer (resolves the original invoke)
 *
 * See src/lib/workflow-runner.ts for the renderer half.
 */
import { ipcMain, type WebContents } from "electron";
// The runtime is ESM-only (its package exports raw .ts), so this CommonJS main
// module pulls types statically (erased) and `runWorkflow` via dynamic import,
// matching how main.ts loads other ESM-only deps (see electron-updater).
import type {
  MetricValue,
  PromptSpec,
  ResourceInstanceLite,
  StorageObjectBody,
  StorageObjectLite,
  WorkflowHost,
  WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime" with { "resolution-mode": "import" };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

// callId -> host call awaiting a renderer reply. Global across runs; callIds
// are unique for the lifetime of the main process.
const pending = new Map<number, PendingCall>();
let nextCallId = 1;

/** Rebuild an Error from the {message, stack} the renderer serialized. */
function rendererError(raw: unknown): Error {
  if (raw && typeof raw === "object" && "message" in raw) {
    const e = raw as { message?: unknown; stack?: unknown };
    const err = new Error(typeof e.message === "string" ? e.message : "Workflow host error");
    if (typeof e.stack === "string") err.stack = e.stack;
    return err;
  }
  return new Error(String(raw));
}

/**
 * A WorkflowHost whose every method round-trips to the renderer that owns
 * `runToken`. The renderer holds the real host (plugin clients + DB + prompt);
 * each call here just forwards the method name and positional args.
 */
function createBridgedHost(sender: WebContents, runToken: string): WorkflowHost {
  const call = <T>(method: string, args: unknown[]): Promise<T> => {
    if (sender.isDestroyed()) {
      return Promise.reject(new Error("The window was closed before the workflow finished."));
    }
    const callId = nextCallId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(callId, { resolve: resolve as (v: unknown) => void, reject });
      sender.send("workflow_host_call", { runToken, callId, method, args });
    });
  };

  return {
    listPlugins: () => call<WorkflowPluginInfo[]>("listPlugins", []),
    listResources: (accountId, typeId) =>
      call<ResourceInstanceLite[]>("listResources", [accountId, typeId]),
    getResource: (accountId, typeId, externalId) =>
      call<ResourceInstanceLite>("getResource", [accountId, typeId, externalId]),
    resolveOutput: (accountId, typeId, resourceId, outputKey) =>
      call<string>("resolveOutput", [accountId, typeId, resourceId, outputKey]),
    createResource: (accountId, typeId, fields, parentResourceId) =>
      call<ResourceInstanceLite>("createResource", [accountId, typeId, fields, parentResourceId]),
    updateResource: (accountId, typeId, resourceId, fields) =>
      call<ResourceInstanceLite>("updateResource", [accountId, typeId, resourceId, fields]),
    deleteResource: (accountId, typeId, resourceId) =>
      call<void>("deleteResource", [accountId, typeId, resourceId]),
    listStorageObjects: (accountId, bucket, prefix) =>
      call<StorageObjectLite[]>("listStorageObjects", [accountId, bucket, prefix]),
    readStorageObject: (accountId, bucket, key) =>
      call<StorageObjectBody>("readStorageObject", [accountId, bucket, key]),
    prompt: (spec: PromptSpec) => call<MetricValue>("prompt", [spec]),
    getMetric: (key) => call<MetricValue>("getMetric", [key]),
    setMetric: (key, value) => call<void>("setMetric", [key, value]),
    listMetrics: () => call<Record<string, MetricValue>>("listMetrics", []),
  };
}

ipcMain.handle(
  "workflow_run",
  async (
    event,
    { source, interactive, runToken }: { source: string; interactive: boolean; runToken: string },
  ) => {
    const host = createBridgedHost(event.sender, runToken);
    const { runWorkflow } = await import("@infrawrench/workflow-runtime");
    return runWorkflow({ source, host, interactive });
  },
);

ipcMain.handle(
  "workflow_host_reply",
  (
    _event,
    { callId, ok, value, error }: { callId: number; ok: boolean; value?: unknown; error?: unknown },
  ) => {
    const entry = pending.get(callId);
    if (!entry) return;
    pending.delete(callId);
    if (ok) entry.resolve(value);
    else entry.reject(rendererError(error));
  },
);
