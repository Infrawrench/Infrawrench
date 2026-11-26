/**
 * zlib through the platform's `CompressionStream` / `DecompressionStream`.
 *
 * These are for a stream that is the whole input: a loose object, an object
 * about to be written into a pack. A stream with more data after it (every
 * entry inside a pack) goes through `inflateSync` / `Inflater` in
 * `./inflate`, which report where the stream ended.
 */
import { GitError } from "./errors";
import { collectBytes, streamOf } from "./stream";

/** zlib-compresses `data` (the `deflate` format: RFC 1950 around RFC 1951). */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return collectBytes(deflateStream(streamOf(data)));
}

export interface InflateLimits {
  /**
   * Refuse to produce more than this many bytes. A few kilobytes of zlib can
   * describe gigabytes, so anything inflating input it did not write passes one.
   */
  readonly maxSize?: number;
}

/** Inflates a complete zlib stream. Rejects when it is damaged, truncated or followed by more. */
export async function inflate(data: Uint8Array, limits: InflateLimits = {}): Promise<Uint8Array> {
  const limit = limits.maxSize ?? Number.POSITIVE_INFINITY;
  let total = 0;
  // Counted chunk by chunk as the stream produces them, so the cap holds
  // before the output is gathered rather than after.
  const capped = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.length;
      if (total > limit) throw new GitError("limit", "zlib stream inflates past the limit");
      controller.enqueue(chunk);
    },
  });
  try {
    return await collectBytes(inflateStream(streamOf(data)).pipeThrough(capped));
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw new GitError("bad-zlib", `zlib: ${error instanceof Error ? error.message : "failed"}`);
  }
}

export function deflateStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return source.pipeThrough(
    new CompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
}

export function inflateStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return source.pipeThrough(
    new DecompressionStream("deflate") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
}
