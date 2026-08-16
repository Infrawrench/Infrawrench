/**
 * Linux application sessions, browser side.
 *
 * The mirror of the desktop's `lib/apps-session.ts`: one session per host,
 * shared by the launcher tab and every window tab looking at it. The only
 * difference is the transport — a WebSocket to `/api/apps` instead of IPC to a
 * main process — because a browser cannot hold an SSH connection itself.
 */

import {
  AppSession,
  probeClientCaps,
  type AppSessionTransport,
  type ClientCaps,
} from "@infrawrench/appstream-core";

import { apiPost } from "./api";

export interface AppsConnectTarget {
  orgId: string;
  accountId: string;
  resourceId: string;
  /** Org-managed key the host trusts; the private half stays on the server. */
  sshKeyId: string;
  host: string;
  username: string;
}

export interface HostStatus {
  /**
   * `connecting` is the socket; `starting` is the host getting the app server
   * up, which takes seconds — connect, stage a megabyte, exec. Distinguishing
   * them matters: without it a stalled session and a working one look
   * identical for as long as the user is willing to wait.
   */
  stage: "connecting" | "starting" | "ready" | "error";
  message?: string;
}

export interface HostAppsSession {
  session: AppSession;
  status(): HostStatus;
  subscribeStatus(listener: (status: HostStatus) => void): () => void;
  release(): void;
}

interface Entry {
  key: string;
  holders: number;
  status: HostStatus;
  listeners: Set<(status: HostStatus) => void>;
  session: AppSession;
  socket: WebSocket;
}

const entries = new Map<string, Entry>();

let capsPromise: Promise<ClientCaps> | undefined;
function caps(): Promise<ClientCaps> {
  // zstd is always on: the viewer decompresses in JS, so the host can always
  // use the lossless tier.
  capsPromise ??= probeClientCaps({ zstd: true });
  return capsPromise;
}

export function hostSessionKey(accountId: string, resourceId: string): string {
  return `${accountId}::${resourceId}`;
}

/** Join a session that is already open. A window tab has no key of its own. */
export function joinHostSession(key: string): HostAppsSession | null {
  const entry = entries.get(key);
  if (!entry) return null;
  entry.holders += 1;
  return view(entry);
}

export async function acquireHostSession(
  key: string,
  target: AppsConnectTarget,
): Promise<HostAppsSession> {
  const existing = entries.get(key);
  if (existing) {
    existing.holders += 1;
    return view(existing);
  }

  const clientCaps = await caps();
  // Single-use and short-lived: minted immediately before dialling, exactly as
  // the SSH terminal does.
  const { token } = await apiPost<{ token: string }>(`/api/org/${target.orgId}/ws-token`, {});

  const url = new URL(`/api/apps`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  url.searchParams.set("account", target.accountId);
  url.searchParams.set("resource", target.resourceId);
  url.searchParams.set("key", target.sshKeyId);
  url.searchParams.set("host", target.host);
  url.searchParams.set("user", target.username);

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  const listeners = new Set<(status: HostStatus) => void>();
  const incoming: Array<(bytes: Uint8Array) => void> = [];
  const closed: Array<() => void> = [];
  /** Frames the session sends before the socket finishes opening. */
  const pending: Uint8Array[] = [];

  const entry: Entry = {
    key,
    holders: 1,
    status: { stage: "connecting" },
    listeners,
    socket,
    session: undefined as unknown as AppSession,
  };

  const setStatus = (status: HostStatus) => {
    entry.status = status;
    for (const listener of listeners) listener(status);
  };

  socket.addEventListener("open", () => {
    // The socket is up; from here the wait is the host, not the network.
    setStatus({ stage: "starting" });
    // `send` wants a view over a plain ArrayBuffer; a Uint8Array typed against
    // ArrayBufferLike might be backed by a SharedArrayBuffer as far as TS knows.
    for (const frame of pending.splice(0)) socket.send(toBufferSource(frame));
  });
  socket.addEventListener("message", (event) => {
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    for (const handler of incoming) handler(bytes);
  });
  socket.addEventListener("close", (event) => {
    // 1000 is the app server exiting normally; anything else carries a reason
    // worth showing, and the browser gives us nothing else to go on.
    if (event.code !== 1000) {
      setStatus({ stage: "error", message: event.reason || "the connection closed" });
    }
    for (const handler of closed) handler();
    entries.delete(key);
  });
  socket.addEventListener("error", () => {
    setStatus({ stage: "error", message: "could not reach the app server" });
  });

  const transport: AppSessionTransport = {
    send: (bytes) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(toBufferSource(bytes));
      else pending.push(bytes);
    },
    onMessage: (handler) => incoming.push(handler),
    onClose: (handler) => closed.push(handler),
    close: () => socket.close(),
  };

  entry.session = new AppSession(transport, {
    caps: clientCaps,
    devicePixelRatio: window.devicePixelRatio || 1,
    events: {
      onReady: () => setStatus({ stage: "ready" }),
      onError: (message) => setStatus({ stage: "error", message }),
    },
  });

  entries.set(key, entry);
  return view(entry);
}

/** A copy the DOM will accept, without assuming where the view is backed. */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function view(entry: Entry): HostAppsSession {
  let released = false;
  return {
    session: entry.session,
    status: () => entry.status,
    subscribeStatus: (listener) => {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    release: () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders > 0) return;
      entries.delete(entry.key);
      try {
        entry.socket.close();
      } catch {
        /* already closing */
      }
    },
  };
}
