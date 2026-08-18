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
import { decodeAudioChunk, type AudioChunk } from "./audio.js";
import { encodeInputBatch, type InputEvent } from "./input.js";
import {
  decodeServerMessage,
  encodeControl,
  type A11yNode,
  type AppEntry,
  type ClientCaps,
  type ClientMessage,
  type ServerCaps,
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

/**
 * A painter of frames.
 *
 * Returning a promise delays the ack until it settles — which is how a viewer
 * that hands a JPEG to the browser keeps "acked" meaning "painted". The return
 * type is `unknown` rather than `void | Promise<void>` so that a listener whose
 * body happens to be an expression (`(id) => seen.push(id)`, most tests) still
 * type-checks; anything that is not a thenable is ignored.
 */
export type FrameListener = (windowId: number, payload: PixelPayload) => unknown;

/** A consumer of mixed session audio. Chunks are session-scoped, not per-window. */
export type AudioListener = (chunk: AudioChunk) => void;

export interface AppSessionEvents {
  onReady?(welcome: Extract<ServerMessage, { type: "welcome" }>): void;
  onApps?(apps: AppEntry[], complete: boolean): void;
  onWindowOpen?(window: WindowInfo): void;
  onWindowMeta?(window: WindowInfo): void;
  onWindowClose?(windowId: number, reason: string): void;
  /**
   * New pixels for a window. The session acks once this returns — or once the
   * promise it returns settles, which is how a viewer that has to wait for the
   * browser to decode a JPEG keeps the ack honest.
   */
  onFrame?(windowId: number, payload: PixelPayload): unknown;
  onCursor?(windowId: number, shape: string | undefined): void;
  onClipboard?(blob: ClipboardBlob): void;
  /** Mixed session audio. Never fires unless the caps passed in said `audio`. */
  onAudio?(chunk: AudioChunk): void;
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

/** A resolved accessibility tree, with the host's caveat when it has one. */
export interface A11yTreeResult {
  tree: A11yNode;
  /** e.g. "tree truncated at 1500 nodes" — the tree is real but incomplete. */
  caveat?: string;
}

/**
 * The clipboard types worth asking for.
 *
 * Text only, deliberately: an image on a remote clipboard is megabytes over an
 * SSH connection that nobody asked to spend, and a paste that arrives a second
 * late is worse than one that does not arrive.
 */
const TEXT_MIME = /^text\/plain/;

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
  #frameListeners = new Set<FrameListener>();
  #cursorListeners = new Set<(windowId: number, shape: string | undefined) => void>();
  /** Window opened, or its title/icon changed. */
  #windowListeners = new Set<(windowId: number, window: WindowInfo) => void>();
  #windowCloseListeners = new Set<(windowId: number, reason: string) => void>();
  #appsListeners = new Set<(apps: AppEntry[], complete: boolean) => void>();
  #launchListeners = new Set<(result: LaunchResult) => void>();
  #audioListeners = new Set<AudioListener>();
  #sessionId: string | undefined;
  #serverCaps: ServerCaps | undefined;
  /** Outstanding `a11yTree` requests, by requestId. */
  #a11yRequests = new Map<
    number,
    {
      resolve: (tree: A11yTreeResult) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  #nextA11yRequestId = 1;

  constructor(transport: AppSessionTransport, options: AppSessionOptions) {
    this.#transport = transport;
    this.#events = options.events ?? {};

    transport.onMessage((bytes) => this.#receive(bytes));
    transport.onClose(() => {
      this.#closed = true;
      this.#failA11yRequests("session closed");
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

  /** What the host said it can do, once it has greeted us. */
  get serverCaps(): ServerCaps | undefined {
    return this.#serverCaps;
  }

  get windows(): WindowInfo[] {
    return [...this.#windows.values()];
  }

  window(windowId: number): WindowInfo | undefined {
    return this.#windows.get(windowId);
  }

  /**
   * Subscribe to pixels. The session acks once every listener has returned, and
   * waits on any promise one of them hands back.
   */
  addFrameListener(listener: FrameListener): void {
    this.#frameListeners.add(listener);
  }

  removeFrameListener(listener: FrameListener): void {
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

  /**
   * Subscribe to mixed session audio. Nothing arrives unless the session's
   * caps declared `audio` — the host never sends the frame kind otherwise.
   */
  addAudioListener(listener: AudioListener): void {
    this.#audioListeners.add(listener);
  }

  removeAudioListener(listener: AudioListener): void {
    this.#audioListeners.delete(listener);
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

  /**
   * Start or stop the audio stream at the source. The viewer's mute sends
   * false so the PCM stops crossing the link, not just the speakers.
   */
  setAudioEnabled(enabled: boolean): void {
    this.#send({ type: "setAudio", enabled });
  }

  ping(nonce: number): void {
    this.#send({ type: "ping", nonce });
  }

  /**
   * Ask for a window's accessibility tree, as its application reports it over
   * AT-SPI. Resolves with the tree (and possibly a caveat, e.g. truncation);
   * rejects when the host cannot produce one — an app whose toolkit has no
   * accessibility support, a host without the capability, a timeout.
   */
  requestA11yTree(windowId: number, options: { timeoutMs?: number } = {}): Promise<A11yTreeResult> {
    if (this.#closed) {
      return Promise.reject(new Error("session closed"));
    }
    // Only checkable once the welcome has landed; before it, the request is
    // queued like everything else and the host answers for itself.
    if (this.#serverCaps && !this.#serverCaps.a11y) {
      return Promise.reject(new Error("this host does not expose accessibility trees"));
    }
    const requestId = this.#nextA11yRequestId++;
    return new Promise<A11yTreeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#a11yRequests.delete(requestId);
        reject(new Error("accessibility request timed out"));
      }, options.timeoutMs ?? 15_000);
      this.#a11yRequests.set(requestId, { resolve, reject, timer });
      this.#send({ type: "a11yTree", windowId, requestId });
    });
  }

  /** Close every window on the host and end the session. */
  killSession(): void {
    this.#send({ type: "killSession" });
  }

  /** Stop reading. Does not end the remote session — the apps keep running. */
  close(): void {
    this.#closed = true;
    this.#failA11yRequests("session closed");
    this.#transport.close();
  }

  #failA11yRequests(reason: string): void {
    const pending = [...this.#a11yRequests.values()];
    this.#a11yRequests.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
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
        case FrameKind.Audio:
          this.#onAudio(decodeAudioChunk(frame.payload));
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
    const pending: Array<Promise<unknown>> = [];
    const run = (listener: FrameListener) => {
      // One viewer throwing must not stop the others painting, and must not
      // stop the ack — a session that stops acking stops receiving.
      try {
        const result = listener(windowId, decoded);
        // A lossy frame is decoded by the browser, which only offers that
        // asynchronously. Acking before it lands would defeat the point of
        // acking after the paint.
        if (result && typeof (result as Promise<void>).then === "function") {
          pending.push((result as Promise<void>).catch(() => undefined));
        }
      } catch {
        /* a viewer's problem, not the session's */
      }
    };
    if (this.#events.onFrame) run(this.#events.onFrame.bind(this.#events));
    for (const listener of this.#frameListeners) run(listener);

    // Acked after the consumer has painted, not on arrival: the ack is what
    // frees an in-flight slot on the host, so acking early would let frames
    // queue up ahead of a viewer that cannot keep up.
    const ack = () =>
      this.#send({
        type: "ack",
        windowId,
        seq: decoded.seq,
        decodeMs: Math.round(now() - started),
      });
    if (pending.length === 0) ack();
    else void Promise.all(pending).then(ack);
  }

  #onAudio(chunk: AudioChunk): void {
    this.#events.onAudio?.(chunk);
    for (const listener of this.#audioListeners) {
      // One player throwing must not stop the others — or the next chunk.
      try {
        listener(chunk);
      } catch {
        /* a player's problem, not the session's */
      }
    }
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
        this.#serverCaps = message.caps;
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
      case "clipboardOffer": {
        // An application took the host's clipboard. Fetching it now rather
        // than when the user pastes is what makes the paste instant — and the
        // host only ever offers, so nothing has crossed the wire yet.
        const wanted = message.mimeTypes.find((type) => TEXT_MIME.test(type));
        if (wanted) this.requestClipboard(wanted);
        break;
      }
      case "a11yTree": {
        const pending = this.#a11yRequests.get(message.requestId);
        if (!pending) return;
        this.#a11yRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.ok && message.tree) {
          pending.resolve({
            tree: message.tree,
            ...(message.message !== undefined ? { caveat: message.message } : {}),
          });
        } else {
          pending.reject(new Error(message.message ?? "no accessibility tree"));
        }
        break;
      }
      case "stats":
      case "pong":
        break;
    }
  }
}

function now(): number {
  return typeof performance === "object" ? performance.now() : Date.now();
}
