/**
 * Audio chunk payload, mirroring `linux-appserver/crates/iw-proto/src/audio.rs`.
 *
 * ```text
 * u8 codec | u8 channels | u16 flags | u32 seq | u32 sampleRate | data
 * ```
 *
 * Little-endian, like the envelope. `data` is interleaved signed 16-bit PCM,
 * raw or zstd-compressed per `codec`. Chunks are a few milliseconds each; the
 * player schedules them back to back and resynchronises on a `seq` gap or the
 * reset flag.
 */

import { ProtocolError } from "./frame.js";
import type { ZstdDecompress } from "./pixels.js";

/** Bytes before `data`. */
export const AUDIO_HEADER_LEN = 12;

/**
 * The stream (re)started — first chunk after silence or a mixer restart. The
 * player drops whatever it had scheduled and starts fresh rather than
 * treating the discontinuity as an underrun.
 */
export const AUDIO_FLAG_RESET = 1 << 0;

export const AudioCodec = {
  /** Interleaved s16le PCM, uncompressed. */
  PcmS16: 0,
  /** Interleaved s16le PCM, zstd-compressed. */
  ZstdPcmS16: 1,
} as const;

export type AudioCodec = (typeof AudioCodec)[keyof typeof AudioCodec];

export interface AudioChunk {
  codec: AudioCodec;
  /** Interleaved channel count, 1 or 2 in practice. */
  channels: number;
  flags: number;
  /** Increments per chunk; a gap means the link stalled and the player should resync. */
  seq: number;
  sampleRate: number;
  data: Uint8Array;
}

export function decodeAudioChunk(payload: Uint8Array): AudioChunk {
  if (payload.length < AUDIO_HEADER_LEN) {
    throw new ProtocolError(`truncated audio chunk: ${payload.length} bytes`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset);
  const codec = payload[0];
  if (codec !== AudioCodec.PcmS16 && codec !== AudioCodec.ZstdPcmS16) {
    throw new ProtocolError(`unknown audio codec ${codec}`);
  }
  return {
    codec,
    channels: payload[1] ?? 0,
    flags: view.getUint16(2, true),
    seq: view.getUint32(4, true),
    sampleRate: view.getUint32(8, true),
    data: payload.slice(AUDIO_HEADER_LEN),
  };
}

/**
 * A chunk's samples as an `Int16Array`, decompressing if needed. The `zstd`
 * decompressor is injected exactly as it is for pixels — the browser brings
 * fzstd, a Node test brings `node:zlib`.
 */
export function audioChunkPcm(chunk: AudioChunk, zstd?: ZstdDecompress): Int16Array {
  // The decompressed size is not carried in the chunk header; a chunk is a
  // few milliseconds of PCM, so a generous ceiling is still tiny.
  const raw =
    chunk.codec === AudioCodec.ZstdPcmS16
      ? requireZstd(zstd)(chunk.data, 4 * 1024 * 1024)
      : chunk.data;
  if (raw.length % 2 !== 0) {
    throw new ProtocolError(`odd audio payload length ${raw.length}`);
  }
  const samples = new Int16Array(raw.length / 2);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

function requireZstd(zstd: ZstdDecompress | undefined): ZstdDecompress {
  if (!zstd) {
    throw new ProtocolError("audio chunk is zstd-compressed but no decompressor was provided");
  }
  return zstd;
}
