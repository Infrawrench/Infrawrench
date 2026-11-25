/**
 * What the protocol needs from a repository. Storage implements it (the
 * worker's RepoDO over Durable Object SQLite and R2; `MemoryBackend` in
 * tests), and the protocol never knows which.
 *
 * The worker's implementation changes with this file in the same commit.
 */
import type { ObjectId, ObjectReader, Ref, RefUpdate } from "@infrawrench/git-core";
import type { OidSet } from "./oid-set";

export interface RefUpdateResult {
  readonly name: string;
  /** null when the update applied; otherwise the reason sent back as `ng <ref> <reason>`. */
  readonly error: string | null;
}

/**
 * A pack a push brought, stored and verified but not yet part of the
 * repository. Its objects are readable through `reader` only, until
 * `updateRefs` publishes it together with the refs that make them reachable.
 */
export interface IngestedPack {
  /** How many objects the pack holds. */
  readonly objectCount: number;
  /** Bytes stored. */
  readonly size: number;
  /** The repository's objects and this pack's. */
  readonly reader: ObjectReader;
}

export interface PackRequest {
  /** The objects to send. */
  readonly objects: OidSet;
  /**
   * Objects the client is known to have. A stored delta whose base is one
   * of these may be sent as it is (a thin pack). Null when the client did
   * not ask for `thin-pack`.
   */
  readonly thinBases: OidSet | null;
  /** The client understands `ofs-delta`. */
  readonly ofsDelta: boolean;
}

export interface RepositoryBackend extends ObjectReader {
  listRefs(): Promise<Ref[]>;
  /**
   * What `HEAD` names (`refs/heads/main`), whether or not that branch
   * exists yet. Null when HEAD is not a symbolic ref.
   */
  head(): Promise<string | null>;
  /**
   * Store an incoming pack (receive-pack). Must stream: a Durable Object has
   * 128 MB of memory and a pack can be far bigger. It reads `pack` only as
   * far as the pack's own trailer, since over SSH the stream stays open
   * after it. Resolves a thin pack's bases from the existing objects, and
   * refuses a pack in which an object names another that neither the pack
   * nor the repository has, so every stored object's history is complete.
   * Throws a `GitError` for a pack it refuses.
   */
  ingestPack(pack: ReadableStream<Uint8Array>): Promise<IngestedPack>;
  /**
   * Compare-and-swap each ref against its `oldOid`; all or nothing when
   * `atomic`. `pack` is published in the same step when at least one update
   * applies, and dropped otherwise.
   */
  updateRefs(
    updates: readonly RefUpdate[],
    options: { readonly atomic: boolean; readonly pack?: IngestedPack | null },
  ): Promise<RefUpdateResult[]>;
  /** Drop a pack that will not be published (the push was refused before any ref moved). */
  discardPack(pack: IngestedPack): Promise<void>;
  /**
   * Optional fast path for upload-pack: stream a pack of exactly these
   * objects, reusing stored (already compressed, possibly deltified) bytes.
   * The protocol falls back to building one from `read` when absent.
   */
  packObjects?(request: PackRequest): ReadableStream<Uint8Array>;
  /**
   * Optional fast path for a full clone: a pack of every object the
   * repository stores, without walking history. It may hold objects no
   * branch or tag reaches (a pull request's commits, what a forced push left
   * behind); the protocol only asks when the client wants every branch and
   * tag and has nothing. Null when the backend would rather be asked for the
   * objects by id.
   */
  packEverything?(options: {
    readonly ofsDelta: boolean;
  }): Promise<{ readonly stream: ReadableStream<Uint8Array>; readonly objectCount: number } | null>;
}

/** One ref change of a push, with what the protocol worked out about it. */
export interface ReceiveUpdate extends RefUpdate {
  readonly kind: "create" | "update" | "delete";
  /**
   * An update whose new commit does not descend from the old one. Always
   * false for a create or a delete.
   */
  readonly forced: boolean;
}

/** Policy the host applies around a push. The protocol calls it; it decides nothing itself. */
export interface ReceiveHooks {
  /** Before any ref moves: return a reason per refused update (protected branches, permissions). */
  check(
    updates: readonly ReceiveUpdate[],
    context: { readonly pushOptions: readonly string[] },
  ): Promise<Map<string, string>>;
  /** After refs moved. Fire-and-forget from the protocol's point of view. */
  after(applied: readonly ReceiveUpdate[]): Promise<void>;
}

export type GitServiceName = "git-upload-pack" | "git-receive-pack";

export interface ServeRequest {
  readonly service: GitServiceName;
  /** 0 or 1: the classic protocol; 2: protocol v2 (`Git-Protocol: version=2`). */
  readonly version: 0 | 1 | 2;
  /**
   * true for smart HTTP (each request is one round, refs advertised by a
   * separate GET); false for SSH, where one bidirectional stream carries the
   * whole conversation, advertisement included.
   */
  readonly statelessRpc: boolean;
  /** Smart HTTP's `GET info/refs`: only advertise, read no input. */
  readonly advertiseOnly: boolean;
}

/** Bounds on what a client may make the server do. Every one has a default. */
export interface ServeLimits {
  /** `want` lines in one request. Default 10 000. */
  readonly maxWants?: number;
  /** `have` lines in one request. Default 50 000. */
  readonly maxHaves?: number;
  /** Ref commands in one push. Default 10 000. */
  readonly maxRefUpdates?: number;
  /**
   * Commits looked at to decide whether the client's haves already cover
   * what it wants. Past it the server stops negotiating and sends a pack.
   * Default 20 000.
   */
  readonly maxNegotiationCommits?: number;
}
