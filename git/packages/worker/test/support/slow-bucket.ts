/**
 * A bucket that answers the way R2 does from a Durable Object: every `get`
 * costs a round trip before its first byte, and its bytes arrive at a
 * finite rate. Local workerd has neither cost (its R2 is a file on the same
 * disk), which is how a serving path that makes thousands of small reads one
 * after another can look fast here and take a minute in production. The
 * counts are what to read first: a read that is not made costs nothing at
 * any latency.
 */
import type { BucketObject } from "../../src/repo/do/platform";
import { MemoryBucket } from "./node-platform";

export interface BucketProfile {
  /** Milliseconds before the first byte of a `get`. */
  readonly firstByteMs: number;
  /** Bytes a second of one `get`'s body. Each `get` is its own connection. */
  readonly bytesPerSecond: number;
}

export const INSTANT: BucketProfile = { firstByteMs: 0, bytesPerSecond: Infinity };

const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

export class SlowBucket extends MemoryBucket {
  profile: BucketProfile = INSTANT;
  /** Range reads and the bytes they returned, since the last `resetRead`. */
  read = { gets: 0, bytes: 0, inFlightPeak: 0 };
  private inFlight = 0;

  resetRead(): void {
    this.read = { gets: 0, bytes: 0, inFlightPeak: 0 };
  }

  override async get(
    key: string,
    options?: { readonly range?: { readonly offset: number; readonly length: number } },
  ): Promise<BucketObject | null> {
    const object = await super.get(key, options);
    if (!object) return null;
    const { profile } = this;
    const length = options?.range ? Math.min(options.range.length, object.size) : object.size;
    this.read.gets++;
    this.read.bytes += length;
    this.inFlight++;
    this.read.inFlightPeak = Math.max(this.read.inFlightPeak, this.inFlight);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.inFlight--;
    };
    try {
      await sleep(profile.firstByteMs);
    } catch (error) {
      release();
      throw error;
    }
    const transfer = (bytes: number): Promise<void> =>
      sleep(Number.isFinite(profile.bytesPerSecond) ? (bytes / profile.bytesPerSecond) * 1000 : 0);
    return {
      size: object.size,
      get body(): ReadableStream<Uint8Array> {
        const reader = object.body.getReader();
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) {
              release();
              controller.close();
              return;
            }
            await transfer(value.length);
            controller.enqueue(value);
          },
          cancel: async (reason) => {
            release();
            await reader.cancel(reason);
          },
        });
      },
      arrayBuffer: async () => {
        try {
          await transfer(length);
          return await object.arrayBuffer();
        } finally {
          release();
        }
      },
    };
  }
}
