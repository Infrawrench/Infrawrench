/**
 * The client's half of a session: handshake, window bookkeeping, and the acks
 * that keep frames flowing.
 *
 * Transport-free by design — Electron's main process relays over IPC, the web
 * app over a WebSocket, and a test over an array — so everything here is about
 * protocol state and nothing about how bytes travel.
 */

import {
  FrameDecoder,
  FrameKind,
  SESSION_WINDOW,
  decodeClipboardBlob,
  encodeClipboardBlob,
  encodeFrame,
  PROTOCOL_VERSION,
  type ClipboardBlob,
} from "./frame.js";
import { encodeInputBatch, type InputEvent } from "./input.js";
import {
  decodeServerMessage,
  encodeControl,
  type AppEntry,
  type ClientCaps,
  type ClientMessage,
  type ServerMessage,
} from "./messages.js";
import { decodePixelPayload, type PixelPayload } from "./pixels.js";

export interface AppSessionTransport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface WindowInfo {
  windowId: number;
  appId?: string;
  title: string;
  icon?: string;
  width: number;
  height: number;
  /** Set for a dialog; the viewer draws it into the parent's tab. */
  parentWindowId?: number;
}

/**
 * The host's answer to one `launch`.
 *
 * A failure is not a session failure: the compositor is still there and every
 * other application still starts. It arrives two ways — `launchResult` for an
 * entry the host refused outright, and an `error` frame carrying `unknownApp`
 * or `launchFailed` for one that was spawned and died — and both mean the same
 * thing to whoever asked, so the session normalises them into this.
 */
export interface LaunchResult {
  ok: boolean;
  /** Why it failed, from the host — usually the child's own stderr. */
  message?: string;
  appId?: string;
}

export interface AppSessionEvents {
  onReady?(welcome: Extract<ServerMessage, { type: "welcome" }>): void;
  onApps?(apps: AppEntry[], complete: boolean): void;
  onWindowOpen?(window: WindowInfo): void;
  onWindowMeta?(window: WindowInfo): void;
  onWindowClose?(windowId: number, reason: string): void;
  /** New pixels for a window. The session acks once this returns. */
  onFrame?(windowId: number, payload: PixelPayload): void;
  onCursor?(windowId: number, shape: string | undefined): void;
  onClipboard?(blob: ClipboardBlob): void;
  onLaunchResult?(ok: boolean, message: string | undefined, appId: string | undefined): void;
  /**
   * Fatal, session-wide errors only. A launch that failed goes to
   * `onLaunchResult` and the launch listeners instead — see `LaunchResult`.
   */
  onError?(message: string, code?: string): void;
  onClose?(): void;
}

export interface AppSessionOptions {
  caps: ClientCaps;
  /** Device pixel ratio of the surface the window will be painted on. */
  devicePixelRatio?: number;
  events?: AppSessionEvents;
}

export class AppSession {
  #transport: AppSessionTransport;
  #decoder = new FrameDecoder();
  #events: AppSessionEvents;
  #windows = new Map<number, WindowInfo>();
  /** Buffered until `welcome` lands: the server rejects anything before it. */
  #queued: ClientMessage[] = [];
  #ready = false;
  #closed = false;
  /**
   * Per-window subscribers, on top of the single `events` object the session's
   * owner passes in. A viewer component mounts and unmounts independently of
   * the session, and there may be several — one per open window tab.
   */
  #frameListeners = new Set<(windowId: number, payload: PixelPayload) => void>();
  #cursorListeners = new Set<(windowId: number, shape: string | undefined) => void>();
  /** Window opened, or its title/icon changed. */
  #windowListeners = new Set<(windowId: number, window: WindowInfo) => void>();
  #windowCloseListeners = new Set<(windowId: number, reason: string) => void>();
  #appsListeners = new Set<(apps: AppEntry[], complete: boolean) => void>();
  #launchListeners = new Set<(result: LaunchResult) => void>();
  #sessionId: string | undefined;

  constructor(transport: AppSessionTransport, options: AppSessionOptions) {
    this.#transport = transport;
    this.#events = options.events ?? {};

    transport.onMessage((bytes) => this.#receive(bytes));
    transport.onClose(() => {
      this.#closed = true;
      this.#events.onClose?.();
    });

    this.#sendNow({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      caps: options.caps,
      // The host configures windows at the ratio they will be shown at, so a
      // retina viewer gets a buffer it does not have to upscale.
      devicePixelRatio: options.devicePixelRatio ?? 1,
    });
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** The host's id for this session, once it has greeted us. */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  get windows(): WindowInfo[] {
    return [...this.#windows.values()];
  }

  window(windowId: number): WindowInfo | undefined {
    return this.#windows.get(windowId);
  }

  /** Subscribe to pixels. The session acks once every listener has returned. */
  addFrameListener(listener: (windowId: number, payload: PixelPayload) => void): void {
    this.#frameListeners.add(listener);
  }

  removeFrameListener(listener: (windowId: number, payload: PixelPayload) => void): void {
    this.#frameListeners.delete(listener);
  }

  /** Called when a window opens and whenever its title or icon changes. */
  addWindowListener(listener: (windowId: number, window: WindowInfo) => void): void {
    this.#windowListeners.add(listener);
  }

  removeWindowListener(listener: (windowId: number, window: WindowInfo) => void): void {
    this.#windowListeners.delete(listener);
  }

  addWindowCloseListener(listener: (windowId: number, reason: string) => void): void {
    this.#windowCloseListeners.add(listener);
  }

  removeWindowCloseListener(listener: (windowId: number, reason: string) => void): void {
    this.#windowCloseListeners.delete(listener);
  }

  /** Subscribe to application lists, which arrive in response to `listApps`. */
  addAppsListener(listener: (apps: AppEntry[], complete: boolean) => void): void {
    this.#appsListeners.add(listener);
  }

  removeAppsListener(listener: (apps: AppEntry[], complete: boolean) => void): void {
    this.#appsListeners.delete(listener);
  }

  /**
   * Subscribe to launch outcomes. Nothing else tells the caller that the
   * application it asked for is not coming: a launch that fails opens no
   * window, so without this a click on a broken entry is indistinguishable
   * from a slow one.
   */
  addLaunchResultListener(listener: (result: LaunchResult) => void): void {
    this.#launchListeners.add(listener);
  }

  removeLaunchResultListener(listener: (result: LaunchResult) => void): void {
    this.#launchListeners.delete(listener);
  }

  addCursorListener(listener: (windowId: number, shape: string | undefined) => void): void {
    this.#cursorListeners.add(listener);
  }

  removeCursorListener(listener: (windowId: number, shape: string | undefined) => void): void {
    this.#cursorListeners.delete(listener);
  }

  listApps(refresh = false): void {
    this.#send({ type: "listApps", refresh });
  }

  launch(target: { appId?: string; exec?: string; cwd?: string }): void {
    this.#send({ type: "launch", ...target });
  }

  attach(windowId: number, width: number, height: number, scale: number): void {
    this.#send({ type: "attach", windowId, width, height, scale });
  }

  detach(windowId: number): void {
    this.#send({ type: "detach", windowId });
  }

  resize(windowId: number, width: number, height: number, scale: number): void {
    this.#send({ type: "resize", windowId, width, height, scale });
  }

  closeWindow(windowId: number): void {
    this.#send({ type: "closeWindow", windowId });
  }

  sendInput(windowId: number, events: InputEvent[]): void {
    if (events.length === 0 || !this.#ready) return;
    this.#transport.send(encodeFrame(FrameKind.Input, windowId, encodeInputBatch(events)));
  }

  offerClipboard(blob: ClipboardBlob): void {
    if (!this.#ready) return;
    this.#transport.send(
      encodeFrame(FrameKind.ClipboardClient, SESSION_WINDOW, encodeClipboardBlob(blob)),
    );
  }

  requestClipboard(mimeType: string): void {
    this.#send({ type: "clipboardRequest", mimeType });
  }

  ping(nonce: number): void {
    this.#send({ type: "ping", nonce });
  }

  /** Close every window on the host and end the session. */
  killSession(): void {
    this.#send({ type: "killSession" });
  }

  /** Stop reading. Does not end the remote session — the apps keep running. */
  close(): void {
    this.#closed = true;
    this.#transport.close();
  }

  #send(message: ClientMessage): void {
    if (this.#closed) return;
    if (!this.#ready) {
      this.#queued.push(message);
      return;
    }
    this.#sendNow(message);
  }

  #sendNow(message: ClientMessage): void {
    this.#transport.send(
      encodeFrame(FrameKind.ControlClient, SESSION_WINDOW, encodeControl(message)),
    );
  }

  #receive(bytes: Uint8Array): void {
    this.#decoder.push(bytes);
    for (const frame of this.#decoder.drain()) {
      switch (frame.kind) {
        case FrameKind.ControlServer:
          this.#onMessage(decodeServerMessage(frame.payload));
          break;
        case FrameKind.Pixels:
          this.#onPixels(frame.windowId, frame.payload);
          break;
        case FrameKind.ClipboardServer:
          this.#events.onClipboard?.(decodeClipboardBlob(frame.payload));
          break;
        default:
          // Client-bound kinds arriving from the server mean a desynchronised
          // stream rather than something to act on.
          this.#events.onError?.(`unexpected frame kind ${frame.kind}`);
      }
    }
  }

  #onPixels(windowId: number, payload: Uint8Array): void {
    const decoded = decodePixelPayload(payload);
    const started = now();
    this.#events.onFrame?.(windowId, decoded);
    for (const listener of this.#frameListeners) {
      // One viewer throwing must not stop the others painting, and must not
      // stop the ack — a session that stops acking stops receiving.
      try {
        listener(windowId, decoded);
      } catch {
        /* a viewer's problem, not the session's */
      }
    }
    // Acked after the consumer has painted, not on arrival: the ack is what
    // frees an in-flight slot on the host, so acking early would let frames
    // queue up ahead of a viewer that cannot keep up.
    this.#send({
      type: "ack",
      windowId,
      seq: decoded.seq,
      decodeMs: Math.round(now() - started),
    });
  }

  #onLaunchResult(result: LaunchResult): void {
    this.#events.onLaunchResult?.(result.ok, result.message, result.appId);
    for (const listener of this.#launchListeners) {
      // One subscriber throwing must not stop the others hearing about it.
      try {
        listener(result);
      } catch {
        /* a launcher's problem, not the session's */
      }
    }
  }

  #onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "welcome": {
        if (message.protocol !== PROTOCOL_VERSION) {
          this.#events.onError?.(
            `host speaks protocol ${message.protocol}, this client speaks ${PROTOCOL_VERSION}`,
            "protocolMismatch",
          );
          this.close();
          return;
        }
        this.#ready = true;
        this.#sessionId = message.sessionId;
        const queued = this.#queued;
        this.#queued = [];
        for (const pending of queued) this.#sendNow(pending);
        this.#events.onReady?.(message);
        break;
      }
      case "apps":
        this.#events.onApps?.(message.apps, message.complete);
        for (const listener of this.#appsListeners) listener(message.apps, message.complete);
        break;
      case "windowOpen": {
        const info: WindowInfo = {
          windowId: message.windowId,
          title: message.title,
          width: message.width,
          height: message.height,
          // Spread rather than assigned: under exactOptionalPropertyTypes an
          // absent field and a field holding undefined are different things,
          // and the wire omits what it does not have.
          ...(message.appId !== undefined ? { appId: message.appId } : {}),
          ...(message.icon !== undefined ? { icon: message.icon } : {}),
          ...(message.parentWindowId !== undefined
            ? { parentWindowId: message.parentWindowId }
            : {}),
        };
        this.#windows.set(info.windowId, info);
        this.#events.onWindowOpen?.(info);
        for (const listener of this.#windowListeners) listener(info.windowId, info);
        break;
      }
      case "windowMeta": {
        const existing = this.#windows.get(message.windowId);
        if (!existing) return;
        const updated: WindowInfo = {
          ...existing,
          ...(message.title !== undefined ? { title: message.title } : {}),
          ...(message.appId !== undefined ? { appId: message.appId } : {}),
          ...(message.icon !== undefined ? { icon: message.icon } : {}),
        };
        this.#windows.set(updated.windowId, updated);
        this.#events.onWindowMeta?.(updated);
        for (const listener of this.#windowListeners) listener(updated.windowId, updated);
        break;
      }
      case "windowClose":
        this.#windows.delete(message.windowId);
        this.#events.onWindowClose?.(message.windowId, message.reason);
        for (const listener of this.#windowCloseListeners) {
          listener(message.windowId, message.reason);
        }
        break;
      case "cursor":
        this.#events.onCursor?.(message.windowId, message.shape);
        for (const listener of this.#cursorListeners) listener(message.windowId, message.shape);
        break;
      case "launchResult":
        this.#onLaunchResult({
          ok: message.ok,
          ...(message.message !== undefined ? { message: message.message } : {}),
          ...(message.appId !== undefined ? { appId: message.appId } : {}),
        });
        break;
      case "error":
        // `unknownApp` and `launchFailed` answer one launch attempt — the
        // session behind them is healthy and the next application will start
        // fine. Reporting them as session errors would leave the launcher
        // permanently red over a single bad entry, so they go where the
        // outcome of a launch goes.
        if (message.code === "unknownApp" || message.code === "launchFailed") {
          this.#onLaunchResult({ ok: false, message: message.message });
          break;
        }
        this.#events.onError?.(message.message, message.code);
        break;
      case "clipboardOffer":
      case "stats":
      case "pong":
        break;
    }
  }
}

function now(): number {
  return typeof performance === "object" ? performance.now() : Date.now();
}
