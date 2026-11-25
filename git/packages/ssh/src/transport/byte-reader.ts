/**
 * Exact-length reads over a stream that delivers chunks of any size.
 */
import { EMPTY } from "../bytes";
import { DisconnectReason, SshError } from "../errors";

export class ByteReader {
  private chunk: Uint8Array = EMPTY;
  private offset = 0;
  private ended = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  /**
   * The next `length` bytes, or null when the stream ended cleanly before the
   * first of them. Ending part-way through is an error. The result may be a
   * view into a chunk the stream delivered, so it is only valid until the
   * caller is done with it; nothing here writes to it again.
   */
  async read(length: number): Promise<Uint8Array | null> {
    const available = this.chunk.length - this.offset;
    if (available >= length) {
      const view = this.chunk.subarray(this.offset, this.offset + length);
      this.offset += length;
      return view;
    }
    const out = new Uint8Array(length);
    out.set(this.chunk.subarray(this.offset), 0);
    let filled = available;
    this.chunk = EMPTY;
    this.offset = 0;
    while (filled < length) {
      const next = this.ended ? null : await this.pull();
      if (!next) {
        if (filled === 0) return null;
        throw new SshError(DisconnectReason.CONNECTION_LOST, "connection closed mid-packet");
      }
      const take = Math.min(next.length, length - filled);
      out.set(next.subarray(0, take), filled);
      filled += take;
      if (take < next.length) {
        this.chunk = next;
        this.offset = take;
      }
    }
    return out;
  }

  private async pull(): Promise<Uint8Array | null> {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await this.reader.read();
      } catch {
        // A reset or any other stream failure: all the caller can use is that the peer is gone.
        throw new SshError(DisconnectReason.CONNECTION_LOST, "connection lost");
      }
      if (result.done) {
        this.ended = true;
        return null;
      }
      if (result.value.length > 0) return result.value;
    }
  }
}
