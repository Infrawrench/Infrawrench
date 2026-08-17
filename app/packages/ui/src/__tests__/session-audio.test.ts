/**
 * The session audio player against a fake Web Audio clock — jsdom has no
 * `AudioContext`, which is exactly why the player takes one structurally.
 */

import { describe, expect, it } from "vitest";
import { AUDIO_HEADER_LEN, AudioCodec, type AppSession } from "@infrawrench/appstream-core";

import {
  SessionAudio,
  type AudioBufferSourceLike,
  type AudioContextLike,
} from "../apps/session-audio";

type AudioListener = (chunk: {
  codec: number;
  channels: number;
  flags: number;
  seq: number;
  sampleRate: number;
  data: Uint8Array;
}) => void;

/** The slice of AppSession the player touches. */
class FakeSession {
  listeners = new Set<AudioListener>();
  enabled: boolean[] = [];
  serverCaps = { vp9: false, webp: false, xwayland: false, audio: true, runtimeDir: true };

  addAudioListener(listener: AudioListener): void {
    this.listeners.add(listener);
  }
  removeAudioListener(listener: AudioListener): void {
    this.listeners.delete(listener);
  }
  setAudioEnabled(enabled: boolean): void {
    this.enabled.push(enabled);
  }

  deliver(seq: number, frames: number, flags = 0): void {
    const data = new Uint8Array(frames * 4); // stereo s16, silence
    const payload = new Uint8Array(AUDIO_HEADER_LEN + data.length);
    payload[0] = AudioCodec.PcmS16;
    payload[1] = 2;
    const view = new DataView(payload.buffer);
    view.setUint16(2, flags, true);
    view.setUint32(4, seq, true);
    view.setUint32(8, 48_000, true);
    for (const listener of this.listeners) {
      listener({
        codec: AudioCodec.PcmS16,
        channels: 2,
        flags,
        seq,
        sampleRate: 48_000,
        data,
      });
    }
  }
}

class FakeContext implements AudioContextLike {
  currentTime = 0;
  state: "suspended" | "running" | "closed" = "running";
  destination = {};
  starts: number[] = [];
  closed = false;
  gains: Array<{ gain: { value: number }; connect: () => void }> = [];

  createGain() {
    const gain = { gain: { value: 1 }, connect: () => undefined };
    this.gains.push(gain);
    return gain;
  }
  createBuffer(channels: number, frames: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return { getChannelData: (channel: number) => data[channel]! };
  }
  createBufferSource(): AudioBufferSourceLike {
    const starts = this.starts;
    return {
      buffer: null,
      connect: () => undefined,
      start(when: number) {
        starts.push(when);
      },
    };
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
    return Promise.resolve();
  }
}

function player() {
  const session = new FakeSession();
  const ctx = new FakeContext();
  const audio = new SessionAudio(session as unknown as AppSession, () => ctx);
  audio.acquire();
  return { session, ctx, audio };
}

describe("SessionAudio", () => {
  it("schedules chunks back to back behind the jitter lead", () => {
    const { session, ctx } = player();
    session.deliver(0, 480, 1 /* reset */);
    session.deliver(1, 480);
    session.deliver(2, 480);

    expect(ctx.starts).toHaveLength(3);
    expect(ctx.starts[0]).toBeCloseTo(0.15, 5);
    expect(ctx.starts[1]).toBeCloseTo(0.16, 5); // +480/48000
    expect(ctx.starts[2]).toBeCloseTo(0.17, 5);
  });

  it("resynchronises on a sequence gap instead of stretching", () => {
    const { session, ctx } = player();
    session.deliver(0, 480, 1);
    ctx.currentTime = 0.005;
    session.deliver(5, 480); // 1–4 lost on the link

    expect(ctx.starts[1]).toBeCloseTo(0.005 + 0.15, 5);
  });

  it("grows the lead after an underrun", () => {
    const { session, ctx } = player();
    session.deliver(0, 480, 1);
    // The clock overtakes what was scheduled: everything already played out.
    ctx.currentTime = 1.0;
    session.deliver(1, 480);
    expect(ctx.starts[1]).toBeCloseTo(1.0 + 0.15 * 1.5, 5);
  });

  it("mute stops the stream at the source and unmute restarts it", () => {
    const { session, ctx, audio } = player();
    session.deliver(0, 480, 1);

    audio.setMuted(true);
    expect(session.enabled.at(-1)).toBe(false);
    expect(ctx.gains[0]!.gain.value).toBe(0);
    session.deliver(1, 480);
    expect(ctx.starts).toHaveLength(1);

    audio.setMuted(false);
    expect(session.enabled.at(-1)).toBe(true);
    expect(ctx.gains[0]!.gain.value).toBe(1);
  });

  it("notifies subscribers when the muted state changes", () => {
    const { audio } = player();
    let calls = 0;
    const unsubscribe = audio.subscribe(() => (calls += 1));
    audio.setMuted(true);
    audio.setMuted(true); // no change, no notification
    unsubscribe();
    audio.setMuted(false);
    expect(calls).toBe(1);
  });

  it("does not schedule against a suspended context", () => {
    const { session, ctx } = player();
    ctx.state = "suspended";
    // resume() flips the fake straight back to running, so deliver twice: the
    // first chunk finds it suspended and is dropped.
    const resumes: number[] = [];
    const originalResume = ctx.resume.bind(ctx);
    ctx.resume = () => {
      resumes.push(1);
      return originalResume();
    };
    session.deliver(0, 480, 1);
    expect(ctx.starts).toHaveLength(0);
    expect(resumes.length).toBeGreaterThan(0);
    session.deliver(1, 480);
    expect(ctx.starts).toHaveLength(1);
  });

  it("quiets the stream and closes the context when the last viewer leaves", () => {
    const { session, ctx, audio } = player();
    session.deliver(0, 480, 1);
    audio.acquire(); // a second window tab
    audio.release();
    expect(ctx.closed).toBe(false);
    audio.release();
    expect(ctx.closed).toBe(true);
    expect(session.enabled.at(-1)).toBe(false);
    // A chunk still in flight must not resurrect the closed context.
    session.deliver(1, 480);
    expect(ctx.starts).toHaveLength(1);
  });
});
