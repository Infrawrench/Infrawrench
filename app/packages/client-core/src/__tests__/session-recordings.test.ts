import { describe, expect, it } from "vitest";

import {
  castOutputThrough,
  castResumeIndex,
  formatPlaybackClock,
  formatRecordingBytes,
  formatRecordingDuration,
  parseCast,
  parseResizeData,
} from "../session-recordings";

const CAST = [
  '{"version":2,"width":100,"height":40,"timestamp":1754524800}',
  '[0.1,"o","one"]',
  '[0.5,"i","typed"]',
  '[1,"o","two"]',
  '[1.5,"r","120x50"]',
  '[2,"o","three"]',
].join("\n");

describe("parseCast", () => {
  it("reads geometry, events and total length", () => {
    const cast = parseCast(CAST);
    expect(cast.width).toBe(100);
    expect(cast.height).toBe(40);
    expect(cast.events).toHaveLength(5);
    expect(cast.durationSeconds).toBe(2);
  });

  it("reports zero length for a cast with no events", () => {
    expect(parseCast('{"version":2,"width":80,"height":24,"timestamp":0}').durationSeconds).toBe(0);
  });

  it("rejects only an unreadable header", () => {
    expect(() => parseCast("")).toThrow(/empty/i);
    expect(() => parseCast("garbage")).toThrow(/asciicast/i);
  });
});

describe("castOutputThrough", () => {
  const cast = parseCast(CAST);

  it("concatenates output up to and including the target time", () => {
    // Seeking a terminal is a replay, not a jump: the screen at t is the
    // product of every byte before t.
    expect(castOutputThrough(cast, 1)).toBe("onetwo");
    expect(castOutputThrough(cast, 2)).toBe("onetwothree");
  });

  it("excludes input events, which the host never rendered", () => {
    // What you see echoed at a prompt is output; replaying the keystroke too
    // would inject text the session never displayed.
    expect(castOutputThrough(cast, 2)).not.toContain("typed");
  });

  it("is empty before the first event", () => {
    expect(castOutputThrough(cast, 0)).toBe("");
  });

  it("clamps past the end rather than throwing", () => {
    expect(castOutputThrough(cast, 9_999)).toBe("onetwothree");
  });
});

describe("castResumeIndex", () => {
  const cast = parseCast(CAST);

  it("points at the first event strictly after the position", () => {
    expect(castResumeIndex(cast, 0)).toBe(0);
    expect(castResumeIndex(cast, 1)).toBe(3);
    expect(castResumeIndex(cast, 2)).toBe(cast.events.length);
  });
});

describe("parseResizeData", () => {
  it("reads COLSxROWS", () => {
    expect(parseResizeData("120x50")).toEqual({ cols: 120, rows: 50 });
    expect(parseResizeData(" 80x24 ")).toEqual({ cols: 80, rows: 24 });
  });

  it("returns null for anything else", () => {
    expect(parseResizeData("120")).toBeNull();
    expect(parseResizeData("axb")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats durations by magnitude", () => {
    expect(formatRecordingDuration(38_000)).toBe("38s");
    expect(formatRecordingDuration(252_000)).toBe("4m 12s");
    expect(formatRecordingDuration(3_720_000)).toBe("1h 02m");
    expect(formatRecordingDuration(null)).toBe("—");
  });

  it("formats the playback clock, adding hours only when needed", () => {
    expect(formatPlaybackClock(0)).toBe("0:00");
    expect(formatPlaybackClock(75)).toBe("1:15");
    expect(formatPlaybackClock(3_731)).toBe("1:02:11");
  });

  it("formats sizes with one decimal only below 10 units", () => {
    expect(formatRecordingBytes(0)).toBe("0 B");
    expect(formatRecordingBytes(512)).toBe("512 B");
    expect(formatRecordingBytes(1536)).toBe("1.5 KB");
    expect(formatRecordingBytes(20 * 1024 * 1024)).toBe("20 MB");
  });
});
