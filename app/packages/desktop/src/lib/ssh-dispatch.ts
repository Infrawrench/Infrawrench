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

export interface SshJumpHop {
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

async function openCloudShell(params: CloudShellParams): Promise<SshShellHandle> {
  const token = await invoke<string | null>("cloud_auth_get_ws_token", { orgId: params.orgId });
  if (!token) throw new Error("Not authenticated to Infrawrench Cloud");

  const wsUrl = await getCloudWsUrl();
  const ws = new WebSocket(`${wsUrl}/api/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";

  const dataListeners: Array<(d: Uint8Array) => void> = [];
  const exitListeners: Array<() => void> = [];
  const errorListeners: Array<(err: string) => void> = [];

  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "ssh:open",
        accountId: params.accountId,
        resourceId: params.resourceId,
        sshKeyId: params.keySource.sshKeyId,
        sshHost: params.host,
        sshUsername: params.username,
        cols: params.cols,
        rows: params.rows,
        ...(params.agentForward ? { agentForward: true } : {}),
        ...(params.connectThroughAccountId
          ? { connectThroughAccountId: params.connectThroughAccountId }
          : {}),
      }),
    );
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        type: string;
        data?: string;
        error?: string;
      };
      if (msg.type === "ssh:data" && msg.data) {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        for (const cb of dataListeners) cb(bytes);
      } else if (msg.type === "ssh:closed") {
        for (const cb of exitListeners) cb();
      } else if (msg.type === "ssh:error") {
        for (const cb of errorListeners) cb(msg.error ?? "SSH error");
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
    write: (data: string) => {
      if (killed || ws.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(data);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      ws.send(JSON.stringify({ type: "ssh:data", data: btoa(binary) }));
    },
    resize: (cols: number, rows: number) => {
      if (killed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "ssh:resize", cols, rows }));
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
