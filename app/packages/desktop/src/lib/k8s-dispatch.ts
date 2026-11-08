/**
 * K8s dispatcher: routes k8s exec, k9s, and port-forward between local
 * IPC (kubectl/k9s on the local host) and the cloud WebSocket proxy at
 * `/api/ws`.
 *
 * Rule: if `activeCloudOrgId` is set on the UI store, everything goes through
 * the WS proxy and cloud IPCs. Otherwise: local IPC.
 */

import { Cause, Effect, Exit, Predicate, Schema, Stream } from "effect";
import { K8sPortForwardConfig, type K8sTerminalEvent } from "../../shared/rpc/groups/k8s-local";
import { getCloudWsToken } from "./cloud-auth";
import { getCloudWsUrl } from "./cloud-ws";
import { DesktopRpcClient, forkRpc, runRpc } from "./rpc/client";

export interface K8sSessionHandle {
  kind: "local" | "cloud";
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: Uint8Array) => void) => void;
  onExit: (cb: () => void) => void;
  onError: (cb: (err: string) => void) => void;
}

interface CommonExecParams {
  namespace: string;
  podName: string;
  containerName?: string;
  cols: number;
  rows: number;
}

interface LocalExecParams extends CommonExecParams {
  mode: "local";
  kubeconfig: string;
}

interface CloudExecParams extends CommonExecParams {
  mode: "cloud";
  orgId: string;
  accountId: string;
  resourceId: string;
  peerPluginId: string;
}

type OpenK8sExecParams = LocalExecParams | CloudExecParams;

export async function openK8sExec(params: OpenK8sExecParams): Promise<K8sSessionHandle> {
  return params.mode === "cloud" ? openCloudExec(params) : openLocalExec(params);
}

function openLocalExec(params: LocalExecParams): Promise<K8sSessionHandle> {
  const config = {
    kubeconfig: params.kubeconfig,
    namespace: params.namespace,
    podName: params.podName,
    ...(params.containerName ? { containerName: params.containerName } : {}),
    cols: params.cols,
    rows: params.rows,
  };
  return openLocalTerminal({
    open: (rpc) => rpc.K8sExecOpen(config),
    write: (rpc, sessionId, data) => rpc.K8sExecWrite({ sessionId, data }),
    resize: (rpc, sessionId, cols, rows) => rpc.K8sExecResize({ sessionId, cols, rows }),
  });
}

async function openCloudExec(params: CloudExecParams): Promise<K8sSessionHandle> {
  return openCloudWs({
    type: "k8s:exec:open",
    orgId: params.orgId,
    payload: {
      accountId: params.accountId,
      resourceId: params.resourceId,
      peerPluginId: params.peerPluginId,
      namespace: params.namespace,
      podName: params.podName,
      ...(params.containerName ? { containerName: params.containerName } : {}),
      cols: params.cols,
      rows: params.rows,
    },
    dataType: "k8s:exec:data",
    closedType: "k8s:exec:closed",
    errorType: "k8s:exec:error",
    resizeType: "k8s:exec:resize",
  });
}

interface CommonK9sParams {
  namespace?: string;
  cols: number;
  rows: number;
}

interface LocalK9sParams extends CommonK9sParams {
  mode: "local";
  kubeconfig: string;
}

interface CloudK9sParams extends CommonK9sParams {
  mode: "cloud";
  orgId: string;
  accountId: string;
  resourceId: string;
  peerPluginId: string;
}

type OpenK9sParams = LocalK9sParams | CloudK9sParams;

export async function openK9s(params: OpenK9sParams): Promise<K8sSessionHandle> {
  if (params.mode === "cloud") {
    return openCloudWs({
      type: "k9s:open",
      orgId: params.orgId,
      payload: {
        accountId: params.accountId,
        resourceId: params.resourceId,
        peerPluginId: params.peerPluginId,
        ...(params.namespace ? { namespace: params.namespace } : {}),
        cols: params.cols,
        rows: params.rows,
      },
      dataType: "k9s:data",
      closedType: "k9s:closed",
      errorType: "k9s:error",
      resizeType: "k9s:resize",
    });
  }
  const config = {
    kubeconfig: params.kubeconfig,
    ...(params.namespace ? { namespace: params.namespace } : {}),
    cols: params.cols,
    rows: params.rows,
  };
  return openLocalTerminal({
    open: (rpc) => rpc.K9sOpen(config),
    write: (rpc, sessionId, data) => rpc.K9sWrite({ sessionId, data }),
    resize: (rpc, sessionId, cols, rows) => rpc.K9sResize({ sessionId, cols, rows }),
  });
}

/** Whether k9s is installed on this machine. */
export function checkK9sInstalled(): Promise<boolean> {
  return runRpc(DesktopRpcClient.use((rpc) => rpc.K9sCheck()));
}

interface CommonPfParams {
  namespace: string;
  resourceType: string;
  resourceName: string;
  remotePort: number;
  localPort?: number;
}

interface LocalPfParams extends CommonPfParams {
  mode: "local";
  kubeconfig: string;
}

interface CloudPfParams extends CommonPfParams {
  mode: "cloud";
  orgId: string;
  accountId: string;
  resourceId: string;
  peerPluginId: string;
}

type StartPortForwardParams = LocalPfParams | CloudPfParams;

export interface PortForwardHandle {
  kind: "local" | "cloud";
  sessionId: string;
  localPort: number;
  onExit: (cb: () => void) => void;
  stop: () => void;
}

export async function startPortForward(params: StartPortForwardParams): Promise<PortForwardHandle> {
  if (params.mode === "cloud") return startCloudPortForward(params);
  return startLocalPortForward(params);
}

/**
 * A cloud port-forward is one stream too (`K8sPfCloudStart`): it resolves
 * once the main process's local listener is bound, and ends if the main
 * process closes the listener itself (the app quitting). `stop` interrupts
 * the stream, which closes the listener and every connection through it.
 */
function startCloudPortForward(params: CloudPfParams): Promise<PortForwardHandle> {
  const exitListeners: Array<() => void> = [];
  let started = false;
  let stopped = false;
  let exited = false;
  let stop: () => void = () => {};
  return new Promise<PortForwardHandle>((resolve, reject) => {
    stop = forkRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        const config = {
          orgId: params.orgId,
          accountId: params.accountId,
          resourceId: params.resourceId,
          peerPluginId: params.peerPluginId,
          namespace: params.namespace,
          resourceType: params.resourceType,
          resourceName: params.resourceName,
          remotePort: params.remotePort,
          ...(params.localPort !== undefined ? { localPort: params.localPort } : {}),
        };
        yield* Stream.runForEach(rpc.K8sPfCloudStart(config), (event) =>
          Effect.sync(() => {
            started = true;
            resolve({
              kind: "cloud",
              sessionId: event.sessionId,
              localPort: event.localPort,
              onExit: (cb) => {
                if (exited) cb();
                else exitListeners.push(cb);
              },
              stop: () => {
                if (stopped) return;
                stopped = true;
                exitListeners.length = 0;
                stop();
              },
            });
          }),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            exited = true;
            if (stopped) return;
            if (!started) {
              reject(new Error(failureMessage(exit) ?? "The port-forward could not start"));
              return;
            }
            for (const cb of exitListeners) cb();
          }),
        ),
      ),
    );
  });
}

/** What separates `kubectl exec` from k9s: the open stream and its input calls. */
interface LocalTerminalRpcs {
  open: (rpc: DesktopRpcClient["Service"]) => Stream.Stream<K8sTerminalEvent, unknown>;
  write: (
    rpc: DesktopRpcClient["Service"],
    sessionId: string,
    data: string,
  ) => Effect.Effect<void, unknown>;
  resize: (
    rpc: DesktopRpcClient["Service"],
    sessionId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, unknown>;
}

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.squash(exit.cause);
  return Predicate.isError(failure) ? failure.message : String(failure);
};

/**
 * A local terminal is one stream: it resolves once the stream reports
 * `Opened`, carries the output after that, and ends when the process exits.
 * `kill` interrupts the stream, which is what makes the main process kill
 * the process and remove its kubeconfig.
 */
function openLocalTerminal(rpcs: LocalTerminalRpcs): Promise<K8sSessionHandle> {
  const dataListeners: Array<(d: Uint8Array) => void> = [];
  const exitListeners: Array<() => void> = [];

  let sessionId: string | null = null;
  let killed = false;
  let stop: () => void = () => {};

  // Keystrokes go one call at a time, coalesced while one is in flight, so
  // they reach the process in the order they were typed.
  let unsent = "";
  let sending = false;
  const flush = (): void => {
    if (sending || killed || sessionId === null || unsent === "") return;
    const data = unsent;
    const id = sessionId;
    unsent = "";
    sending = true;
    void runRpc(DesktopRpcClient.use((rpc) => rpcs.write(rpc, id, data)))
      .catch(() => undefined)
      .finally(() => {
        sending = false;
        flush();
      });
  };

  return new Promise<K8sSessionHandle>((resolve, reject) => {
    const handle: K8sSessionHandle = {
      kind: "local",
      write: (data) => {
        if (killed) return;
        unsent += data;
        flush();
      },
      resize: (cols, rows) => {
        if (killed || sessionId === null) return;
        const id = sessionId;
        void runRpc(DesktopRpcClient.use((rpc) => rpcs.resize(rpc, id, cols, rows))).catch(
          () => undefined,
        );
      },
      kill: () => {
        if (killed) return;
        killed = true;
        unsent = "";
        stop();
      },
      onData: (cb) => {
        dataListeners.push(cb);
      },
      onExit: (cb) => {
        exitListeners.push(cb);
      },
      onError: () => {
        /* local errors surface via exit */
      },
    };

    stop = forkRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* Stream.runForEach(rpcs.open(rpc), (event) =>
          Effect.sync(() => {
            if (event._tag === "Opened") {
              sessionId = event.sessionId;
              resolve(handle);
              flush();
              return;
            }
            for (const cb of dataListeners) cb(event.data);
          }),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (killed) return;
            if (sessionId === null) {
              // Never opened: the consent, the kubeconfig or the spawn failed.
              reject(new Error(failureMessage(exit) ?? "The terminal closed before it opened"));
              return;
            }
            for (const cb of exitListeners) cb();
          }),
        ),
      ),
    );
  });
}

/**
 * A local port-forward is one stream: it resolves once kubectl reports the
 * port it bound, and ends when kubectl exits. `stop` interrupts the stream,
 * which is what makes the main process kill kubectl.
 */
function startLocalPortForward(params: LocalPfParams): Promise<PortForwardHandle> {
  const exitListeners: Array<() => void> = [];
  let localPort: number | null = null;
  let stopped = false;
  let exited = false;
  let stop: () => void = () => {};

  const config = {
    kubeconfig: params.kubeconfig,
    namespace: params.namespace,
    resourceType: params.resourceType,
    resourceName: params.resourceName,
    remotePort: params.remotePort,
    localPort: params.localPort ?? 0,
  };

  return new Promise<PortForwardHandle>((resolve, reject) => {
    if (!isPortForwardResourceType(config.resourceType)) {
      reject(new Error(`Cannot port-forward a "${config.resourceType}"`));
      return;
    }
    const resourceType = config.resourceType;
    stop = forkRpc(
      Effect.gen(function* () {
        const rpc = yield* DesktopRpcClient;
        yield* Stream.runForEach(rpc.K8sPortForwardOpen({ ...config, resourceType }), (event) =>
          Effect.sync(() => {
            localPort = event.localPort;
            resolve({
              kind: "local",
              // The stream is the session; this only names it for the caller.
              sessionId: crypto.randomUUID(),
              localPort: event.localPort,
              onExit: (cb) => {
                if (exited) cb();
                else exitListeners.push(cb);
              },
              stop: () => {
                if (stopped) return;
                stopped = true;
                exitListeners.length = 0;
                stop();
              },
            });
          }),
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            exited = true;
            if (stopped) return;
            if (localPort === null) {
              reject(new Error(failureMessage(exit) ?? "kubectl port-forward exited"));
              return;
            }
            for (const cb of exitListeners) cb();
          }),
        ),
      ),
    );
  });
}

/** `svc`, `pod` or `deploy`: what `kubectl port-forward` takes. */
const isPortForwardResourceType = Schema.is(K8sPortForwardConfig.fields.resourceType);

interface CloudWsOpenParams {
  type: string;
  orgId: string;
  payload: Record<string, unknown>;
  dataType: string;
  closedType: string;
  errorType: string;
  resizeType: string;
}

async function openCloudWs(params: CloudWsOpenParams): Promise<K8sSessionHandle> {
  const token = await getCloudWsToken(params.orgId);
  if (!token) throw new Error("Not authenticated to Infrawrench Cloud");

  const wsUrl = await getCloudWsUrl();
  const ws = new WebSocket(`${wsUrl}/api/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";

  const dataListeners: Array<(d: Uint8Array) => void> = [];
  const exitListeners: Array<() => void> = [];
  const errorListeners: Array<(err: string) => void> = [];

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: params.type, ...params.payload }));
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type: string; data?: string; error?: string };
      if (msg.type === params.dataType && msg.data) {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        for (const cb of dataListeners) cb(bytes);
      } else if (msg.type === params.closedType) {
        for (const cb of exitListeners) cb();
      } else if (msg.type === params.errorType) {
        for (const cb of errorListeners) cb(msg.error ?? "Error");
      }
    } catch {
      /* ignore malformed messages */
    }
  });

  ws.addEventListener("close", () => {
    for (const cb of exitListeners) cb();
  });

  let killed = false;
  return {
    kind: "cloud",
    write: (data) => {
      if (killed || ws.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(data);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      ws.send(JSON.stringify({ type: params.dataType, data: btoa(binary) }));
    },
    resize: (cols, rows) => {
      if (killed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: params.resizeType, cols, rows }));
    },
    kill: () => {
      if (killed) return;
      killed = true;
      ws.close();
    },
    onData: (cb) => {
      dataListeners.push(cb);
    },
    onExit: (cb) => {
      exitListeners.push(cb);
    },
    onError: (cb) => {
      errorListeners.push(cb);
    },
  };
}
