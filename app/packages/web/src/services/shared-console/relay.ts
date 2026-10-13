/**
 * Shared consoles across replicas, through the console relay
 * (`server-core/realtime/protocol.ts`, `web/edge/realtime.ts`).
 *
 * The pty lives in one replica's memory, and everything about a shared
 * console (creating the share, joining, handing over, removing, revoking) has
 * to reach that replica. The ingress used to get guests there by hashing
 * `?sid=`; that only ever covered the WebSocket, and nothing in front of the
 * Oracle Cloud VMs hashes at all. Now:
 *
 * - The replica that owns a pty keeps a **host link** to the console's relay
 *   object for the session's life (`startHostLink`, from `ssh-proxy`).
 * - The routes call the functions at the bottom of this file. When the pty is
 *   here they are the hub's own methods; when it is not, they become a **call**
 *   the relay hands to the owner over its host link.
 * - A guest whose socket lands on the wrong replica is **bridged**: this
 *   replica authorises them exactly as before (`attach.ts`), then opens a viewer
 *   socket to the relay and pipes frames both ways; the owner attaches a
 *   {@link RelayedSocket} to its hub, so the hub cannot tell the difference.
 *
 * Every decision stays in the owner's `SharedConsoleHub`. Without the relay
 * (`realtimeEnabled()` false) all of this falls back to the in-process path,
 * which is exactly the old behaviour.
 */
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import {
  realtimeEnabled,
  realtimeFetch,
  realtimeHeaders,
  realtimeWsUrl,
} from "@infrawrench/server-core/realtime/client";
import {
  consoleHostPath,
  consoleRpcPath,
  consoleViewerPath,
  type ConsoleHostToRelay,
  type ConsoleRelayToHost,
  type ConsoleRpcMethod,
} from "@infrawrench/server-core/realtime/protocol";
import {
  getParticipantById,
  getSharedConsole,
  getSharedConsoleByLiveId,
  listParticipants,
  type ParticipantRow,
  type SharedConsoleRow,
} from "@infrawrench/server-core/shared-console/store";
import type { DetachReason } from "@infrawrench/server-core/shared-console/arbitration";
import { sharedConsoleHub } from "./hub";

/** An observer whose socket has this much unsent data is cut off (as in the hub). */
const OBSERVER_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const OPEN = 1;

/**
 * `ws`, loaded on first use: the routes that import this module are bundled
 * into the edge Worker too, which never opens a relay socket.
 */
let wsModule: Promise<typeof import("ws")> | null = null;
function loadWs(): Promise<typeof import("ws")> {
  wsModule ??= import("ws");
  return wsModule;
}

// ---------------------------------------------------------------- host side

/**
 * A guest attached through the relay, as the hub sees it: the slice of the
 * `ws` API the hub uses, backed by the host link.
 */
class RelayedSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;

  constructor(
    private readonly link: HostLink,
    readonly viewer: string,
  ) {
    super();
  }

  /** What is queued towards the relay; the bridging replica polices its own guest. */
  get bufferedAmount(): number {
    return this.link.bufferedAmount;
  }

  send(data: string): void {
    if (this.readyState !== this.OPEN) return;
    this.link.send({ op: "to-viewer", viewer: this.viewer, data });
  }

  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.link.send({ op: "close-viewer", viewer: this.viewer });
    this.emit("close");
  }

  /** The guest's socket closed at the bridging replica. */
  gone(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit("close");
  }
}

class HostLink {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = RECONNECT_MIN_MS;
  private readonly viewers = new Map<string, RelayedSocket>();

  constructor(private readonly liveConsoleId: string) {
    void this.connect();
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  send(message: ConsoleHostToRelay): void {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(message));
  }

  stop(): void {
    this.stopped = true;
    for (const viewer of this.viewers.values()) viewer.gone();
    this.viewers.clear();
    this.ws?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const { default: WebSocket } = await loadWs();
    if (this.stopped) return;
    const ws = new WebSocket(realtimeWsUrl(consoleHostPath(this.liveConsoleId)), {
      headers: realtimeHeaders(),
    });
    this.ws = ws;
    ws.on("open", () => {
      this.retryMs = RECONNECT_MIN_MS;
    });
    ws.on("message", (raw) => {
      let msg: ConsoleRelayToHost;
      try {
        msg = JSON.parse(raw.toString()) as ConsoleRelayToHost;
      } catch {
        return;
      }
      void this.handle(msg).catch((err: unknown) =>
        console.error(`[shared-console] relay message for ${this.liveConsoleId} failed:`, err),
      );
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // The relay dropped every bridged guest with the link; so do we.
      for (const viewer of this.viewers.values()) viewer.gone();
      this.viewers.clear();
      if (this.stopped) return;
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
      setTimeout(() => void this.connect(), delay).unref();
    });
    ws.on("error", () => {
      /* close follows */
    });
  }

  private async handle(msg: ConsoleRelayToHost): Promise<void> {
    switch (msg.op) {
      case "rpc": {
        try {
          const result = await runLocal(this.liveConsoleId, msg.method, msg.args);
          this.send({ op: "rpc-result", id: msg.id, ok: true, result: result ?? null });
        } catch (err) {
          this.send({
            op: "rpc-result",
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "viewer-open": {
        const socket = new RelayedSocket(this, msg.viewer);
        this.viewers.set(msg.viewer, socket);
        socket.on("close", () => this.viewers.delete(msg.viewer));
        await attachRelayed(this.liveConsoleId, socket, msg.participantId);
        return;
      }
      case "viewer-frame": {
        this.viewers.get(msg.viewer)?.emit("message", Buffer.from(msg.data));
        return;
      }
      case "viewer-gone": {
        this.viewers.get(msg.viewer)?.gone();
        this.viewers.delete(msg.viewer);
        return;
      }
    }
  }
}

const hostLinks = new Map<string, HostLink>();

/** Called by `ssh-proxy` when a shell opens: make this pty reachable. */
export function startHostLink(liveConsoleId: string): void {
  if (!realtimeEnabled() || hostLinks.has(liveConsoleId)) return;
  hostLinks.set(liveConsoleId, new HostLink(liveConsoleId));
}

/** Called by `ssh-proxy` on teardown. */
export function stopHostLink(liveConsoleId: string): void {
  hostLinks.get(liveConsoleId)?.stop();
  hostLinks.delete(liveConsoleId);
}

/**
 * Attach a bridged guest on the owning replica. The bridging replica already
 * authorised them (`attach.ts`); the rows are re-read here so the hub works
 * from the same fresh view a local attach does.
 */
async function attachRelayed(
  liveConsoleId: string,
  socket: RelayedSocket,
  participantId: string,
): Promise<void> {
  const share = await getSharedConsoleByLiveId(liveConsoleId);
  const participant = share ? await getParticipantById(participantId) : null;
  if (!share || !participant || participant.sharedConsoleId !== share.id) {
    socket.send(
      JSON.stringify({
        type: "console:error",
        code: "console_not_shared",
        error: "That session is no longer shared.",
      }),
    );
    socket.close();
    return;
  }
  const participants = await listParticipants(share.id);
  const attached = sharedConsoleHub.attach({
    ws: socket as unknown as Parameters<typeof sharedConsoleHub.attach>[0]["ws"],
    liveConsoleId,
    share,
    participant,
    participants,
  });
  if (!attached.ok) {
    socket.send(
      JSON.stringify({
        type: "console:error",
        code: attached.code,
        error: "That session is no longer shared.",
      }),
    );
    socket.close();
    return;
  }
  socket.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        data?: string;
        cols?: number;
        rows?: number;
      };
      if (!msg.type.startsWith("console:")) return;
      sharedConsoleHub.handleAttachedMessage(liveConsoleId, participant.id, msg);
    } catch {
      /* ignore malformed frames */
    }
  });
}

/** A call from another replica, run against this replica's hub. */
async function runLocal(
  liveConsoleId: string,
  method: ConsoleRpcMethod,
  args: unknown[],
): Promise<unknown> {
  switch (method) {
    case "describe":
      return sharedConsoleHub.describe(liveConsoleId);
    case "bindShare": {
      const [shareId, ownerParticipantId] = args as [string, string];
      const [share, owner] = await Promise.all([
        getSharedConsole(shareId),
        getParticipantById(ownerParticipantId),
      ]);
      if (!share || !owner) return false;
      return sharedConsoleHub.bindShare(liveConsoleId, share, owner);
    }
    case "mark": {
      const [shareId, label] = args as [string, string];
      sharedConsoleHub.mark(shareId, label);
      return null;
    }
    case "refresh": {
      const [shareId] = args as [string];
      await sharedConsoleHub.refresh(shareId);
      return null;
    }
    case "detach": {
      const [participantId, reason, message] = args as [string, DetachReason, string];
      sharedConsoleHub.detach(liveConsoleId, participantId, reason, message);
      return null;
    }
    case "revoke": {
      const [shareId] = args as [string];
      sharedConsoleHub.revokeLocal(shareId);
      return null;
    }
  }
}

// -------------------------------------------------------------- other side

/** Call the owning replica's hub; `undefined` when no replica holds the pty. */
async function callOwner(
  liveConsoleId: string,
  method: ConsoleRpcMethod,
  args: unknown[],
): Promise<unknown> {
  if (!realtimeEnabled()) return undefined;
  const response = await realtimeFetch(consoleRpcPath(liveConsoleId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  if (response.status === 404) return undefined;
  const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok)
    throw new Error(`shared console ${method} on the owning replica failed: ${body.error}`);
  return body.result;
}

/**
 * Bridge a guest's socket to the replica that owns the pty. Resolves false
 * when no replica does (the caller reports `console_not_here`, as before).
 */
export function bridgeViewer(
  browser: WebSocket,
  liveConsoleId: string,
  participantId: string,
): Promise<boolean> {
  if (!realtimeEnabled()) return Promise.resolve(false);
  return loadWs().then(
    ({ default: WebSocket }) =>
      new Promise<boolean>((resolve) => {
        const relay = new WebSocket(
          realtimeWsUrl(consoleViewerPath(liveConsoleId, participantId)),
          {
            headers: realtimeHeaders(),
          },
        );
        let opened = false;
        relay.on("unexpected-response", () => {
          relay.terminate();
          resolve(false);
        });
        relay.on("open", () => {
          opened = true;
          resolve(true);
        });
        relay.on("message", (raw) => {
          if (browser.readyState !== browser.OPEN) return;
          // A slow guest is dropped rather than buffering the owner's output here.
          if (browser.bufferedAmount > OBSERVER_BUFFER_LIMIT_BYTES) {
            browser.send(
              JSON.stringify({
                type: "console:detached",
                reason: "share-ended",
                message: "Your connection could not keep up with this session's output.",
              }),
            );
            browser.close();
            relay.close();
            return;
          }
          browser.send(raw.toString());
        });
        relay.on("close", () => {
          if (opened && browser.readyState === browser.OPEN) browser.close();
        });
        relay.on("error", () => {
          if (!opened) resolve(false);
        });
        browser.on("message", (raw) => {
          if (relay.readyState === OPEN) relay.send(raw.toString());
        });
        browser.on("close", () => relay.close());
      }),
  );
}

/** The pty's description, wherever it lives; null when no replica holds it. */
export async function describeConsole(
  liveConsoleId: string,
): Promise<ReturnType<typeof sharedConsoleHub.describe>> {
  if (sharedConsoleHub.has(liveConsoleId)) return sharedConsoleHub.describe(liveConsoleId);
  const result = await callOwner(liveConsoleId, "describe", []);
  return (result ?? null) as ReturnType<typeof sharedConsoleHub.describe>;
}

/** Bind a new share to the live pty, wherever it lives. */
export async function bindShare(
  liveConsoleId: string,
  share: SharedConsoleRow,
  owner: ParticipantRow,
): Promise<boolean> {
  if (sharedConsoleHub.has(liveConsoleId))
    return sharedConsoleHub.bindShare(liveConsoleId, share, owner);
  return (await callOwner(liveConsoleId, "bindShare", [share.id, owner.id])) === true;
}

/**
 * The fire-and-forget operations the routes run after a mutation. A failed
 * call is logged, not thrown: the owner's sweep re-reads the rows within two
 * seconds, which is the same guarantee the other replica always had.
 */
function forward(
  share: SharedConsoleRow,
  method: ConsoleRpcMethod,
  args: unknown[],
): Promise<void> {
  return callOwner(share.liveConsoleId, method, args).then(
    () => undefined,
    (err: unknown) => console.error(`[shared-console] ${method} for ${share.id} failed:`, err),
  );
}

export function markShare(share: SharedConsoleRow, label: string): void {
  if (sharedConsoleHub.has(share.liveConsoleId)) return sharedConsoleHub.mark(share.id, label);
  void forward(share, "mark", [share.id, label]);
}

export async function refreshShare(share: SharedConsoleRow): Promise<void> {
  if (sharedConsoleHub.has(share.liveConsoleId)) return sharedConsoleHub.refresh(share.id);
  await forward(share, "refresh", [share.id]);
}

export function detachParticipant(
  share: SharedConsoleRow,
  participantId: string,
  reason: DetachReason,
  message: string,
): void {
  if (sharedConsoleHub.has(share.liveConsoleId)) {
    return sharedConsoleHub.detach(share.liveConsoleId, participantId, reason, message);
  }
  void forward(share, "detach", [participantId, reason, message]);
}

export function revokeShare(share: SharedConsoleRow): void {
  if (sharedConsoleHub.has(share.liveConsoleId)) return sharedConsoleHub.revokeLocal(share.id);
  void forward(share, "revoke", [share.id]);
}
