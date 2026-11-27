/** What upload-pack and receive-pack share: the request context, errors, ref listing. */
import {
  type ObjectId,
  type PktLineReader,
  type Ref,
  compareRefNames,
  decodeText,
  isObjectId,
  peelRef,
} from "@infrawrench/git-core";
import type { ReceiveHooks, RepositoryBackend, ServeLimits, ServeRequest } from "./backend";

export const DEFAULT_AGENT = "infrawrench";

/**
 * Something the client did that ends the conversation. The message is sent
 * to the client (`ERR <message>`), so it only ever describes the request.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Counters a transport may log or meter. Filled in as the conversation goes. */
export interface ServeStats {
  /** Objects sent in a pack. */
  objectsSent: number;
  /** Bytes of pack sent. */
  packBytesSent: number;
  /** Objects received in a pack. */
  objectsReceived: number;
  packBytesReceived: number;
  /** Refs a push changed. */
  refsUpdated: number;
  /** How the pack was made: `everything`, `objects` (stored bytes reused) or `rebuilt`. */
  packSource: "everything" | "objects" | "rebuilt" | null;
  /** Milliseconds spent choosing a fetch's objects, before its pack's first byte. */
  selectMillis: number;
  /** Milliseconds from a fetch's pack's first byte to its last, the client's pace included. */
  packMillis: number;
}

export interface Context {
  readonly backend: RepositoryBackend;
  readonly request: ServeRequest;
  readonly reader: PktLineReader;
  readonly hooks: ReceiveHooks | null;
  readonly limits: Required<ServeLimits>;
  readonly agent: string;
  readonly stats: ServeStats;
  /**
   * How a failure is reported from here on: 0 for an `ERR` packet, otherwise
   * the side-band packet limit, once a response has switched to side-band.
   */
  errorBand: number;
  /** What is left of `limits.maxConversationCommits`. */
  negotiationLeft: number;
}

export const DEFAULT_LIMITS: Required<ServeLimits> = {
  maxWants: 10_000,
  maxHaves: 50_000,
  maxRefUpdates: 10_000,
  maxNegotiationCommits: 20_000,
  maxConversationCommits: 200_000,
  maxShallows: 50_000,
  maxDeepenNots: 100,
  maxRefPrefixes: 1_000,
  maxArgumentBytes: 8 * 1024 * 1024,
  maxCommands: 1_000,
  maxPushOptions: 1_000,
  keepAliveMs: 5_000,
};

export interface RefListing {
  /** Every ref, sorted by name, tags peeled. */
  readonly refs: Ref[];
  /** What HEAD names, when it is symbolic. */
  readonly head: string | null;
  /** The commit HEAD resolves to, when its branch exists. */
  readonly headOid: ObjectId | null;
}

export async function listRefs(backend: RepositoryBackend): Promise<RefListing> {
  const [stored, head] = await Promise.all([backend.listRefs(), backend.head()]);
  const refs: Ref[] = [];
  for (const ref of stored) {
    // A backend that knows the peeled id says so; otherwise only tags can need peeling.
    refs.push(
      ref.peeled === undefined && ref.name.startsWith("refs/tags/")
        ? await peelRef(backend, ref)
        : ref,
    );
  }
  refs.sort((a, b) => compareRefNames(a.name, b.name));
  const headOid = head === null ? null : (refs.find((ref) => ref.name === head)?.oid ?? null);
  return { refs, head, headOid };
}

/** A packet's text without its trailing newline. */
export function lineOf(data: Uint8Array): string {
  const text = decodeText(data);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

export function parseOid(text: string, what: string): ObjectId {
  if (!isObjectId(text))
    throw new ProtocolError(`protocol error: expected an object id in ${what}`);
  return text;
}

/** The capability words after a NUL or a space, as a set, with `key=value` kept whole. */
export function parseCapabilities(text: string): Set<string> {
  return new Set(text.split(" ").filter((word) => word !== ""));
}
