/**
 * Driving a remote application with no screen attached.
 *
 * The viewer half of the protocol assumes a human: a canvas paints frames, a
 * keyboard produces events. This is the other consumer — an agent (the MCP
 * server, a test harness) that launches an app, keeps an RGBA canvas per
 * window exactly as the browser viewer would, and synthesises the input a
 * human would have produced. Screenshots are that canvas encoded as PNG;
 * clicks are pointer events aimed at the same buffer-pixel space.
 *
 * The caps deliberately rule out every browser-decoded tier (JPEG, WebP,
 * VP9): with only the lossless tiers on offer, `applyPayload` reconstructs
 * every frame exactly, and a screenshot is never a compression artefact.
 */

import {
  AppSession,
  ButtonState,
  KeyTranslator,
  PointerButton,
  applyPayload,
  evdevFromCode,
  fixedFromPx,
  type A11yTreeResult,
  type AppEntry,
  type AppSessionTransport,
  type ClientCaps,
  type InputEvent,
  type KeyLike,
  type LaunchResult,
  type PixelPayload,
  type WindowInfo,
} from "@infrawrench/appstream-core";
import { zstdDecompressSync } from "node:zlib";

import { encodePng } from "./png.js";
import { startAppServer, type AppServerSession, type SessionOptions } from "./server.js";
import type { SshExecutor } from "./exec.js";

/** Lossless-only: everything the host sends can be reconstructed exactly. */
export function headlessClientCaps(): ClientCaps {
  return {
    vp9: false,
    webp: false,
    zstd: true,
    jpeg: false,
    delta: true,
    audio: false,
    maxFrameBytes: 32 * 1024 * 1024,
  };
}

/** Adapt the SSH channel wrapper to the transport `AppSession` expects. */
export function transportFromAppServer(server: AppServerSession): AppSessionTransport {
  return {
    send: (bytes) => server.write(Buffer.from(bytes)),
    onMessage: (handler) => server.onData((chunk) => handler(new Uint8Array(chunk))),
    onClose: (handler) => server.onClose(() => handler()),
    close: () => server.close(),
  };
}

export interface HeadlessOptions {
  /** Size windows are attached at, in buffer pixels (scale is always 1). */
  width?: number;
  height?: number;
}

export interface Screenshot {
  png: Buffer;
  width: number;
  height: number;
}

export type MouseButton = "left" | "right" | "middle";

interface WindowCanvas {
  pixels: Uint8Array;
  width: number;
  height: number;
  frames: number;
  lastFrameAt: number;
  /** A frame arrived that lossless caps should have made impossible. */
  error?: string;
}

const BUTTONS: Record<MouseButton, number> = {
  left: PointerButton.Left,
  right: PointerButton.Right,
  middle: PointerButton.Middle,
};

/** Friendly key names → `KeyboardEvent.code` values, for `pressKeys`. */
const NAMED_KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`] as const)),
};

const MODIFIERS: Record<string, string> = {
  ctrl: "ControlLeft",
  control: "ControlLeft",
  shift: "ShiftLeft",
  alt: "AltLeft",
  meta: "MetaLeft",
  super: "MetaLeft",
  cmd: "MetaLeft",
};

function decompress(input: Uint8Array): Uint8Array {
  return new Uint8Array(zstdDecompressSync(input));
}

/**
 * A launched-and-driveable session. Construct over any transport with
 * {@link HeadlessAppClient.connect}, or from an SSH connection with
 * {@link startHeadlessAppSession}.
 */
export class HeadlessAppClient {
  readonly session: AppSession;
  #width: number;
  #height: number;
  #canvases = new Map<number, WindowCanvas>();
  #attached = new Set<number>();
  #started = Date.now();

  private constructor(session: AppSession, options: HeadlessOptions = {}) {
    this.session = session;
    this.#width = options.width ?? 1280;
    this.#height = options.height ?? 800;
    session.addFrameListener((windowId, payload) => this.#onFrame(windowId, payload));
    session.addWindowCloseListener((windowId) => {
      this.#canvases.delete(windowId);
      this.#attached.delete(windowId);
    });
  }

  /** Open a session over `transport` and wait for the host's welcome. */
  static connect(
    transport: AppSessionTransport,
    options: HeadlessOptions & { timeoutMs?: number } = {},
  ): Promise<HeadlessAppClient> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the app server did not answer the handshake")),
        options.timeoutMs ?? 30_000,
      );
      const session = new AppSession(transport, {
        caps: headlessClientCaps(),
        devicePixelRatio: 1,
        events: {
          onReady: () => {
            clearTimeout(timer);
            resolve(new HeadlessAppClient(session, options));
          },
          onError: (message) => {
            clearTimeout(timer);
            reject(new Error(message));
          },
          onClose: () => {
            clearTimeout(timer);
            reject(new Error("the app server closed before greeting"));
          },
        },
      });
    });
  }

  #now(): number {
    return (Date.now() - this.#started) >>> 0;
  }

  #onFrame(windowId: number, payload: PixelPayload): void {
    let canvas = this.#canvases.get(windowId);
    if (!canvas || canvas.width !== payload.width || canvas.height !== payload.height) {
      canvas = {
        pixels: new Uint8Array(payload.width * payload.height * 4),
        width: payload.width,
        height: payload.height,
        frames: canvas?.frames ?? 0,
        lastFrameAt: 0,
      };
      this.#canvases.set(windowId, canvas);
    }
    try {
      applyPayload(payload, canvas.pixels, canvas.width, canvas.height, decompress);
      canvas.frames += 1;
      canvas.lastFrameAt = Date.now();
    } catch (error) {
      // Thrown here it would be swallowed by the session's listener guard;
      // remembered here it surfaces on the next screenshot instead.
      canvas.error = error instanceof Error ? error.message : String(error);
    }
  }

  /** The windows the host has opened. */
  windows(): WindowInfo[] {
    return this.session.windows;
  }

  /** The host's application catalog. */
  listApps(timeoutMs = 30_000): Promise<AppEntry[]> {
    return new Promise((resolve, reject) => {
      const collected: AppEntry[] = [];
      const timer = setTimeout(() => {
        this.session.removeAppsListener(listener);
        reject(new Error("timed out listing applications"));
      }, timeoutMs);
      const listener = (apps: AppEntry[], complete: boolean) => {
        collected.push(...apps);
        if (!complete) return;
        clearTimeout(timer);
        this.session.removeAppsListener(listener);
        resolve(collected);
      };
      this.session.addAppsListener(listener);
      this.session.listApps();
    });
  }

  /**
   * Launch an application and resolve with its first own window (dialogs of
   * other windows do not count), already attached and streaming.
   */
  launch(
    target: { appId?: string; exec?: string; cwd?: string },
    options: { timeoutMs?: number } = {},
  ): Promise<WindowInfo> {
    const known = new Set(this.session.windows.map((w) => w.windowId));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.session.removeWindowListener(onWindow);
        this.session.removeLaunchResultListener(onLaunch);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "the application did not open a window in time — it may need something the host " +
              "is missing (check the host's preflight)",
          ),
        );
      }, options.timeoutMs ?? 45_000);
      const onWindow = (windowId: number, info: WindowInfo) => {
        if (known.has(windowId) || info.parentWindowId !== undefined) return;
        cleanup();
        this.attach(windowId);
        resolve(info);
      };
      const onLaunch = (result: LaunchResult) => {
        if (result.ok) return;
        cleanup();
        reject(new Error(result.message ?? "launch failed"));
      };
      this.session.addWindowListener(onWindow);
      this.session.addLaunchResultListener(onLaunch);
      this.session.launch(target);
    });
  }

  /** Start streaming a window at the client's canvas size, scale 1. */
  attach(windowId: number): void {
    this.#attached.add(windowId);
    this.session.attach(windowId, this.#width, this.#height, 1);
  }

  /**
   * Wait until a window has painted and gone quiet, then encode its canvas.
   * `quietMs` is how long the window must stop repainting first — enough for
   * the reaction to a click to finish drawing, small enough not to stall on
   * an app that animates forever.
   */
  async screenshot(
    windowId: number,
    options: { quietMs?: number; timeoutMs?: number } = {},
  ): Promise<Screenshot> {
    if (!this.session.window(windowId)) {
      throw new Error(`no window ${windowId}`);
    }
    if (!this.#attached.has(windowId)) {
      this.attach(windowId);
    }
    const quietMs = options.quietMs ?? 250;
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    for (;;) {
      const canvas = this.#canvases.get(windowId);
      if (canvas?.error) {
        throw new Error(`could not reconstruct the window's pixels: ${canvas.error}`);
      }
      if (canvas && canvas.frames > 0) {
        const quietFor = Date.now() - canvas.lastFrameAt;
        if (quietFor >= quietMs || Date.now() >= deadline) {
          return {
            png: encodePng(canvas.pixels, canvas.width, canvas.height),
            width: canvas.width,
            height: canvas.height,
          };
        }
      } else if (Date.now() >= deadline) {
        throw new Error("the window never painted a frame");
      }
      await sleep(25);
    }
  }

  /** The window's accessibility tree, straight from the session. */
  a11yTree(windowId: number, options: { timeoutMs?: number } = {}): Promise<A11yTreeResult> {
    return this.session.requestA11yTree(windowId, options);
  }

  /**
   * Click at `(x, y)` in the window's pixel space — the same coordinates a
   * screenshot's pixels and the accessibility tree's bounds are in.
   */
  click(
    windowId: number,
    x: number,
    y: number,
    options: { button?: MouseButton; clicks?: number } = {},
  ): void {
    const button = BUTTONS[options.button ?? "left"];
    const time = this.#now();
    const events: InputEvent[] = [
      { kind: "pointerMotion", timeMs: time, x: fixedFromPx(x), y: fixedFromPx(y) },
    ];
    for (let i = 0; i < (options.clicks ?? 1); i++) {
      events.push(
        { kind: "pointerButton", timeMs: time + i * 40, button, state: ButtonState.Pressed },
        { kind: "pointerButton", timeMs: time + i * 40 + 20, button, state: ButtonState.Released },
      );
    }
    this.session.sendInput(windowId, events);
  }

  /** Move the pointer without pressing anything (hover states, menus). */
  movePointer(windowId: number, x: number, y: number): void {
    this.session.sendInput(windowId, [
      { kind: "pointerMotion", timeMs: this.#now(), x: fixedFromPx(x), y: fixedFromPx(y) },
    ]);
  }

  /**
   * Scroll by wheel notches at a position. Positive `notches` scrolls down —
   * the same sign convention as a browser wheel event.
   */
  scroll(
    windowId: number,
    x: number,
    y: number,
    notches: number,
    options: { horizontal?: boolean } = {},
  ): void {
    const time = this.#now();
    // Ten logical units per notch, matching `axisFromWheel`; the motion first,
    // because a compositor delivers axis events to whatever is under the
    // pointer, wherever that currently is.
    const amount = fixedFromPx(Math.round(notches * 10));
    this.session.sendInput(windowId, [
      { kind: "pointerMotion", timeMs: time, x: fixedFromPx(x), y: fixedFromPx(y) },
      {
        kind: "pointerAxis",
        timeMs: time,
        dx: options.horizontal ? amount : 0,
        dy: options.horizontal ? 0 : amount,
      },
    ]);
  }

  /**
   * Type text into the focused widget, character by character, through the
   * same US-keymap translation the viewer uses — so anything a browser user
   * could type, including characters no US key produces, arrives intact.
   */
  typeText(windowId: number, text: string): void {
    const keys = new KeyTranslator();
    const events: InputEvent[] = [];
    let time = this.#now();
    for (const character of text) {
      const event = keyLikeForCharacter(character);
      events.push(...keys.press(event, time), ...keys.release(event, time + 8));
      time += 16;
    }
    this.session.sendInput(windowId, events);
  }

  /**
   * Press a key combination, e.g. `"Enter"`, `"ctrl+l"`, `"alt+F4"`,
   * `"ctrl+shift+t"`. The last token is the key, everything before it a
   * modifier.
   */
  pressKeys(windowId: number, combo: string): void {
    const tokens = combo
      .split("+")
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) throw new Error("empty key combination");
    const keyToken = tokens.pop() as string;

    const modifierCodes: number[] = [];
    for (const token of tokens) {
      const code = MODIFIERS[token.toLowerCase()];
      const keycode = code ? evdevFromCode(code) : undefined;
      if (keycode === undefined) throw new Error(`unknown modifier "${token}"`);
      modifierCodes.push(keycode);
    }

    let time = this.#now();
    const events: InputEvent[] = [];
    for (const keycode of modifierCodes) {
      events.push({ kind: "key", timeMs: time, keycode, state: ButtonState.Pressed });
      time += 4;
    }

    const keys = new KeyTranslator();
    const event = keyLikeForToken(keyToken, modifierCodes.length > 0);
    events.push(...keys.press(event, time), ...keys.release(event, time + 8));
    time += 16;

    for (const keycode of [...modifierCodes].reverse()) {
      events.push({ kind: "key", timeMs: time, keycode, state: ButtonState.Released });
      time += 4;
    }
    this.session.sendInput(windowId, events);
  }

  /** Ask the window to close (the app may show a save dialog instead). */
  closeWindow(windowId: number): void {
    this.session.closeWindow(windowId);
  }

  /** End the remote session: every app is closed and the server exits. */
  kill(): void {
    this.session.killSession();
    this.session.close();
  }

  /** Stop driving without ending the remote session. */
  close(): void {
    this.session.close();
  }
}

/** A `KeyboardEvent`-shaped press for one typed character. */
function keyLikeForCharacter(character: string): KeyLike {
  if (character === "\n" || character === "\r") {
    return { code: "Enter", key: "Enter", shiftKey: false };
  }
  if (character === "\t") {
    return { code: "Tab", key: "Tab", shiftKey: false };
  }
  return { code: "", key: character, shiftKey: false };
}

/** The final token of a combo: a named key, or a literal character. */
function keyLikeForToken(token: string, hasModifiers: boolean): KeyLike {
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return { code: named, key: named, shiftKey: false };
  if ([...token].length === 1) {
    // In a chord, the letter itself is what matters — `ctrl+L` and `ctrl+l`
    // both mean the plain key with Ctrl held, not Ctrl+Shift+l.
    const key = hasModifiers ? token.toLowerCase() : token;
    return { code: "", key, shiftKey: false };
  }
  // "ArrowUp", "F5" and friends, spelled as KeyboardEvent.code.
  return { code: token, key: token, shiftKey: false };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lines of host stderr kept to explain a server that exits during startup. */
const DIAGNOSTIC_LINES = 10;

/**
 * How long to keep listening for stderr after the channel closes. The exit
 * reason and the close event race, and the reason is the half worth waiting
 * for.
 */
const DIAGNOSTIC_GRACE_MS = 250;

/**
 * SSH connection → running compositor → driveable session, in one call.
 * The caller owns the connection, exactly as with {@link startAppServer}.
 */
export async function startHeadlessAppSession(
  conn: SshExecutor,
  options: SessionOptions & HeadlessOptions & { handshakeTimeoutMs?: number },
): Promise<HeadlessAppClient> {
  // A server that dies during startup says why on stderr and then closes the
  // channel, and the close is all the handshake can see — leaving the caller
  // with "closed before greeting" while the actual reason (a socket name
  // already bound, a missing library, no writable staging dir) goes only to
  // whatever log `onStderr` feeds. That log is not where the person who made
  // the call is looking, so keep the tail and answer with it.
  const diagnostics: string[] = [];
  const server = await startAppServer(conn, {
    ...options,
    onStderr: (line) => {
      diagnostics.push(line);
      if (diagnostics.length > DIAGNOSTIC_LINES) diagnostics.shift();
      options.onStderr?.(line);
    },
  });
  const connectOptions: HeadlessOptions & { timeoutMs?: number } = {
    ...(options.width !== undefined ? { width: options.width } : {}),
    ...(options.height !== undefined ? { height: options.height } : {}),
    ...(options.handshakeTimeoutMs !== undefined ? { timeoutMs: options.handshakeTimeoutMs } : {}),
  };
  try {
    return await HeadlessAppClient.connect(transportFromAppServer(server), connectOptions);
  } catch (error) {
    await sleep(DIAGNOSTIC_GRACE_MS);
    const message = error instanceof Error ? error.message : String(error);
    const detail = diagnostics
      .map((line) => line.replace(/^iwappd:\s*/, "").trim())
      .filter(Boolean)
      .pop();
    if (!detail || message.includes(detail)) throw error;
    throw new Error(`${message} — the host said: ${detail}`);
  }
}
