/**
 * Playback for a session's audio stream.
 *
 * One player per `AppSession`, shared by however many window tabs are open on
 * it — the host mixes every application into a single stream, so a second
 * player would mean hearing everything twice. Viewers acquire and release;
 * while nothing holds the player, the host is told to stop sending, because
 * PCM nobody plays is bandwidth spent on nothing.
 */

import { decompress } from "fzstd";
import {
  AUDIO_FLAG_RESET,
  audioChunkPcm,
  type AppSession,
  type AudioChunk,
} from "@infrawrench/appstream-core";

/**
 * The corner of the Web Audio API this player uses, typed structurally so a
 * test can hand in a fake — jsdom has no `AudioContext` at all.
 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: "suspended" | "running" | "closed";
  readonly destination: unknown;
  createGain(): GainNodeLike;
  createBuffer(channels: number, frames: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface GainNodeLike {
  gain: { value: number };
  connect(target: unknown): unknown;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(target: unknown): unknown;
  start(when: number): void;
}

/**
 * Chunks are scheduled this far ahead of the clock. The stream rides the same
 * ordered byte stream as the pixels, so a 256 KiB frame ahead of a chunk is
 * jitter this buffer has to absorb; it grows when the link proves worse.
 */
const INITIAL_LEAD_S = 0.15;
const MAX_LEAD_S = 0.5;
/** A chunk due sooner than this is effectively late. */
const LATE_MARGIN_S = 0.02;

const zstd = (input: Uint8Array) => decompress(input);

export class SessionAudio {
  #session: AppSession;
  #createContext: (() => AudioContextLike) | undefined;
  #ctx: AudioContextLike | undefined;
  #gain: GainNodeLike | undefined;
  #nextTime = 0;
  #lead = INITIAL_LEAD_S;
  #lastSeq: number | undefined;
  #muted = false;
  #holders = 0;
  #listeners = new Set<() => void>();
  #onChunk = (chunk: AudioChunk) => this.#play(chunk);
  #resumeInstalled = false;
  #resume = () => {
    void this.#ctx?.resume().catch(() => undefined);
  };

  constructor(session: AppSession, createContext?: () => AudioContextLike) {
    this.#session = session;
    this.#createContext =
      createContext ??
      (typeof AudioContext === "function"
        ? () => new AudioContext() as unknown as AudioContextLike
        : undefined);
    session.addAudioListener(this.#onChunk);
  }

  /** Whether the host streams audio at all. Stable once the session is ready. */
  get available(): boolean {
    return this.#session.serverCaps?.audio === true;
  }

  get muted(): boolean {
    return this.#muted;
  }

  /** Notifies whenever `muted` changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setMuted(muted: boolean): void {
    if (this.#muted === muted) return;
    this.#muted = muted;
    // Both ends: the gain silences what is already scheduled, the control
    // message stops more PCM crossing the link.
    if (this.#gain) this.#gain.gain.value = muted ? 0 : 1;
    this.#setStream(!muted);
    for (const listener of this.#listeners) listener();
  }

  /**
   * Only ever spoken to a host that advertised audio: a host old enough not
   * to know the message would report it as a session-wide error.
   */
  #setStream(enabled: boolean): void {
    if (this.available) this.#session.setAudioEnabled(enabled);
  }

  #play(chunk: AudioChunk): void {
    // Chunks can race a mute or the last viewer's release over the wire;
    // drop them rather than whisper or resurrect a closed context.
    if (this.#muted || this.#holders === 0 || !this.#createContext) return;

    if (!this.#ctx) {
      try {
        this.#ctx = this.#createContext();
      } catch {
        return; // no audio output on this machine; stay silent
      }
      const gain = this.#ctx.createGain();
      gain.gain.value = this.#muted ? 0 : 1;
      gain.connect(this.#ctx.destination);
      this.#gain = gain;
    }
    const ctx = this.#ctx;

    // Until the user has interacted with the page the context stays
    // suspended and its clock does not advance; scheduling against it would
    // pile every chunk onto the same instant, to be released as a burst.
    if (ctx.state === "suspended") {
      this.#resume();
      if (!this.#resumeInstalled && typeof window !== "undefined") {
        this.#resumeInstalled = true;
        window.addEventListener("pointerdown", this.#resume);
        window.addEventListener("keydown", this.#resume);
      }
      this.#lastSeq = undefined;
      return;
    }

    let pcm: Int16Array;
    try {
      pcm = audioChunkPcm(chunk, zstd);
    } catch {
      return; // one bad chunk is a click, not a broken session
    }
    const channels = Math.max(1, chunk.channels);
    const frames = Math.floor(pcm.length / channels);
    if (frames === 0) return;

    const buffer = ctx.createBuffer(channels, frames, chunk.sampleRate);
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        data[frame] = (pcm[frame * channels + channel] ?? 0) / 32768;
      }
    }

    const gap = this.#lastSeq !== undefined && chunk.seq !== (this.#lastSeq + 1) % 0x1_0000_0000;
    this.#lastSeq = chunk.seq;
    const now = ctx.currentTime;
    const late = this.#nextTime < now + LATE_MARGIN_S;
    if (chunk.flags & AUDIO_FLAG_RESET || gap || late) {
      // Underruns while streaming mean the buffer is too shallow for this
      // link; a deliberate restart does not.
      if (late && !(chunk.flags & AUDIO_FLAG_RESET) && !gap && this.#nextTime > 0) {
        this.#lead = Math.min(this.#lead * 1.5, MAX_LEAD_S);
      }
      this.#nextTime = now + this.#lead;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#gain as unknown as object);
    source.start(this.#nextTime);
    this.#nextTime += frames / chunk.sampleRate;
  }

  /** @internal reference counting for {@link acquireSessionAudio}. */
  acquire(): void {
    this.#holders += 1;
    if (this.#holders === 1 && !this.#muted) {
      // The stream may have been turned off when the last viewer left.
      this.#setStream(true);
    }
  }

  /** Release one holder; the last one quiets the stream at the source. */
  release(): void {
    this.#holders -= 1;
    if (this.#holders > 0) return;
    this.#setStream(false);
    this.#lastSeq = undefined;
    if (this.#resumeInstalled && typeof window !== "undefined") {
      this.#resumeInstalled = false;
      window.removeEventListener("pointerdown", this.#resume);
      window.removeEventListener("keydown", this.#resume);
    }
    if (this.#ctx) {
      void this.#ctx.close().catch(() => undefined);
      this.#ctx = undefined;
      this.#gain = undefined;
      this.#nextTime = 0;
      this.#lead = INITIAL_LEAD_S;
    }
  }
}

const players = new WeakMap<AppSession, SessionAudio>();

/**
 * The player for a session, created on first use. Callers must `release()`
 * exactly once, mirroring the session registry's own contract.
 */
export function acquireSessionAudio(session: AppSession): SessionAudio {
  let player = players.get(session);
  if (!player) {
    player = new SessionAudio(session);
    players.set(session, player);
  }
  player.acquire();
  return player;
}
