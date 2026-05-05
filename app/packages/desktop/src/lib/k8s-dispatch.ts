/**
 * K8s dispatcher — routes k8s exec, k9s, and port-forward between local
 * IPC (kubectl/k9s on the local host) and the cloud WebSocket proxy at
 * `/api/ws`.
 *
 * Rule: if `activeCloudOrgId` is set on the UI store, everything goes through
 * the WS proxy and cloud IPCs. Otherwise — local IPC.
 */

import { invoke } from "./invoke";
import { getCloudWsUrl } from "./cloud-ws";

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

async function openLocalExec(params: LocalExecParams): Promise<K8sSessionHandle> {
  const id = await invoke<string>("k8s_exec_spawn", {
    kubeconfig: params.kubeconfig,
    namespace: params.namespace,
    podName: params.podName,
    ...(params.containerName ? { containerName: params.containerName } : {}),
    cols: params.cols,
    rows: params.rows,
  });
  return bindLocalPty(id, "k8s_exec");
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
  const id = await invoke<string>("k9s_spawn", {
    kubeconfig: params.kubeconfig,
    ...(params.namespace ? { namespace: params.namespace } : {}),
    cols: params.cols,
    rows: params.rows,
  });
  return bindLocalPty(id, "k9s");
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
  if (params.mode === "cloud") {
    const result = await invoke<{ sessionId: string; localPort: number }>("k8s_pf_cloud_start", {
      orgId: params.orgId,
      accountId: params.accountId,
      resourceId: params.resourceId,
      peerPluginId: params.peerPluginId,
      namespace: params.namespace,
      resourceType: params.resourceType,
      resourceName: params.resourceName,
      remotePort: params.remotePort,
      ...(params.localPort !== undefined ? { localPort: params.localPort } : {}),
    });
    const sessionId = result.sessionId;
    return {
      kind: "cloud",
      sessionId,
      localPort: result.localPort,
      onExit: (cb) => {
        window.electronAPI.on(`k8s_pf_cloud_exit_${sessionId}`, () => cb());
      },
      stop: () => {
        void invoke("k8s_pf_cloud_stop", { sessionId });
        window.electronAPI.offAll(`k8s_pf_cloud_exit_${sessionId}`);
      },
    };
  }
  const result = await invoke<{ sessionId: string; localPort: number }>("k8s_pf_start", {
    kubeconfig: params.kubeconfig,
    namespace: params.namespace,
    resourceType: params.resourceType,
    resourceName: params.resourceName,
    remotePort: params.remotePort,
    localPort: params.localPort ?? 0,
  });
  const sessionId = result.sessionId;
  return {
    kind: "local",
    sessionId,
    localPort: result.localPort,
    onExit: (cb) => {
      window.electronAPI.on(`k8s_pf_exit_${sessionId}`, () => cb());
    },
    stop: () => {
      void invoke("k8s_pf_stop", { sessionId });
      window.electronAPI.offAll(`k8s_pf_exit_${sessionId}`);
    },
  };
}

function bindLocalPty(id: string, namespace: "k8s_exec" | "k9s"): K8sSessionHandle {
  const dataListeners: Array<(d: Uint8Array) => void> = [];
  const exitListeners: Array<() => void> = [];

  window.electronAPI.on(`${namespace}_data_${id}`, (...args) => {
    const data = args[0] as Uint8Array;
    for (const cb of dataListeners) cb(data);
  });
  window.electronAPI.on(`${namespace}_exit_${id}`, () => {
    for (const cb of exitListeners) cb();
  });

  let killed = false;
  return {
    kind: "local",
    write: (data) => {
      if (killed) return;
      void invoke(`${namespace}_write`, { sessionId: id, data });
    },
    resize: (cols, rows) => {
      if (killed) return;
      void invoke(`${namespace}_resize`, { sessionId: id, cols, rows });
    },
    kill: () => {
      if (killed) return;
      killed = true;
      window.electronAPI.offAll(`${namespace}_data_${id}`);
      window.electronAPI.offAll(`${namespace}_exit_${id}`);
      void invoke(`${namespace}_kill`, { sessionId: id });
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
}

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
  const token = await invoke<string | null>("cloud_auth_get_ws_token", { orgId: params.orgId });
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
