/**
 * One `session` channel (RFC 4254, sections 5 and 6): the byte streams of a
 * command, and the flow control that keeps them bounded.
 *
 * Each side grants the other a window of bytes it may send and tops it up
 * as it consumes them. Inbound, the window is only topped up when the
 * command actually reads its stdin, so a client can never make the server
 * hold more than one window of unread data. Outbound, a write waits for the
 * client's window and then for the socket, so a command that produces data
 * faster than the client takes it is slowed down rather than buffered.
 */
import { protocolError } from "./errors";
import { EXTENDED_DATA_STDERR, Msg } from "./messages";
import type { PacketSink } from "./transport/transport";
import { WireWriter } from "./wire";

/** The streams of a running command, as its handler sees them. */
export interface ExecChannel {
  /** What the client sends. Ends when the client closes its side. */
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: WritableStream<Uint8Array>;
  readonly stderr: WritableStream<Uint8Array>;
  /**
   * Aborted when the client closes the channel or the connection goes away
   * before the command has finished. The streams fail at the same moment;
   * the signal is for work that is not waiting on them.
   */
  readonly signal: AbortSignal;
}

export interface ChannelSettings {
  /** The window granted to the client, and so the most unread stdin held in memory. */
  readonly window: number;
  /** The largest data payload the client may send in one message. */
  readonly maxPacket: number;
}

/** The largest data payload the server puts in one message, whatever the client allows. */
const MAX_OUTBOUND_CHUNK = 32768;
const MAX_WINDOW = 0xffffffff;

const noop = (): void => {};

export class SessionChannel {
  readonly env = new Map<string, string>();
  /** A command or the shell greeting has been started; a channel runs one thing. */
  started = false;
  /** The server has sent `CHANNEL_CLOSE`; nothing more may be sent on the channel. */
  closeSent = false;
  /** Settles when the command and the closing messages after it are done. */
  finished: Promise<void> = Promise.resolve();

  private readonly io: ExecChannel;
  private readonly abortController = new AbortController();
  private aborted = false;

  // Inbound.
  private localWindow: number;
  private unacknowledged = 0;
  private readonly queue: Uint8Array[] = [];
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private waitingPull: (() => void) | null = null;
  private inputEnded = false;
  private inputDiscarded = false;
  private inputStreamDone = false;

  // Outbound.
  private remoteWindow: number;
  private readonly maxChunk: number;
  private outputClosed = false;
  private windowWaiters: Array<() => void> = [];

  constructor(
    private readonly sink: PacketSink,
    readonly remoteId: number,
    remoteWindow: number,
    remoteMaxPacket: number,
    private readonly settings: ChannelSettings,
  ) {
    this.localWindow = settings.window;
    this.remoteWindow = remoteWindow;
    this.maxChunk = Math.min(remoteMaxPacket, MAX_OUTBOUND_CHUNK);
    this.io = {
      // A high-water mark of zero: the stream asks for data only when the
      // command is actually waiting to read, which is what lets the window
      // follow real consumption.
      stdin: new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            this.controller = controller;
          },
          pull: () => this.pull(),
          cancel: () => {
            // The command stopped reading (its own stdin closed, say). The
            // stream is finished from here on; data and EOF still arrive.
            this.inputStreamDone = true;
            this.resolvePull();
            this.discardInput();
          },
        },
        { highWaterMark: 0 },
      ),
      stdout: new WritableStream<Uint8Array>({ write: (chunk) => this.write(chunk, false) }),
      stderr: new WritableStream<Uint8Array>({ write: (chunk) => this.write(chunk, true) }),
      signal: this.abortController.signal,
    };
  }

  // What the client sent.

  receiveData(data: Uint8Array): void {
    this.consumeWindow(data.length);
    if (this.inputDiscarded || this.inputStreamDone) {
      this.acknowledge(data.length);
      return;
    }
    if (this.waitingPull) {
      this.controller.enqueue(data);
      this.acknowledge(data.length);
      this.resolvePull();
    } else {
      this.queue.push(data);
    }
  }

  /** Clients have no stderr to send; the bytes still count against the window. */
  receiveExtendedData(length: number): void {
    this.consumeWindow(length);
    this.acknowledge(length);
  }

  receiveEof(): void {
    this.inputEnded = true;
    // With data still queued, the stream is closed when the last of it is pulled.
    if (this.waitingPull) {
      this.closeInputStream();
      this.resolvePull();
    }
  }

  receiveWindowAdjust(bytes: number): void {
    if (this.remoteWindow + bytes > MAX_WINDOW) throw protocolError("channel window overflow");
    this.remoteWindow += bytes;
    this.wakeWriters();
  }

  /**
   * The client closed the channel. Whatever was running is abandoned, and
   * the close is returned unless the server already sent its own. Returns
   * whether that reply is still owed.
   */
  receiveClose(): boolean {
    this.abort(new Error("the client closed the channel"));
    if (this.closeSent) return false;
    this.closeSent = true;
    return true;
  }

  // Running something.

  /**
   * Run `handler` with the channel's streams, then report its exit status
   * and close the channel. `onError` hears about a handler that throws; the
   * client is told only that the command failed.
   */
  start(handler: (io: ExecChannel) => Promise<number>, onError: (error: unknown) => void): void {
    this.started = true;
    // The connection can go away between a request being accepted and this.
    if (this.aborted) return;
    this.finished = this.run(handler, onError);
  }

  /** Answer a shell request: say `text`, exit with `status`. */
  greet(text: Uint8Array, status: number): void {
    this.discardInput();
    this.start(async (io) => {
      const writer = io.stdout.getWriter();
      await writer.write(text);
      await writer.close();
      return status;
    }, noop);
  }

  /** Stop everything: the client closed the channel, or the connection is gone. */
  abort(reason: Error): void {
    if (this.aborted) return;
    this.aborted = true;
    this.outputClosed = true;
    this.inputDiscarded = true;
    this.queue.length = 0;
    if (!this.inputStreamDone) {
      this.inputStreamDone = true;
      this.controller.error(reason);
    }
    this.resolvePull();
    this.wakeWriters();
    this.abortController.abort(reason);
  }

  private async run(
    handler: (io: ExecChannel) => Promise<number>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    let status = 1;
    try {
      const result = await handler(this.io);
      if (Number.isInteger(result) && result >= 0 && result <= 0xffffffff) status = result;
    } catch (error) {
      // Once aborted, the handler failing is the expected consequence.
      if (!this.aborted) onError(error);
    }
    if (this.aborted) return;
    try {
      await this.flushOutput();
    } catch {
      // The streams fail only when the channel has; the check below covers it.
    }
    if (this.aborted || this.closeSent) return;

    this.outputClosed = true;
    this.discardInput();
    // Handed over together, so that a close arriving from the client in
    // between cannot be answered in the middle of them. Exit status first,
    // then end of output, then close: the order OpenSSH's own server uses,
    // and git's client reads the status before it lets go of the channel.
    const sent = [
      this.sink.send(
        new WireWriter()
          .byte(Msg.CHANNEL_REQUEST)
          .uint32(this.remoteId)
          .string("exit-status")
          .boolean(false)
          .uint32(status)
          .finish(),
      ),
      this.sink.send(new WireWriter().byte(Msg.CHANNEL_EOF).uint32(this.remoteId).finish()),
      this.sink.send(new WireWriter().byte(Msg.CHANNEL_CLOSE).uint32(this.remoteId).finish()),
    ];
    this.closeSent = true;
    await Promise.allSettled(sent);
  }

  /**
   * Let output the handler queued but did not wait for reach the client. A
   * stream the handler still holds a writer on cannot be closed from here;
   * its handler is expected to have waited for its own writes.
   */
  private async flushOutput(): Promise<void> {
    for (const stream of [this.io.stdout, this.io.stderr]) {
      if (stream.locked) continue;
      // Rejects when the handler already closed it, which is the usual case.
      await stream.close().catch(noop);
    }
  }

  // Inbound flow control.

  private consumeWindow(length: number): void {
    if (this.inputEnded) throw protocolError("channel data after EOF");
    if (length > this.settings.maxPacket) throw protocolError("channel packet too large");
    if (length > this.localWindow) throw protocolError("channel window exceeded");
    this.localWindow -= length;
  }

  private pull(): Promise<void> | void {
    const chunk = this.queue.shift();
    if (chunk) {
      this.controller.enqueue(chunk);
      this.acknowledge(chunk.length);
      return;
    }
    if (this.inputEnded) {
      this.closeInputStream();
      return;
    }
    // Stays pending until data, EOF or an abort; the stream does not pull
    // again in the meantime.
    return new Promise((resolve) => {
      this.waitingPull = resolve;
    });
  }

  private resolvePull(): void {
    const resolve = this.waitingPull;
    this.waitingPull = null;
    resolve?.();
  }

  private closeInputStream(): void {
    if (this.inputStreamDone) return;
    this.inputStreamDone = true;
    this.controller.close();
  }

  /** Stop keeping what the client sends; its window is still topped up so it is never left stuck. */
  private discardInput(): void {
    if (this.inputDiscarded) return;
    this.inputDiscarded = true;
    let dropped = 0;
    for (const chunk of this.queue) dropped += chunk.length;
    this.queue.length = 0;
    this.acknowledge(dropped);
  }

  /**
   * `bytes` have left the channel's hands. Once half the window has, give
   * that much back to the client: often enough that it never stalls, rarely
   * enough that adjustments are a negligible share of the traffic.
   */
  private acknowledge(bytes: number): void {
    this.unacknowledged += bytes;
    if (this.unacknowledged < this.settings.window / 2) return;
    if (this.inputEnded || this.closeSent || this.aborted) return;
    const grant = this.unacknowledged;
    this.unacknowledged = 0;
    this.localWindow += grant;
    // Not awaited: this runs inside the read loop and inside stream pulls,
    // and neither may wait on the socket. A failure here is the connection
    // failing, which the transport reports itself.
    this.sink
      .send(
        new WireWriter()
          .byte(Msg.CHANNEL_WINDOW_ADJUST)
          .uint32(this.remoteId)
          .uint32(grant)
          .finish(),
      )
      .catch(noop);
  }

  // Outbound flow control.

  private async write(chunk: Uint8Array, stderr: boolean): Promise<void> {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("channel output must be Uint8Array");
    let offset = 0;
    while (offset < chunk.length) {
      if (this.outputClosed) throw new Error("the channel is closed");
      if (this.remoteWindow === 0) {
        await new Promise<void>((resolve) => this.windowWaiters.push(resolve));
        continue;
      }
      // Taken from the window before the await, so stdout and stderr
      // writing at once cannot both spend the same bytes.
      const length = Math.min(chunk.length - offset, this.remoteWindow, this.maxChunk);
      this.remoteWindow -= length;
      const header = new WireWriter()
        .byte(stderr ? Msg.CHANNEL_EXTENDED_DATA : Msg.CHANNEL_DATA)
        .uint32(this.remoteId);
      if (stderr) header.uint32(EXTENDED_DATA_STDERR);
      header.uint32(length);
      const data = chunk.subarray(offset, offset + length);
      offset += length;
      await this.sink.send(header.finish(), data);
    }
  }

  private wakeWriters(): void {
    const waiters = this.windowWaiters;
    this.windowWaiters = [];
    for (const wake of waiters) wake();
  }
}
