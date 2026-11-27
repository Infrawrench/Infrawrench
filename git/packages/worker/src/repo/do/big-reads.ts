/**
 * A byte stream read in large pieces.
 *
 * The runtime hands a stream it owns (a request's body, a response from a
 * Durable Object, an R2 object) to JavaScript 4 096 bytes at a time when it
 * is read the ordinary way, however much is waiting: a 45 MiB pack is over
 * eleven thousand reads, each one a turn of the event loop. Locally a turn
 * is tens of microseconds and nobody notices. In production it is
 * milliseconds, which is a pack travelling at about 1.4 MiB/s (issue #1447).
 * Read into a buffer of our own, the same stream gives back as much as has
 * arrived, up to the buffer's size.
 */

/** The buffer a read is offered, unless the caller wants smaller pieces. */
export const BIG_READ_BYTES = 1024 * 1024;

export interface BigReadOptions {
  /** The largest piece handed on. Default `BIG_READ_BYTES`. */
  readonly bytes?: number;
  /**
   * Wait until this many bytes have arrived (or the stream has ended) before
   * handing any on. For a stream nobody is waiting on piece by piece: an
   * upload, which arrives in the network's small pieces. Never for an answer
   * that carries progress or keep-alive packets, which must leave as they
   * are written. Ignored where the runtime has no such read.
   */
  readonly atLeast?: number;
}

/** workerd's reader, which can wait for a minimum. Node's cannot. */
interface AtLeastReader extends ReadableStreamBYOBReader {
  readAtLeast?(
    minBytes: number,
    view: Uint8Array,
  ): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
}

/**
 * `stream`, read up to `BIG_READ_BYTES` at a time where it can be (a stream of
 * bytes the runtime owns), and as it comes where it cannot. Either way the
 * result is a stream of this code's own and is pulled, never pushed:
 * nothing is read before it is asked for.
 */
export function bigReads(
  stream: ReadableStream<Uint8Array>,
  options: BigReadOptions = {},
): ReadableStream<Uint8Array> {
  let reader: AtLeastReader;
  try {
    reader = stream.getReader({ mode: "byob" }) as AtLeastReader;
  } catch {
    // Not a byte stream (one made in JavaScript): its pieces are whatever its maker enqueued.
    return pulled(stream.getReader());
  }
  const bytes = options.bytes ?? BIG_READ_BYTES;
  // A read that brought less than this is copied out, and its buffer offered again.
  const keep = bytes / 4;
  const atLeast = Math.min(options.atLeast ?? 0, bytes);
  let buffer = new ArrayBuffer(bytes);
  const read = (): Promise<{ done: boolean; value?: Uint8Array | undefined }> => {
    const view = new Uint8Array(buffer);
    return atLeast > 1 && typeof reader.readAtLeast === "function"
      ? reader.readAtLeast(atLeast, view)
      : reader.read(view);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Until something is handed on: a pull that enqueues nothing is not called again.
        for (;;) {
          const { done, value } = await read();
          if (value !== undefined) buffer = value.buffer as ArrayBuffer;
          if (value !== undefined && value.byteLength >= keep) {
            controller.enqueue(value);
            buffer = new ArrayBuffer(bytes);
          } else if (value !== undefined && value.byteLength > 0) {
            // A whole buffer is not kept alive for a few bytes of it.
            controller.enqueue(value.slice());
          }
          if (done) controller.close();
          if (done || (value !== undefined && value.byteLength > 0)) return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function pulled(reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
