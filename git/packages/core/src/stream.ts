/** Small Web Streams helpers shared by the zlib, pack and pkt-line code. */
import { concatBytes } from "./bytes";

/** Anything that yields byte chunks: a `ReadableStream`, an async generator, or an array in tests. */
export type ByteSource =
  ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * Iterates a byte source. A `ReadableStream` is read through a reader
 * rather than its own async iterator, which not every runtime has.
 */
export async function* iterateBytes(source: ByteSource): AsyncGenerator<Uint8Array, void, void> {
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value.length > 0) yield value;
      }
    } finally {
      // Leaving early (a parse error, a consumer that stops) must not keep the producer running.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    yield* source;
  }
}

export async function collectBytes(source: ByteSource): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterateBytes(source)) chunks.push(chunk);
  return concatBytes(chunks);
}

/** A stream of the given chunks, for handing a buffer to something that wants a stream. */
export function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
}

/** A `ReadableStream` over an async generator, with the generator closed if the reader cancels. */
export function streamFrom(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  let iterator: AsyncIterator<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      iterator ??= iterable[Symbol.asyncIterator]();
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator?.return?.();
    },
  });
}
