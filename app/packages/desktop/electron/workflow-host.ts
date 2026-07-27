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
import { workflowFetch } from "./workflow-fetch";
// The runtime is ESM-only (its package exports raw .ts), so this CommonJS main
// module pulls types statically (erased) and `runWorkflow` via dynamic import,
// matching how main.ts loads other ESM-only deps (see electron-updater).
import type {
  MetricValue,
  PageResult,
  PageSpec,
  PromptSpec,
  ResourceInstanceLite,
  SftpEntryLite,
  SftpParamsLite,
  SshExecParamsLite,
  SshExecResultLite,
  SshProbeParamsLite,
  SshStreamChunkLite,
  StorageObjectBody,
  StorageObjectLite,
  WorkflowFetchRequest,
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
    // Every resource op forwards its trailing SidecarRef (undefined for all but
    // operations inside a peer plugin) — the renderer needs it to pick which
    // client to build, and dropping it here would silently target the wrong one.
    listResources: (accountId, typeId, sidecar) =>
      call<ResourceInstanceLite[]>("listResources", [accountId, typeId, sidecar]),
    getResource: (accountId, typeId, externalId, sidecar) =>
      call<ResourceInstanceLite>("getResource", [accountId, typeId, externalId, sidecar]),
    resolveOutput: (accountId, typeId, resourceId, outputKey, sidecar) =>
      call<string>("resolveOutput", [accountId, typeId, resourceId, outputKey, sidecar]),
    createResource: (accountId, typeId, fields, parentResourceId, sidecar) =>
      call<ResourceInstanceLite>("createResource", [
        accountId,
        typeId,
        fields,
        parentResourceId,
        sidecar,
      ]),
    updateResource: (accountId, typeId, resourceId, fields, sidecar) =>
      call<ResourceInstanceLite>("updateResource", [
        accountId,
        typeId,
        resourceId,
        fields,
        sidecar,
      ]),
    deleteResource: (accountId, typeId, resourceId, sidecar) =>
      call<void>("deleteResource", [accountId, typeId, resourceId, sidecar]),
    listStorageObjects: (accountId, bucket, prefix) =>
      call<StorageObjectLite[]>("listStorageObjects", [accountId, bucket, prefix]),
    readStorageObject: (accountId, bucket, key) =>
      call<StorageObjectBody>("readStorageObject", [accountId, bucket, key]),
    prompt: (spec: PromptSpec) => call<MetricValue>("prompt", [spec]),
    // Served here rather than bridged: an HTTP request needs nothing the
    // renderer owns, and main is where Node's CORS-free fetch lives.
    fetch: (request: WorkflowFetchRequest) => workflowFetch(request),
    page: (spec: PageSpec) => call<PageResult>("page", [spec]),
    clearPage: (key: string) => call<void>("clearPage", [key]),
    getMetric: (key) => call<MetricValue>("getMetric", [key]),
    setMetric: (key, value) => call<void>("setMetric", [key, value]),
    listMetrics: () => call<Record<string, MetricValue>>("listMetrics", []),
    sshExec: (params: SshExecParamsLite) => call<SshExecResultLite>("sshExec", [params]),
    sshStreamStart: (params: SshExecParamsLite) =>
      call<{ streamId: string }>("sshStreamStart", [params]),
    sshStreamRead: (streamId: string) => call<SshStreamChunkLite>("sshStreamRead", [streamId]),
    sshStreamClose: (streamId: string) => call<void>("sshStreamClose", [streamId]),
    sshProbe: (params: SshProbeParamsLite) => call<boolean>("sshProbe", [params]),
    line: (lineNumber: number) => call<void>("line", [lineNumber]),
    // SFTP (over the resource's SSH endpoint).
    sftpList: (params: SftpParamsLite, path: string) =>
      call<SftpEntryLite[]>("sftpList", [params, path]),
    sftpGet: (params: SftpParamsLite, path: string) =>
      call<{ base64: string }>("sftpGet", [params, path]),
    sftpPut: (params: SftpParamsLite, path: string, base64: string) =>
      call<void>("sftpPut", [params, path, base64]),
    sftpMkdir: (params: SftpParamsLite, path: string) => call<void>("sftpMkdir", [params, path]),
    sftpDelete: (params: SftpParamsLite, path: string, isDir: boolean) =>
      call<void>("sftpDelete", [params, path, isDir]),
    // Extended resource capabilities (plugin-client passthroughs).
    query: (accountId, resourceId, sql, sidecar) =>
      call<{ rows: Record<string, unknown>[]; durationMs?: number }>("query", [
        accountId,
        resourceId,
        sql,
        sidecar,
      ]),
    kvList: (accountId, typeId, resourceId, params, sidecar) =>
      call<{ items: { key: string }[]; nextCursor?: string }>("kvList", [
        accountId,
        typeId,
        resourceId,
        params,
        sidecar,
      ]),
    kvGet: (accountId, typeId, resourceId, key, sidecar) =>
      call<string>("kvGet", [accountId, typeId, resourceId, key, sidecar]),
    kvPut: (accountId, typeId, resourceId, key, value, sidecar) =>
      call<void>("kvPut", [accountId, typeId, resourceId, key, value, sidecar]),
    kvDelete: (accountId, typeId, resourceId, key, sidecar) =>
      call<void>("kvDelete", [accountId, typeId, resourceId, key, sidecar]),
    nosql: (accountId, typeId, resourceId, command, args, sidecar) =>
      call<unknown>("nosql", [accountId, typeId, resourceId, command, args, sidecar]),
    getLogs: (accountId, typeId, resourceId, params, sidecar) =>
      call<{ text: string; containers: string[]; activeContainer: string }>("getLogs", [
        accountId,
        typeId,
        resourceId,
        params,
        sidecar,
      ]),
    describe: (accountId, typeId, resourceId, sidecar) =>
      call<string>("describe", [accountId, typeId, resourceId, sidecar]),
    getManifest: (accountId, resourceId, sidecar) =>
      call<string>("getManifest", [accountId, resourceId, sidecar]),
    applyManifest: (accountId, resourceId, manifest, sidecar) =>
      call<void>("applyManifest", [accountId, resourceId, manifest, sidecar]),
    importYaml: (accountId, yaml) => call<{ applied: number }>("importYaml", [accountId, yaml]),
    publish: (accountId, typeId, resourceId, payload, sidecar) =>
      call<{ id?: string; summary?: string }>("publish", [
        accountId,
        typeId,
        resourceId,
        payload,
        sidecar,
      ]),
    metricSeries: (accountId, typeId, resourceId, timeRange, sidecar) =>
      call<{ label: string; unit?: string; points: { timestamp: number; value: number }[] }[]>(
        "metricSeries",
        [accountId, typeId, resourceId, timeRange, sidecar],
      ),
  };
}

// Per-run abort controllers so the renderer's Stop button can end a run that
// isn't currently paused at a breakpoint (the interrupt handler reads the signal).
const runAborts = new Map<string, AbortController>();

ipcMain.handle(
  "workflow_run",
  async (
    event,
    {
      source,
      interactive,
      runToken,
      debug,
    }: { source: string; interactive: boolean; runToken: string; debug?: boolean },
  ) => {
    const host = createBridgedHost(event.sender, runToken);
    const controller = new AbortController();
    runAborts.set(runToken, controller);
    const { runWorkflow } = await import("@infrawrench/workflow-runtime");
    try {
      return await runWorkflow({
        source,
        host,
        interactive,
        ...(debug ? { debug: true } : {}),
        signal: controller.signal,
        // Stream log entries to the renderer live (logs are handled by the run
        // context in main, not via the bridged host).
        onLog: (entry) => {
          if (!event.sender.isDestroyed()) event.sender.send("workflow_log", { runToken, entry });
        },
      });
    } finally {
      runAborts.delete(runToken);
    }
  },
);

ipcMain.handle("workflow_stop", (_event, { runToken }: { runToken: string }) => {
  runAborts.get(runToken)?.abort();
});

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
