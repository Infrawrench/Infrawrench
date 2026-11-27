/** The entry point: one conversation of one service, input stream in, output stream out. */
import {
  type ByteSource,
  GitError,
  PktLineReader,
  SIDE_BAND_ERROR,
  concatBytes,
  encodePktLine,
  encodeSideBand,
  streamFrom,
} from "@infrawrench/git-core";
import type { ReceiveHooks, RepositoryBackend, ServeLimits, ServeRequest } from "./backend";
import {
  type Context,
  DEFAULT_AGENT,
  DEFAULT_LIMITS,
  ProtocolError,
  type ServeStats,
} from "./common";
import { receivePack } from "./receive-pack";
import { uploadPackV0, uploadPackV2 } from "./upload-pack";

export interface ServeOptions {
  readonly backend: RepositoryBackend;
  readonly request: ServeRequest;
  /** What the client sends. Ignored when the request only advertises. */
  readonly input: ByteSource;
  /** Push policy. Without it every well-formed push is accepted. */
  readonly hooks?: ReceiveHooks;
  readonly limits?: ServeLimits;
  /** The `agent=` capability. Default `infrawrench`. */
  readonly agent?: string;
  /** Filled in as the conversation goes; read it once the output has ended. */
  readonly stats?: ServeStats;
  /** A failure that was not the client's doing. The client is told "internal error". */
  readonly onError?: (error: unknown) => void;
  /** The conversation is over, however it ended: `stats` is as final as it gets. */
  readonly onEnd?: () => void;
}

export function newServeStats(): ServeStats {
  return {
    objectsSent: 0,
    packBytesSent: 0,
    objectsReceived: 0,
    packBytesReceived: 0,
    refsUpdated: 0,
    packSource: null,
    selectMillis: 0,
    packMillis: 0,
  };
}

/**
 * Runs the conversation. The returned stream is everything the server says;
 * it produces as it is read, so a slow client slows the work down rather
 * than filling memory.
 *
 * A request the protocol refuses ends with an `ERR` packet (or a side-band
 * error once a pack is under way) and a clean end of stream, never a stream
 * error: the transport has already sent its 200.
 */
export function serve(options: ServeOptions): ReadableStream<Uint8Array> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const ctx: Context = {
    backend: options.backend,
    request: options.request,
    reader: new PktLineReader(options.request.advertiseOnly ? [] : options.input),
    hooks: options.hooks ?? null,
    limits,
    agent: options.agent ?? DEFAULT_AGENT,
    stats: options.stats ?? newServeStats(),
    errorBand: 0,
    negotiationLeft: limits.maxConversationCommits,
  };
  async function* run(): AsyncGenerator<Uint8Array, void, void> {
    try {
      if (ctx.request.service === "git-receive-pack") yield* receivePack(ctx);
      else if (ctx.request.version === 2) yield* uploadPackV2(ctx);
      else yield* uploadPackV0(ctx);
    } catch (error) {
      const expected = error instanceof ProtocolError || error instanceof GitError;
      if (!expected) options.onError?.(error);
      const message = expected ? (error as Error).message : "internal error";
      yield ctx.errorBand === 0
        ? encodePktLine(`ERR ${message}\n`)
        : concatBytes(encodeSideBand(SIDE_BAND_ERROR, `${message}\n`, ctx.errorBand));
    } finally {
      await ctx.reader.cancel().catch(() => undefined);
      try {
        options.onEnd?.();
      } catch {
        // A host's bookkeeping never changes how a conversation ends.
      }
    }
  }
  return streamFrom(run());
}
