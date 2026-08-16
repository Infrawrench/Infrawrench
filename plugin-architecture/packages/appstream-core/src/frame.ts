/**
 * Frame envelope for the remote-application protocol.
 *
 * The other end of this wire is `linux-appserver/crates/iw-proto`, so every
 * constant here is a constant there. A change to either is a change to both,
 * in one commit, with the golden fixtures in `fixtures/` as the guard.
 *
 * ```text
 * u32 len | u8 kind | u32 windowId | payload[len - 5]
 * ```
 *
 * `len` counts the bytes after itself, little-endian throughout.
 */

/** Bytes of header inside `len` (kind + window id). */
const HEADER_LEN = 5;

/**
 * Hard ceiling on a single frame, matching the server's. Anything past it is a
 * desynchronised stream rather than a legitimate frame, and allocating on a
 * peer's say-so is how a stray byte becomes an out-of-memory crash.
 */
export const MAX_FRAME_LEN = 64 * 1024 * 1024;

export const FrameKind = {
  /** JSON {@link ClientMessage}. */
  ControlClient: 0x01,
  /** Packed input events. */
  Input: 0x02,
  /** Clipboard payload, client → host. */
  ClipboardClient: 0x03,
  /** JSON {@link ServerMessage}. */
  ControlServer: 0x81,
  /** Encoded pixels for the frame's window. */
  Pixels: 0x82,
  /** Clipboard payload, host → client. */
  ClipboardServer: 0x83,
} as const;

export type FrameKind = (typeof FrameKind)[keyof typeof FrameKind];

const KNOWN_KINDS = new Set<number>(Object.values(FrameKind));

export interface Frame {
  kind: FrameKind;
  windowId: number;
  payload: Uint8Array;
}

/** The session-level window id: frames about the session, not a window. */
export const SESSION_WINDOW = 0;

/**
 * Protocol version. The client refuses a session whose `welcome.protocol` it
 * does not recognise rather than negotiating down — a host running an older
 * binary is replaced, not accommodated.
 */
export const PROTOCOL_VERSION = 1;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function encodeFrame(kind: FrameKind, windowId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + HEADER_LEN + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, HEADER_LEN + payload.length, true);
  out[4] = kind;
  view.setUint32(5, windowId, true);
  out.set(payload, 9);
  return out;
}

/**
 * Incremental frame decoder.
 *
 * Feed it whatever the transport hands over — a WebSocket message, an IPC
 * chunk, a slice of an SSH channel — and pull whole frames out until it
 * returns undefined. Chunk boundaries land mid-header routinely.
 */
export class FrameDecoder {
  #buffer = new Uint8Array(0);
  #start = 0;

  push(bytes: Uint8Array): void {
    if (this.#start > 0 && this.#start === this.#buffer.length) {
      this.#buffer = bytes.slice();
      this.#start = 0;
      return;
    }
    const merged = new Uint8Array(this.#buffer.length - this.#start + bytes.length);
    merged.set(this.#buffer.subarray(this.#start), 0);
    merged.set(bytes, this.#buffer.length - this.#start);
    this.#buffer = merged;
    this.#start = 0;
  }

  /** Bytes received but not yet consumed by a complete frame. */
  get buffered(): number {
    return this.#buffer.length - this.#start;
  }

  next(): Frame | undefined {
    if (this.buffered < 4) return undefined;
    const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset);
    const len = view.getUint32(this.#start, true);
    if (len > MAX_FRAME_LEN) {
      throw new ProtocolError(`frame length ${len} exceeds the ${MAX_FRAME_LEN} byte limit`);
    }
    if (len < HEADER_LEN) {
      throw new ProtocolError(`frame length ${len} is shorter than the ${HEADER_LEN} byte header`);
    }
    if (this.buffered < 4 + len) return undefined;

    const body = this.#start + 4;
    const kind = this.#buffer[body];
    if (kind === undefined || !KNOWN_KINDS.has(kind)) {
      throw new ProtocolError(`unknown frame kind 0x${(kind ?? 0).toString(16).padStart(2, "0")}`);
    }
    const windowId = view.getUint32(body + 1, true);
    // A copy, not a view: the caller keeps pixel payloads for as long as it
    // takes to decode them, and the buffer underneath is about to be reused.
    const payload = this.#buffer.slice(body + HEADER_LEN, body + len);

    this.#start = body + len;
    if (this.#start === this.#buffer.length) {
      this.#buffer = new Uint8Array(0);
      this.#start = 0;
    }
    return { kind: kind as FrameKind, windowId, payload };
  }

  /** Drain every complete frame currently buffered. */
  *drain(): Generator<Frame> {
    for (let frame = this.next(); frame; frame = this.next()) {
      yield frame;
    }
  }
}

/** `u16 mimeLen | mime | data`, matching the server's clipboard blob. */
export interface ClipboardBlob {
  mimeType: string;
  data: Uint8Array;
}

export function encodeClipboardBlob(blob: ClipboardBlob): Uint8Array {
  const mime = new TextEncoder().encode(blob.mimeType);
  const out = new Uint8Array(2 + mime.length + blob.data.length);
  new DataView(out.buffer).setUint16(0, mime.length, true);
  out.set(mime, 2);
  out.set(blob.data, 2 + mime.length);
  return out;
}

export function decodeClipboardBlob(payload: Uint8Array): ClipboardBlob {
  if (payload.length < 2) {
    throw new ProtocolError(`truncated clipboard blob: ${payload.length} bytes`);
  }
  const mimeLen = new DataView(payload.buffer, payload.byteOffset).getUint16(0, true);
  if (payload.length < 2 + mimeLen) {
    throw new ProtocolError(`truncated clipboard blob: expected ${2 + mimeLen} bytes`);
  }
  return {
    mimeType: new TextDecoder().decode(payload.subarray(2, 2 + mimeLen)),
    data: payload.slice(2 + mimeLen),
  };
}
