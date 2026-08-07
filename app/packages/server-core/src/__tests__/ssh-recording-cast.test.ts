import { describe, expect, it } from "vitest";

import {
  encodeCastEvent,
  encodeCastHeader,
  encodeResizeData,
  parseCast,
} from "../ssh-recording/cast";

describe("asciicast encoding", () => {
  it("writes a v2 header with the spec's field order", () => {
    expect(encodeCastHeader({ width: 120, height: 30, timestamp: 1754524800 })).toBe(
      '{"version":2,"width":120,"height":30,"timestamp":1754524800}',
    );
  });

  it("includes title and env only when set", () => {
    const header = JSON.parse(
      encodeCastHeader({
        width: 80,
        height: 24,
        timestamp: 1,
        title: "root@10.0.0.4",
        env: { TERM: "xterm-256color" },
      }),
    ) as Record<string, unknown>;
    expect(header["title"]).toBe("root@10.0.0.4");
    expect(header["env"]).toEqual({ TERM: "xterm-256color" });

    expect(encodeCastHeader({ width: 80, height: 24, timestamp: 1, env: {} })).not.toContain("env");
  });

  it("clamps degenerate geometry rather than emitting a zero-size cast", () => {
    expect(encodeCastHeader({ width: 0, height: -4, timestamp: 0 })).toContain('"width":1');
    expect(encodeCastHeader({ width: 0, height: -4, timestamp: 0 })).toContain('"height":1');
  });

  it("rounds event times to milliseconds", () => {
    // A raw float would grow a 17-digit tail on every line of a long session.
    expect(encodeCastEvent(1.23456789, "o", "hi")).toBe('[1.235,"o","hi"]');
  });

  it("never writes a negative timestamp", () => {
    expect(encodeCastEvent(-0.5, "o", "x")).toBe('[0,"o","x"]');
  });

  it("escapes control bytes through JSON, so a line stays a line", () => {
    const line = encodeCastEvent(0, "o", "a\nb\r\n");
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)[2]).toBe("a\nb\r\n");
  });

  it("formats resize payloads as COLSxROWS", () => {
    expect(encodeResizeData(120, 40)).toBe("120x40");
    expect(encodeResizeData(0, 0)).toBe("1x1");
  });
});

describe("parseCast", () => {
  const cast = [
    '{"version":2,"width":100,"height":40,"timestamp":1754524800,"title":"root@host"}',
    '[0.1,"o","$ "]',
    '[0.5,"i","ls\\r"]',
    '[1.25,"r","120x50"]',
    '[2,"o","file.txt\\r\\n"]',
  ].join("\n");

  it("round-trips a document this module wrote", () => {
    const parsed = parseCast(cast);
    expect(parsed.header.width).toBe(100);
    expect(parsed.header.title).toBe("root@host");
    expect(parsed.events).toHaveLength(4);
    expect(parsed.events[2]).toEqual({ time: 1.25, code: "r", data: "120x50" });
  });

  it("drops a truncated final line instead of failing the recording", () => {
    // The realistic corruption: a chunk write cut off mid-flush. Losing that
    // frame must not cost the ten minutes in front of it.
    const parsed = parseCast(`${cast}\n[3,"o","half`);
    expect(parsed.events).toHaveLength(4);
  });

  it("skips events with an unknown code or a non-string payload", () => {
    const parsed = parseCast(
      ['{"version":2,"width":80,"height":24,"timestamp":0}', '[1,"x","?"]', '[2,"o",5]'].join("\n"),
    );
    expect(parsed.events).toHaveLength(0);
  });

  it("tolerates blank lines around the body", () => {
    const parsed = parseCast(`\n${cast}\n\n`);
    expect(parsed.events).toHaveLength(4);
  });

  it("throws only when the header itself is unreadable", () => {
    expect(() => parseCast("")).toThrow(/empty/i);
    expect(() => parseCast('not json\n[0,"o","x"]')).toThrow(/asciicast/i);
  });

  it("defaults geometry when the header omits it", () => {
    const parsed = parseCast('{"version":2}\n[0,"o","x"]');
    expect(parsed.header.width).toBe(80);
    expect(parsed.header.height).toBe(24);
  });
});
