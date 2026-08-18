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
  type HostRequirementsCheck,
  type InstallOutcome,
  type RequirementId,
} from "@infrawrench/appstream-core";
import { parseNdjsonStream } from "@infrawrench/client-core";

import { apiPost } from "./api";

export interface AppsConnectTarget {
  orgId: string;
  accountId: string;
  resourceId: string;
  /**
   * The host's plugin and type. Not needed to connect — the window tabs each
   * live at this resource's URL, and on web that URL has both as path
   * segments.
   */
  pluginId: string;
  resourceTypeId: string;
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
      onClipboard: (blob) => writeToClipboard(blob),
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

/**
 * Text copied inside a remote application, put on this machine's clipboard.
 *
 * Best effort on purpose. Writing the clipboard needs a permission the browser
 * grants to a focused tab and withholds from a background one, and this
 * arrives whenever the application decides to copy rather than in response to
 * anything the user did *here*. A refusal means the paste does not work this
 * time, which is worth neither an error nor a prompt.
 */
function writeToClipboard(blob: { mimeType: string; data: Uint8Array }): void {
  if (!blob.mimeType.startsWith("text/plain")) return;
  const text = new TextDecoder().decode(blob.data);
  if (!text) return;
  void navigator.clipboard?.writeText(text).catch(() => {
    /* not focused, or not permitted; the next copy will try again */
  });
}

/**
 * The `{accountId, resourceId, sshKeyId, host, username}` the two setup routes
 * take — the same destination the WebSocket names, in a body rather than a
 * query.
 */
function setupBody(target: AppsConnectTarget) {
  return {
    accountId: target.accountId,
    resourceId: target.resourceId,
    sshKeyId: target.sshKeyId,
    host: target.host,
    username: target.username,
  };
}

/**
 * What this host is missing before it can run applications.
 *
 * Its own request rather than part of the session: the point is to answer on a
 * host where opening a session would fail, and the missing piece may be the
 * `gunzip` that unpacks the app server.
 */
export async function checkHostRequirements(
  target: AppsConnectTarget,
): Promise<HostRequirementsCheck> {
  return await apiPost<HostRequirementsCheck>(
    `/api/org/${target.orgId}/apps/check`,
    setupBody(target),
  );
}

/**
 * Install what is missing, calling `onOutput` per line as the host prints it.
 *
 * NDJSON rather than a plain response because an `apt-get install` is tens of
 * seconds long, and a spinner in front of something installing packages on your
 * server is not enough information. The final object carries the outcome; an
 * `error` object is how a failure arrives, since the status line has already
 * been sent by the time anything can go wrong.
 */
export async function installHostRequirements(
  target: AppsConnectTarget,
  requirements: RequirementId[],
  onOutput: (line: string) => void,
): Promise<InstallOutcome> {
  const response = await fetch(`/api/org/${target.orgId}/apps/setup`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...setupBody(target), requirements }),
  });
  if (!response.ok || !response.body) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Install failed (${response.status})`);
  }

  let outcome: InstallOutcome | undefined;
  for await (const event of parseNdjsonStream<{
    line?: string;
    outcome?: InstallOutcome;
    error?: string;
  }>(response.body)) {
    if (event.line !== undefined) onOutput(event.line);
    if (event.error) throw new Error(event.error);
    if (event.outcome) outcome = event.outcome;
  }
  if (!outcome) throw new Error("The host stopped responding during the install.");
  return outcome;
}
