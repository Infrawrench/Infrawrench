/**
 * `bigReads`: a stream the runtime owns is read into a buffer of ours, so a
 * pack crosses in megabytes rather than 4 096 bytes a turn (#1447). The
 * runtime's stream is stood in for by a byte stream that fills whatever
 * buffer a read offers it, which is what workerd's does.
 */
import { describe, expect, it } from "vitest";
import { BIG_READ_BYTES, bigReads } from "../src/repo/do/big-reads";
import { randomBytes } from "./support/git";

/** A byte stream that gives a read as much as it asks for, up to `most` at a time. */
function owned(
  bytes: Uint8Array,
  most = Infinity,
  log: { reads: number; cancelled?: unknown } = { reads: 0 },
): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    type: "bytes",
    pull(controller) {
      const request = controller.byobRequest;
      if (!request?.view) throw new Error("read without a buffer");
      if (at >= bytes.length) {
        controller.close();
        request.respond(0);
        return;
      }
      log.reads++;
      const view = request.view as Uint8Array;
      const take = Math.min(view.byteLength, bytes.length - at, most);
      new Uint8Array(view.buffer, view.byteOffset, take).set(bytes.subarray(at, at + take));
      at += take;
      request.respond(take);
    },
    cancel(reason) {
      log.cancelled = reason;
    },
  }) as ReadableStream<Uint8Array>;
}

async function pieces(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

const joined = (parts: readonly Uint8Array[]): Buffer => Buffer.concat(parts);

describe("a stream read in large pieces", () => {
  it("takes as much as each read can hold", async () => {
    const bytes = randomBytes(5 * BIG_READ_BYTES + 1234, 3);
    const log = { reads: 0 };
    const got = await pieces(bigReads(owned(bytes, Infinity, log)));
    expect(Buffer.compare(joined(got), bytes)).toBe(0);
    // Six reads, where 4 096 bytes a read is 1 281.
    expect(got).toHaveLength(6);
    expect(log.reads).toBe(6);
    expect(got[0]!.byteLength).toBe(BIG_READ_BYTES);
  });

  it("hands on what has arrived, without keeping a whole buffer alive for it", async () => {
    const bytes = randomBytes(1000, 4);
    const got = await pieces(bigReads(owned(bytes, 64)));
    expect(Buffer.compare(joined(got), bytes)).toBe(0);
    expect(got).toHaveLength(16);
    for (const piece of got) expect(piece.buffer.byteLength).toBe(piece.byteLength);
  });

  it("offers a buffer of the size asked for", async () => {
    const bytes = randomBytes(1_000_000, 5);
    const got = await pieces(bigReads(owned(bytes), { bytes: 256 * 1024 }));
    expect(Buffer.compare(joined(got), bytes)).toBe(0);
    expect(Math.max(...got.map((piece) => piece.byteLength))).toBe(256 * 1024);
  });

  it("passes on a stream that is not the runtime's as it comes", async () => {
    const parts = [randomBytes(10, 6), randomBytes(70_000, 7), randomBytes(3, 8)];
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = parts[pulls++];
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const got = await pieces(bigReads(source, { atLeast: 65536 }));
    expect(got.map((piece) => piece.byteLength)).toEqual([10, 70_000, 3]);
    expect(Buffer.compare(joined(got), joined(parts))).toBe(0);
  });

  it("reads nothing until it is asked, and cancels what it reads from", async () => {
    const log: { reads: number; cancelled?: unknown } = { reads: 0 };
    const stream = bigReads(owned(randomBytes(3 * BIG_READ_BYTES, 9), Infinity, log));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(log.reads).toBeLessThanOrEqual(1);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel("enough");
    expect(log.cancelled).toBe("enough");
  });

  it("fails when the stream under it fails", async () => {
    let pulls = 0;
    const source = new ReadableStream({
      type: "bytes",
      pull(controller) {
        if (pulls++ > 0) throw new Error("the connection went away");
        const view = controller.byobRequest!.view as Uint8Array;
        new Uint8Array(view.buffer, view.byteOffset, 4).fill(7);
        controller.byobRequest!.respond(4);
      },
    }) as ReadableStream<Uint8Array>;
    const reader = bigReads(source).getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([7, 7, 7, 7]));
    await expect(reader.read()).rejects.toThrow("the connection went away");
  });
});
