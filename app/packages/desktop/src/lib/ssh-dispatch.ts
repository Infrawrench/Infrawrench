/**
 * SSH dispatcher — routes SSH shell, exec, and SFTP operations between local
 * IPC (ssh2 in the electron main process) and the cloud WebSocket proxy at
 * `/api/ws`.
 *
 * Rule: if the user-selected key is a cloud key (private key lives in
 * Infrawrench Cloud), everything goes through the WS proxy. Otherwise —
 * system, app, or pageant — local IPC handles it, regardless of whether
 * the active workspace is cloud or local.
 */

import { invoke } from "./invoke";
import type { KeySource } from "./ssh-key-source";
import { getCloudWsUrl } from "./cloud-ws";

export interface SshShellHandle {
  kind: "local" | "cloud";
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (cb: (data: Uint8Array) => void) => void;
  onExit: (cb: () => void) => void;
  onError: (cb: (err: string) => void) => void;
}

interface SshJumpHop {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

interface CloudShellParams {
  orgId: string;
  keySource: Extract<KeySource, { type: "cloud" }>;
  accountId: string;
  resourceId?: string;
  host: string;
  port?: number;
  username: string;
  cols: number;
  rows: number;
  agentForward?: boolean;
  /** Account id of an SSH plugin jumpbox to route through. The cloud proxy resolves the chain. */
  connectThroughAccountId?: string;
}

interface LocalShellParams {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  cols: number;
  rows: number;
  agentForward?: boolean;
  /** Pre-resolved chain of jump hops, outermost-first. The renderer is responsible for loading them. */
  jumpHops?: SshJumpHop[];
}

type OpenSshShellParams =
  | ({ mode: "cloud" } & CloudShellParams)
  | ({ mode: "local" } & LocalShellParams);

export async function openSshShell(params: OpenSshShellParams): Promise<SshShellHandle> {
  if (params.mode === "cloud") {
    return openCloudShell(params);
  }
  return openLocalShell(params);
}

async function openLocalShell(params: LocalShellParams): Promise<SshShellHandle> {
  const id = await invoke<string>("ssh_shell_spawn", {
    host: params.host,
    port: params.port,
    username: params.username,
    privateKey: params.privateKey,
    cols: params.cols,
    rows: params.rows,
    ...(params.agentForward ? { agentForward: true } : {}),
    ...(params.jumpHops && params.jumpHops.length > 0 ? { jumpHops: params.jumpHops } : {}),
  });

  const dataListeners: Array<(d: Uint8Array) => void> = [];
  const exitListeners: Array<() => void> = [];

  window.electronAPI.on(`ssh_shell_data_${id}`, (...args) => {
    const data = args[0] as Uint8Array;
    for (const cb of dataListeners) cb(data);
  });
  window.electronAPI.on(`ssh_shell_exit_${id}`, () => {
    for (const cb of exitListeners) cb();
  });

  let killed = false;
  return {
    kind: "local",
    write: (data: string) => {
      if (killed) return;
      void invoke("ssh_shell_write", { shellId: id, data });
    },
    resize: (cols: number, rows: number) => {
      if (killed) return;
      void invoke("ssh_shell_resize", { shellId: id, cols, rows });
    },
    kill: () => {
      if (killed) return;
      killed = true;
      window.electronAPI.offAll(`ssh_shell_data_${id}`);
      window.electronAPI.offAll(`ssh_shell_exit_${id}`);
      void invoke("ssh_shell_kill", { shellId: id });
    },
    onData: (cb) => {
      dataListeners.push(cb);
    },
    onExit: (cb) => {
      exitListeners.push(cb);
    },
    onError: () => {
      /* local errors surface via exit/reject */
    },
  };
}

interface CloudSshErrorFrame {
  type: string;
  data?: string;
  error?: string;
  code?: string;
  kind?: "unknown" | "mismatch";
  host?: string;
  port?: number;
  presentedFingerprint?: string;
  storedFingerprint?: string | null;
}

async function openCloudShell(params: CloudShellParams): Promise<SshShellHandle> {
  const wsUrl = await getCloudWsUrl();

  const dataListeners: Array<(d: Uint8Array) => void> = [];
  const exitListeners: Array<() => void> = [];
  const errorListeners: Array<(err: string) => void> = [];

  let killed = false;
  let activeWs: WebSocket | null = null;
  const size = { cols: params.cols, rows: params.rows };

  // Writes are buffered until the proxy reports `ssh:connected`.
  //
  // Unlike the local handle — which resolves only once the shell is actually
  // spawned — this function returns as soon as the socket is *created*, so a
  // caller that writes immediately (the agent tabs send their launch command
  // the moment the handle resolves) would otherwise lose it twice over: the
  // socket is still CONNECTING here, and on the server the `ws.on("message")`
  // that forwards `ssh:data` is registered inside the `conn.shell()` callback,
  // so anything sent before `ssh:connected` has no listener at all. The
  // symptom is an agent terminal that connects to a normal shell prompt with
  // the command silently dropped. WebTerminal already writes on
  // `ssh:connected`; buffering here gives every desktop caller the same
  // guarantee without each one having to know about the frame.
  let connected = false;
  let pending: string[] = [];
  // A shell that never connects must not grow this without bound; a few
  // keystrokes plus a launch command is the realistic worst case.
  const MAX_PENDING_WRITES = 256;

  const sendData = (ws: WebSocket, data: string): void => {
    const bytes = new TextEncoder().encode(data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    ws.send(JSON.stringify({ type: "ssh:data", data: btoa(binary) }));
  };

  const flushPending = (): void => {
    if (!connected || killed) return;
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) return;
    const queued = pending;
    pending = [];
    for (const data of queued) sendData(activeWs, data);
  };

  const getToken = async (): Promise<string> => {
    const token = await invoke<string | null>("cloud_auth_get_ws_token", { orgId: params.orgId });
    if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
    return token;
  };

  // The proxy reports an untrusted/changed host key as a structured ssh:error
  // frame. Mirror the local-IPC terminal: show the native prompt, record the
  // pin in the org's cloud trust store, then reconnect on a fresh socket (the
  // proxy tears the SSH session down when the verifier rejects).
  const handleTrustRequired = async (ws: WebSocket, msg: CloudSshErrorFrame) => {
    const trusted = await invoke<boolean>("cloud_ssh_host_key_trust", {
      orgId: params.orgId,
      host: msg.host,
      port: msg.port ?? 22,
      kind: msg.kind ?? "unknown",
      presentedFingerprint: msg.presentedFingerprint,
      storedFingerprint: msg.storedFingerprint ?? null,
    });
    if (killed) return;
    if (!trusted) {
      for (const cb of errorListeners) cb(msg.error ?? "SSH host key not trusted");
      return;
    }
    try {
      connect(await getToken());
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    } catch (err) {
      for (const cb of errorListeners) cb(err instanceof Error ? err.message : String(err));
    }
  };

  const connect = (token: string): void => {
    const ws = new WebSocket(`${wsUrl}/api/ws?token=${encodeURIComponent(token)}`);
    ws.binaryType = "arraybuffer";
    activeWs = ws;
    // A post-trust reconnect gets a fresh shell, so anything still queued must
    // wait for the new one rather than being sent at a socket with no shell.
    connected = false;

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "ssh:open",
          accountId: params.accountId,
          resourceId: params.resourceId,
          sshKeyId: params.keySource.sshKeyId,
          sshHost: params.host,
          sshUsername: params.username,
          cols: size.cols,
          rows: size.rows,
          ...(params.agentForward ? { agentForward: true } : {}),
          ...(params.connectThroughAccountId
            ? { connectThroughAccountId: params.connectThroughAccountId }
            : {}),
        }),
      );
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as CloudSshErrorFrame;
        if (msg.type === "ssh:connected") {
          connected = true;
          flushPending();
        } else if (msg.type === "ssh:data" && msg.data) {
          const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
          for (const cb of dataListeners) cb(bytes);
        } else if (msg.type === "ssh:closed") {
          for (const cb of exitListeners) cb();
        } else if (msg.type === "ssh:error") {
          if (msg.code === "ssh_host_key_trust_required" && msg.host && msg.presentedFingerprint) {
            void handleTrustRequired(ws, msg);
          } else {
            for (const cb of errorListeners) cb(msg.error ?? "SSH error");
          }
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    ws.addEventListener("close", () => {
      // A socket superseded by a post-trust reconnect must not tear the
      // terminal down.
      if (ws !== activeWs) return;
      for (const cb of exitListeners) cb();
    });
  };

  connect(await getToken());

  return {
    kind: "cloud",
    write: (data: string) => {
      if (killed) return;
      if (!connected || activeWs?.readyState !== WebSocket.OPEN) {
        if (pending.length < MAX_PENDING_WRITES) pending.push(data);
        return;
      }
      sendData(activeWs, data);
    },
    resize: (cols: number, rows: number) => {
      size.cols = cols;
      size.rows = rows;
      if (killed || activeWs?.readyState !== WebSocket.OPEN) return;
      activeWs.send(JSON.stringify({ type: "ssh:resize", cols, rows }));
    },
    kill: () => {
      if (killed) return;
      killed = true;
      pending = [];
      activeWs?.close();
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
