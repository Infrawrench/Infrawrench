import { describe, expect, it } from "vitest";
import { parseNdjsonStream, parseSseStream } from "../sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("parseSseStream", () => {
  it("parses data events separated by blank lines", async () => {
    const events = await collect(parseSseStream(streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\n'])));
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("handles events split across chunks", async () => {
    const events = await collect(parseSseStream(streamOf(['data: {"a"', ":1}\n", "\n"])));
    expect(events).toEqual([{ a: 1 }]);
  });

  it("handles CRLF separators and event: lines", async () => {
    const events = await collect(
      parseSseStream(streamOf(['event: message\r\ndata: {"b":true}\r\n\r\n'])),
    );
    expect(events).toEqual([{ b: true }]);
  });

  it("skips comment keep-alives and frames without data", async () => {
    const events = await collect(parseSseStream(streamOf([': ping\n\ndata: {"a":1}\n\n'])));
    expect(events).toEqual([{ a: 1 }]);
  });

  it("joins multi-line data fields", async () => {
    const events = await collect(parseSseStream(streamOf(['data: {\ndata: "x": 5}\n\n'])));
    expect(events).toEqual([{ x: 5 }]);
  });
});

describe("parseNdjsonStream", () => {
  it("parses one object per line, including a trailing unterminated line", async () => {
    const events = await collect(parseNdjsonStream(streamOf(['{"a":1}\n{"a"', ':2}\n{"a":3}'])));
    expect(events).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("skips blank and malformed lines", async () => {
    const events = await collect(parseNdjsonStream(streamOf(['\n{"a":1}\nnot-json\n'])));
    expect(events).toEqual([{ a: 1 }]);
  });
});
