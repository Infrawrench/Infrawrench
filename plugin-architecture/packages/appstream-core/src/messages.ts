/**
 * Control messages, mirroring `linux-appserver/crates/iw-proto/src/messages.rs`.
 *
 * The Rust side serialises with serde using `#[serde(tag = "type",
 * rename_all = "camelCase")]` and omits absent optionals rather than nulling
 * them, which is why every optional here is `?:` and never `| null`.
 */

/** What the viewer can decode. The encoder never sends a tier this rules out. */
export interface ClientCaps {
  /** `WebCodecs VideoDecoder` with a working vp09 config. */
  vp9: boolean;
  /** `createImageBitmap` of a WebP blob. */
  webp: boolean;
  /** The wasm zstd decoder loaded; without it there is no lossless tier. */
  zstd: boolean;
  /** `createImageBitmap` of a JPEG blob — the lossy tier for a window in motion. */
  jpeg: boolean;
  /**
   * This client applies `RectOp.Delta`. False would make the host send whole
   * pixels: a client that did not know the op would paint a rectangle of
   * differences as if it were an image.
   */
  delta: boolean;
  /** Largest single frame the client will accept, in bytes. */
  maxFrameBytes: number;
}

/** What the host can actually do, resolved at startup rather than compiled in. */
export interface ServerCaps {
  vp9: boolean;
  webp: boolean;
  /** The host has the JPEG encoder. Absent on a host older than the tier. */
  jpeg?: boolean;
  xwayland: boolean;
  audio: boolean;
  /** A Wayland socket could be placed somewhere. */
  runtimeDir: boolean;
}

export type PixelFormat = "bgra8888" | "rgba8888";

/** One launchable application, as found in the host's desktop entries. */
export interface AppEntry {
  /** Desktop-file id, e.g. `org.gnome.Nautilus.desktop`. */
  id: string;
  name: string;
  comment?: string;
  categories?: string[];
  /** `data:image/png;base64,…`, already inside the tab-icon budget. */
  icon?: string;
  /** `StartupWMClass`, for matching a window whose app id differs. */
  wmClass?: string;
  /** Needs a terminal emulator, which the app server does not provide. */
  needsTerminal?: boolean;
}

export type WindowCloseReason = "closed" | "crashed" | "sessionEnded";

export type ErrorCode =
  | "protocolMismatch"
  | "unknownApp"
  | "launchFailed"
  | "noRuntimeDir"
  | "unknownWindow"
  | "internal";

export interface CursorImage {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  dataUrl: string;
}

export type ClientMessage =
  | { type: "hello"; protocol: number; caps: ClientCaps; devicePixelRatio: number }
  | { type: "listApps"; refresh?: boolean }
  | { type: "launch"; appId?: string; exec?: string; cwd?: string }
  | { type: "attach"; windowId: number; width: number; height: number; scale: number }
  | { type: "detach"; windowId: number }
  | { type: "resize"; windowId: number; width: number; height: number; scale: number }
  | { type: "closeWindow"; windowId: number }
  | { type: "ack"; windowId: number; seq: number; decodeMs: number }
  | { type: "clipboardOffer"; mimeTypes: string[] }
  | { type: "clipboardRequest"; mimeType: string }
  | { type: "killSession" }
  | { type: "ping"; nonce: number };

export type ServerMessage =
  | {
      type: "welcome";
      protocol: number;
      sessionId: string;
      version: string;
      caps: ServerCaps;
      pixelFormat: PixelFormat;
      /** XKB keymap the client's key events are resolved against. */
      keymap: string;
    }
  | { type: "apps"; apps: AppEntry[]; complete: boolean }
  | {
      type: "windowOpen";
      windowId: number;
      appId?: string;
      title: string;
      icon?: string;
      width: number;
      height: number;
      /** Set for a dialog: the viewer draws it into the parent's tab. */
      parentWindowId?: number;
    }
  | { type: "windowMeta"; windowId: number; title?: string; appId?: string; icon?: string }
  | { type: "windowClose"; windowId: number; reason: WindowCloseReason }
  | { type: "cursor"; windowId: number; shape?: string; image?: CursorImage }
  | { type: "clipboardOffer"; mimeTypes: string[] }
  | { type: "launchResult"; appId?: string; ok: boolean; message?: string }
  | {
      type: "stats";
      windowId: number;
      encodedBytes: number;
      framesSent: number;
      framesDropped: number;
      encodeMsP50: number;
    }
  | { type: "error"; code: ErrorCode; message: string; windowId?: number }
  | { type: "pong"; nonce: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeControl(message: ClientMessage | ServerMessage): Uint8Array {
  return encoder.encode(JSON.stringify(message));
}

export function decodeServerMessage(payload: Uint8Array): ServerMessage {
  return JSON.parse(decoder.decode(payload)) as ServerMessage;
}

export function decodeClientMessage(payload: Uint8Array): ClientMessage {
  return JSON.parse(decoder.decode(payload)) as ClientMessage;
}

/**
 * Caps for a browser or Electron renderer, probed rather than assumed.
 *
 * `zstd` is passed in because the wasm decoder is loaded asynchronously and a
 * session may legitimately start before it is ready — in which case the host
 * sends raw rectangles instead, which are larger but always decodable.
 */
export async function probeClientCaps(
  options: { zstd: boolean } = { zstd: false },
): Promise<ClientCaps> {
  return {
    vp9: await canDecodeVp9(),
    webp: typeof capabilityGlobals().createImageBitmap === "function",
    zstd: options.zstd,
    // Same capability as WebP, and for the same reason — the browser decodes
    // the blob for us. Kept a separate flag because a host may have one
    // encoder and not the other.
    jpeg: typeof capabilityGlobals().createImageBitmap === "function",
    // Arithmetic on a canvas this package already owns, so there is nothing to
    // feature-detect: it is true wherever this code runs at all.
    delta: true,
    maxFrameBytes: 16 * 1024 * 1024,
  };
}

/**
 * The browser globals the probe looks for, typed structurally rather than
 * pulled in from the DOM library: this package is compiled for Node and
 * Electron's main process too, where those types do not exist and the globals
 * are legitimately absent.
 */
interface CapabilityGlobals {
  createImageBitmap?: unknown;
  VideoDecoder?: {
    isConfigSupported?(config: { codec: string }): Promise<{ supported?: boolean }>;
  };
}

function capabilityGlobals(): CapabilityGlobals {
  return globalThis as CapabilityGlobals;
}

async function canDecodeVp9(): Promise<boolean> {
  const videoDecoder = capabilityGlobals().VideoDecoder;
  if (!videoDecoder?.isConfigSupported) return false;
  try {
    // The profile the encoder produces: profile 0, level 1.0, 8-bit.
    const support = await videoDecoder.isConfigSupported({ codec: "vp09.00.10.08" });
    return support.supported === true;
  } catch {
    return false;
  }
}
