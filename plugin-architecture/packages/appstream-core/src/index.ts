/**
 * `@infrawrench/appstream-core` — the client half of the remote-application
 * protocol.
 *
 * The other end is the Rust workspace in `linux-appserver/`. This package is
 * deliberately transport-free and DOM-free: Electron's main process, the web
 * server and the browser all speak the same frames, and only the thing
 * carrying the bytes differs. The golden fixtures in `fixtures/` are produced
 * by the Rust encoder and decoded by this package's tests, which is what stops
 * the two halves drifting.
 */

export {
  FrameDecoder,
  FrameKind,
  MAX_FRAME_LEN,
  PROTOCOL_VERSION,
  ProtocolError,
  SESSION_WINDOW,
  decodeClipboardBlob,
  encodeClipboardBlob,
  encodeFrame,
  type ClipboardBlob,
  type Frame,
} from "./frame.js";

export {
  decodeClientMessage,
  decodeServerMessage,
  encodeControl,
  probeClientCaps,
  type AppEntry,
  type ClientCaps,
  type ClientMessage,
  type CursorImage,
  type ErrorCode,
  type PixelFormat,
  type ServerCaps,
  type ServerMessage,
  type WindowCloseReason,
} from "./messages.js";

export {
  ButtonState,
  PointerButton,
  axisFromWheel,
  decodeInputBatch,
  encodeInputBatch,
  evdevFromCode,
  fixedFromPx,
  pointerButtonFromDom,
  pointerPosition,
  pxFromFixed,
  type InputEvent,
} from "./input.js";

export {
  Codec,
  FLAG_KEYFRAME,
  PayloadError,
  RectOp,
  applyPayload,
  decodeImageTiles,
  decodePixelPayload,
  expectedPixelBytes,
  type PixelPayload,
  type RectEntry,
  type ZstdDecompress,
} from "./pixels.js";

export {
  AppSession,
  type AppSessionEvents,
  type FrameListener,
  type AppSessionOptions,
  type AppSessionTransport,
  type LaunchResult,
  type WindowInfo,
} from "./session.js";
