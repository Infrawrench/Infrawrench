/**
 * Side-band: packets whose first payload byte names a channel, so pack
 * data, progress text and a fatal error share one stream.
 */
import { decodeText, encodeText } from "./bytes";
import { GitError } from "./errors";
import { PKT_MAX_LENGTH, type Pkt, type PktLineReader, encodePktLine } from "./pktline";
import { type ByteSource, iterateBytes, streamFrom } from "./stream";

export const SIDE_BAND_DATA = 1;
export const SIDE_BAND_PROGRESS = 2;
export const SIDE_BAND_ERROR = 3;
export type SideBandChannel = 1 | 2 | 3;

/** Whole-packet limit under the `side-band` capability. */
export const SIDE_BAND_MAX_LENGTH = 1000;
/** Whole-packet limit under `side-band-64k`. */
export const SIDE_BAND_64K_MAX_LENGTH = PKT_MAX_LENGTH;

const HEX_DIGITS = "0123456789abcdef";

/**
 * Frames `data` for a channel, split over as many packets as the limit
 * needs. `maxLength` is the whole packet: 5 bytes of it are length and channel.
 */
export function encodeSideBand(
  channel: SideBandChannel,
  data: Uint8Array | string,
  maxLength: number = SIDE_BAND_64K_MAX_LENGTH,
): Uint8Array[] {
  const bytes = typeof data === "string" ? encodeText(data) : data;
  const room = maxLength - 5;
  if (room < 1 || maxLength > PKT_MAX_LENGTH) {
    throw new GitError("bad-pkt-line", "side-band packet limit is out of range");
  }
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += room) {
    const take = Math.min(room, bytes.length - at);
    const payload = new Uint8Array(take + 1);
    payload[0] = channel;
    payload.set(bytes.subarray(at, at + take), 1);
    out.push(encodePktLine(payload));
  }
  return out;
}

/**
 * Frames the first `take` bytes of `pieces` for a channel as one buffer of
 * packets, each full but the last. The bytes are copied once, from where
 * they are to where they go out: a pack is sent through here, all of it.
 */
export function encodeSideBandRun(
  channel: SideBandChannel,
  pieces: readonly Uint8Array[],
  take: number,
  maxLength: number = SIDE_BAND_64K_MAX_LENGTH,
): Uint8Array {
  const room = maxLength - 5;
  if (room < 1 || maxLength > PKT_MAX_LENGTH) {
    throw new GitError("bad-pkt-line", "side-band packet limit is out of range");
  }
  const out = new Uint8Array(take + 5 * Math.ceil(take / room));
  let at = 0;
  let piece = 0;
  let within = 0;
  for (let left = take; left > 0;) {
    const payload = Math.min(room, left);
    const length = payload + 5;
    out[at++] = HEX_DIGITS.charCodeAt(length >>> 12);
    out[at++] = HEX_DIGITS.charCodeAt((length >>> 8) & 15);
    out[at++] = HEX_DIGITS.charCodeAt((length >>> 4) & 15);
    out[at++] = HEX_DIGITS.charCodeAt(length & 15);
    out[at++] = channel;
    for (let need = payload; need > 0;) {
      const from = pieces[piece];
      if (from === undefined) throw new GitError("bad-pkt-line", "side-band run is cut short");
      const copy = Math.min(need, from.length - within);
      out.set(from.subarray(within, within + copy), at);
      at += copy;
      within += copy;
      need -= copy;
      if (within === from.length) {
        piece++;
        within = 0;
      }
    }
    left -= payload;
  }
  return out;
}

export interface SideBandFrame {
  readonly channel: SideBandChannel;
  readonly data: Uint8Array;
}

/** Splits a data packet's payload into channel and content. */
export function decodeSideBand(payload: Uint8Array): SideBandFrame {
  const channel = payload[0];
  if (channel !== 1 && channel !== 2 && channel !== 3) {
    throw new GitError("bad-pkt-line", `side-band channel ${channel ?? "missing"} is not valid`);
  }
  return { channel, data: payload.subarray(1) };
}

export interface MuxSideBandOptions {
  readonly channel?: SideBandChannel;
  readonly maxLength?: number;
}

/** Wraps a byte stream (a pack) in side-band packets. It does not add the closing flush. */
export function muxSideBand(
  source: ByteSource,
  options: MuxSideBandOptions = {},
): ReadableStream<Uint8Array> {
  const channel = options.channel ?? SIDE_BAND_DATA;
  const maxLength = options.maxLength ?? SIDE_BAND_64K_MAX_LENGTH;
  async function* generate(): AsyncGenerator<Uint8Array, void, void> {
    for await (const chunk of iterateBytes(source)) {
      yield* encodeSideBand(channel, chunk, maxLength);
    }
  }
  return streamFrom(generate());
}

export interface DemuxSideBandHandlers {
  /** Channel 2: progress text for the user's terminal. */
  onProgress?(data: Uint8Array): void;
}

/**
 * Yields the channel 1 payloads of a side-band section, up to its flush.
 * Progress goes to the handler; a channel 3 packet ends it with an error
 * carrying the remote's message.
 */
export async function* demuxSideBand(
  packets: PktLineReader | AsyncIterable<Pkt>,
  handlers: DemuxSideBandHandlers = {},
): AsyncGenerator<Uint8Array, void, void> {
  for await (const pkt of packets) {
    if (pkt.type !== "data") return;
    const frame = decodeSideBand(pkt.data);
    if (frame.channel === SIDE_BAND_DATA) yield frame.data;
    else if (frame.channel === SIDE_BAND_PROGRESS) handlers.onProgress?.(frame.data);
    else throw new GitError("bad-pkt-line", `remote error: ${decodeText(frame.data).trimEnd()}`);
  }
}
