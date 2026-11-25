/**
 * What the protocol needs from a repository. Storage implements it (the
 * worker's RepoDO over Durable Object SQLite and R2; an in-memory one in
 * tests), and the protocol never knows which.
 *
 * DRAFT: the protocol agent owns this file and may change it; keep the
 * worker's implementation in step in the same change.
 */
import type { ObjectId, ObjectReader, Ref, RefUpdate } from "@infrawrench/git-core";

export interface RefUpdateResult {
  readonly name: string;
  /** null when the update applied; otherwise the reason sent back as `ng <ref> <reason>`. */
  readonly error: string | null;
}

export interface IngestResult {
  /** How many objects the pack added. */
  readonly objectCount: number;
  /** Bytes stored. */
  readonly size: number;
}

export interface RepositoryBackend extends ObjectReader {
  listRefs(): Promise<Ref[]>;
  /**
   * Store an incoming pack (receive-pack). Must stream: a Durable Object has
   * 128 MB of memory and a pack can be far bigger. Resolves a thin pack's
   * bases from the existing objects. Objects become readable only once the
   * whole pack has been verified.
   */
  ingestPack(pack: ReadableStream<Uint8Array>): Promise<IngestResult>;
  /** Compare-and-swap each ref against its `oldOid`; all or nothing when `atomic`. */
  updateRefs(
    updates: readonly RefUpdate[],
    options: { atomic: boolean },
  ): Promise<RefUpdateResult[]>;
  /**
   * Optional fast path for upload-pack: stream a pack of exactly these
   * objects, reusing stored (already compressed, possibly deltified) bytes.
   * The protocol falls back to building one from `read` when absent.
   */
  packObjects?(oids: readonly ObjectId[]): ReadableStream<Uint8Array>;
}

/** Policy the host applies around a push. The protocol calls it; it decides nothing itself. */
export interface ReceiveHooks {
  /** Before any ref moves: return a reason per refused update (protected branches, permissions). */
  check(updates: readonly RefUpdate[]): Promise<Map<string, string>>;
  /** After refs moved. Fire-and-forget from the protocol's point of view. */
  after(applied: readonly RefUpdate[]): Promise<void>;
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
