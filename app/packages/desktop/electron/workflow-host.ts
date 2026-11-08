/**
 * Main-process workflow execution bridge.
 *
 * The QuickJS/WASM sandbox (via @sebastianwessel/quickjs → memfs) assumes
 * Node's `Buffer` and other core modules at module-load time, so it cannot run
 * in the Chromium renderer: Vite externalizes `node:buffer` there and the
 * sandbox crashes reading `Buffer.allocUnsafe` off `undefined`. We run
 * `runWorkflow` here in the Electron main process (real Node, native Buffer)
 * and bridge every WorkflowHost capability back to the renderer, where the
 * plugin clients, the local SQLite DB, and the prompt UI already live.
 *
 * The only thing that crosses into main is the sandbox itself; all data access
 * (resources, metrics, storage, prompts) stays renderer-side.
 *
 * Protocol (`shared/rpc/groups/workflows.ts`):
 *   renderer  --stream "WorkflowRun" {source, interactive, runToken, ...}-->  main
 *   main      --element HostCall {callId, method, args}-->  renderer
 *   renderer  --call   "WorkflowHostReply" {callId, Ok value | Failed error}-->  main
 *   main      --element Log {entry}, then Done {result}, then ends-->  renderer
 *
 * See src/lib/workflow-runner.ts for the renderer half.
 */
import { Context, Effect, Layer, Queue, Stream } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import { WorkflowRunError, type WorkflowRunEvent } from "../shared/rpc/groups/workflows";
import { workflowFetch } from "./workflow-fetch";
import { loadLocalWorkflowSecretValuesForWorkflow } from "./workflow-secrets";
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

// Method syntax on purpose: a host call's `resolve` takes the method's own
// result type, and the renderer answers with exactly what its `WorkflowHost`
// method returned, so the bivariant method check is the honest type here.
interface PendingCall {
  resolve(value: unknown): void;
  reject(err: unknown): void;
  /** The run that made the call, so a run's end fails only its own calls. */
  runToken: string;
}

// callId -> host call awaiting a renderer reply. Global across runs; callIds
// are unique for the lifetime of the main process.
const pending = new Map<number, PendingCall>();
let nextCallId = 1;

/** Rebuild an Error from the {message, stack} the renderer serialized. */
function rendererError(raw: { readonly message: string; readonly stack?: string }): Error {
  const err = new Error(raw.message);
  if (raw.stack !== undefined) err.stack = raw.stack;
  return err;
}

/**
 * A WorkflowHost whose every method round-trips to the renderer running the
 * workflow. The renderer holds the real host (plugin clients + DB + prompt);
 * each call here just forwards the method name and positional args, through
 * `emit` onto the run's stream; the renderer's answer settles the promise.
 */
function createBridgedHost(
  runToken: string,
  emit: (event: WorkflowRunEvent) => boolean,
): WorkflowHost {
  const call = <T>(method: string, args: unknown[]): Promise<T> => {
    const callId = nextCallId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(callId, { resolve, reject, runToken });
      if (!emit({ _tag: "HostCall", callId, method, args })) {
        pending.delete(callId);
        reject(new Error("The window was closed before the workflow finished."));
      }
    });
  };

  return {
    listPlugins: () => call<WorkflowPluginInfo[]>("listPlugins", []),
    // Every resource op forwards its trailing SidecarRef (undefined for all but
    // operations inside a peer plugin): the renderer needs it to pick which
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

export interface WorkflowRunRequest {
  readonly runToken: string;
  readonly source: string;
  readonly interactive: boolean;
  readonly workflowId: string;
  readonly debug?: boolean;
}

export type WorkflowHostReply =
  | { readonly _tag: "Ok"; readonly callId: number; readonly value: unknown }
  | {
      readonly _tag: "Failed";
      readonly callId: number;
      readonly error: { readonly message: string; readonly stack?: string };
    };

/** Fail the host calls a run still has waiting: its stream is gone. */
function abandonCalls(runToken: string): void {
  for (const [callId, entry] of pending) {
    if (entry.runToken !== runToken) continue;
    pending.delete(callId);
    entry.reject(new Error("The window was closed before the workflow finished."));
  }
}

const runOne = (request: WorkflowRunRequest) =>
  Stream.callback<WorkflowRunEvent, WorkflowRunError>((queue) =>
    Effect.gen(function* () {
      const { runToken } = request;
      const controller = new AbortController();
      yield* Effect.acquireRelease(
        Effect.sync(() => runAborts.set(runToken, controller)),
        () =>
          Effect.sync(() => {
            if (runAborts.get(runToken) === controller) runAborts.delete(runToken);
            controller.abort();
            abandonCalls(runToken);
          }),
      );
      const emit = (event: WorkflowRunEvent) => Queue.offerUnsafe(queue, event);
      const host = createBridgedHost(runToken, emit);
      const result = yield* Effect.tryPromise({
        try: async () => {
          const { runWorkflow } = await import("@infrawrench/workflow-runtime");
          return runWorkflow({
            source: request.source,
            host,
            secrets: await loadLocalWorkflowSecretValuesForWorkflow(request.workflowId),
            interactive: request.interactive,
            ...(request.debug ? { debug: true } : {}),
            signal: controller.signal,
            // Stream log entries to the renderer live (logs are handled by the
            // run context in main, not via the bridged host).
            onLog: (entry) => {
              emit({ _tag: "Log", entry });
            },
          });
        },
        catch: (cause) => new WorkflowRunError({ message: errorMessage(cause) }),
      });
      emit({ _tag: "Done", result });
      Queue.endUnsafe(queue);
    }),
  );

/** Runs local workflows in the main-process sandbox (`shared/rpc/groups/workflows.ts`). */
export class WorkflowRunner extends Context.Service<
  WorkflowRunner,
  {
    readonly run: (
      request: WorkflowRunRequest,
    ) => Stream.Stream<WorkflowRunEvent, WorkflowRunError>;
    readonly stop: (runToken: string) => Effect.Effect<void>;
    readonly reply: (reply: WorkflowHostReply) => Effect.Effect<void>;
  }
>()("infrawrench/desktop/WorkflowRunner") {
  static readonly layer = Layer.succeed(WorkflowRunner)(
    WorkflowRunner.of({
      run: runOne,
      stop: (runToken) => Effect.sync(() => runAborts.get(runToken)?.abort()),
      reply: (reply) =>
        Effect.sync(() => {
          const entry = pending.get(reply.callId);
          if (!entry) return;
          pending.delete(reply.callId);
          if (reply._tag === "Ok") entry.resolve(reply.value);
          else entry.reject(rendererError(reply.error));
        }),
    }),
  );
}
