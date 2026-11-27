/**
 * Receiving a pack: the bytes go to R2 as they arrive, so a pack is never
 * held in memory. Over SSH the indexer reads them on the way, because the
 * stream stays open after the pack and only parsing finds its end. Over
 * HTTPS the request ends where the pack does (`IngestOptions.whole`), so the
 * pack is stored first, at the network's pace, and indexed from R2 after:
 * indexing is slower than an upload, and a client held back that long has
 * its connection dropped by Cloudflare's edge (about a minute in, for an
 * 88 MiB push). What comes out is a pack
 * in R2 with its `.idx` beside it, verified, and still outside the
 * repository: publishing it is `updateRefs`' job.
 */
import {
  GitError,
  type GitObject,
  type ObjectId,
  type ObjectReader,
  ObjectFsck,
  PackIndex,
  PackIndexer,
  memoryRangeReader,
  readPackObjectAt,
  writePackIndex,
} from "@infrawrench/git-core";
import { ConnectivityCheck } from "@infrawrench/git-protocol";
import {
  MAX_OBJECT_BYTES,
  PackHandle,
  type PackStore,
  idxKey,
  packKey,
  rangeFetcher,
} from "./pack-store";
import { bigReads } from "./big-reads";
import type { MultipartUpload, UploadedPart } from "./platform";

/**
 * R2 wants every part but the last to be the same size, at least 5 MiB. The
 * smallest allowed keeps the buffer small against a Durable Object's 128 MB
 * and still allows a 48 GiB pack in R2's 10 000 parts.
 */
export const PART_BYTES = 5 * 1024 * 1024;
/** A stored pack is read back to the indexer in pieces of this, not the runtime's 4 096 bytes. */
const REPLAY_PIECE_BYTES = 256 * 1024;

export interface IngestOptions {
  /** Objects already in the repository: thin-pack bases, and the other half of the connectivity check. */
  readonly existing: ObjectReader & { hasSync(oid: string): boolean };
  /** Refuse a pack larger than this. */
  readonly maxPackBytes: number;
  /** Refuse a pack with more objects than this. */
  readonly maxObjects: number;
  /**
   * Skip the check that every object's references resolve. Only for a pack
   * this server wrote from objects it already had (a repack).
   */
  readonly trusted?: boolean;
  /**
   * Refuse objects git's own `fsck` refuses on a push (`ObjectFsck`): tree
   * entries named `.`, `..` or `.git` in any spelling a file system reads as
   * one, a slash in a name, repeated or unsorted entries, hostile
   * `.gitmodules` and `.gitattributes`, malformed commits and tags. For a
   * push; objects the server makes or copies from another repository may
   * come from history older than the check and are left as they are.
   */
  readonly fsck?: boolean;
  /**
   * Most bytes the pack may inflate to and rebuild, all objects together:
   * a few MiB of tiny deltas each copying a large base is otherwise
   * terabytes of work. Unbounded when absent.
   */
  readonly maxInflatedBytes?: number;
  /**
   * `source` ends where the pack ends (a request over HTTPS), so it is
   * stored whole before it is indexed. Over SSH the stream stays open after
   * the pack, and only indexing finds where it ends.
   */
  readonly whole?: boolean;
  /** Called once every byte of the pack has been read from `source`. */
  readonly onReceived?: () => void;
}

/** Parts uploading at once while a whole pack is stored: 15 MiB in flight beside the one filling. */
const WHOLE_PART_CONCURRENCY = 3;

export interface Ingested {
  /** Null when the pack held no objects: nothing was stored. */
  readonly handle: PackHandle | null;
  readonly objectCount: number;
  readonly size: number;
  readonly idxSize: number;
  /**
   * The pack's objects that no other object of it names: what refs have to
   * point at for everything in it to be reachable. Null when that was not
   * worked out (a pack the server wrote itself) or there were too many to
   * keep.
   */
  readonly roots: readonly ObjectId[] | null;
}

/** Past this many roots a pack is treated as holding objects nothing reaches. */
const MAX_ROOTS = 1024;

export function newPackId(): string {
  // Sorts by time, so a listing of the bucket reads in the order packs arrived.
  const random = crypto.getRandomValues(new Uint8Array(8));
  const suffix = [...random].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36).padStart(9, "0")}-${suffix}`;
}

/**
 * Stores `source` as a new pack in state `incoming`. Reads no further than
 * the pack's trailer. On any failure nothing is left behind: the upload is
 * aborted, the files deleted and the row removed.
 */
export async function ingestPack(
  store: PackStore,
  source: ReadableStream<Uint8Array>,
  options: IngestOptions,
): Promise<Ingested> {
  const { bucket, sql, repoId } = store;
  const id = newPackId();
  const key = packKey(repoId, id);
  const now = Date.now();
  sql.exec(
    "INSERT INTO packs (id, state, created_at, state_at) VALUES (?, 'incoming', ?, ?)",
    id,
    now,
    now,
  );

  let upload: MultipartUpload | null = null;
  const parts: UploadedPart[] = [];
  const inflight = new Set<Promise<void>>();
  const concurrency = options.whole === true ? WHOLE_PART_CONCURRENCY : 1;
  let buffer = new Uint8Array(PART_BYTES);
  let filled = 0;
  let total = 0;
  /** The whole pack, when it turned out smaller than one part. */
  let memory: Uint8Array | null = null;
  let stored = false;

  let partCount = 0;
  /** The first part upload that failed: it fails the push at the next part or at the end. */
  let partFailure: { readonly error: unknown } | null = null;
  const flushPart = async (bytes: Uint8Array): Promise<void> => {
    if (partFailure) throw partFailure.error;
    if (!upload) {
      upload = await bucket.createMultipartUpload(key);
      sql.exec("UPDATE packs SET upload_id = ? WHERE id = ?", upload.uploadId, id);
    }
    const number = ++partCount;
    const sending: Promise<void> = (upload as MultipartUpload).uploadPart(number, bytes).then(
      (part) => {
        parts[number - 1] = part;
      },
      (error: unknown) => {
        partFailure ??= { error };
      },
    );
    const tracked: Promise<void> = sending.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
    if (inflight.size >= concurrency) await Promise.race([...inflight]);
    if (partFailure) throw (partFailure as { readonly error: unknown }).error;
  };
  const drain = async (): Promise<void> => {
    await Promise.all([...inflight]);
    if (partFailure) throw (partFailure as { readonly error: unknown }).error;
  };
  const append = async (chunk: Uint8Array): Promise<void> => {
    total += chunk.length;
    if (total > options.maxPackBytes) throw new GitError("limit", "pack is over the size limit");
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(chunk.length - at, PART_BYTES - filled);
      buffer.set(chunk.subarray(at, at + take), filled);
      filled += take;
      at += take;
      if (filled === PART_BYTES) {
        // The upload owns this buffer until it settles; the next part gets its own.
        const full = buffer;
        buffer = new Uint8Array(PART_BYTES);
        filled = 0;
        await flushPart(full);
      }
    }
  };

  const check = new ConnectivityCheck();
  const fsck = options.fsck && !options.trusted ? new ObjectFsck() : null;
  let range = (offset: number, length: number): Promise<Uint8Array> => {
    throw new Error(`pack read back before it was stored (${offset}+${length})`);
  };
  const indexer = new PackIndexer({
    bases: options.existing,
    readRange: (offset, length) => range(offset, length),
    // Half the defaults: the part buffer and the read caches share the same 128 MB.
    cacheBytes: 16 * 1024 * 1024,
    heldDeltaBytes: 4 * 1024 * 1024,
    hashQueueBytes: 4 * 1024 * 1024,
    maxObjects: options.maxObjects,
    ...(options.maxInflatedBytes !== undefined
      ? { maxInflatedBytes: options.maxInflatedBytes }
      : {}),
    ...(options.trusted
      ? {}
      : {
          onObject: (object, data) => {
            check.note(object.type, data);
            fsck?.note(object.oid, object.type, data);
          },
        }),
  });

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([...inflight]);
    const pending = upload as MultipartUpload | null;
    if (pending && !stored) await pending.abort().catch(() => undefined);
    await store.deleteFiles(id).catch(() => undefined);
    sql.exec("DELETE FROM packs WHERE id = ?", id);
    store.forget(id);
  };

  /** Stores what has been appended: one `put` when it fits a part, else the multipart upload. */
  const storeAppended = async (): Promise<void> => {
    if (upload === null) {
      memory = buffer.slice(0, filled);
      await bucket.put(key, memory);
      range = memoryRangeReader(memory);
    } else {
      if (filled > 0) await flushPart(buffer.subarray(0, filled));
      await drain();
      await (upload as MultipartUpload).complete(parts);
    }
    stored = true;
    // Free the part buffer before the indexer needs the room.
    buffer = new Uint8Array(0);
    if (memory === null) range = rangeFetcher(bucket, key, total);
  };

  try {
    if (options.whole === true) {
      // Everything the client sends, to R2 at the network's pace, then indexed from there.
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await append(value);
        }
      } finally {
        reader.releaseLock();
      }
      await storeAppended();
      options.onReceived?.();
      const saved =
        memory !== null
          ? new Blob([memory as Uint8Array<ArrayBuffer>]).stream()
          : (await bucket.get(key))?.body;
      if (!saved) throw new Error(`${key} is missing from storage`);
      const replay = bigReads(saved, { bytes: REPLAY_PIECE_BYTES }).getReader();
      try {
        while (!indexer.done) {
          const { done, value } = await replay.read();
          if (done) break;
          if (indexer.write(value) > 0) {
            throw new GitError("bad-pack", "data after the end of the pack");
          }
          await indexer.settle();
        }
        if (indexer.done && !(await replay.read()).done) {
          throw new GitError("bad-pack", "data after the end of the pack");
        }
      } finally {
        await replay.cancel().catch(() => undefined);
        replay.releaseLock();
      }
      if (!indexer.done) throw new GitError("bad-pack", "pack is cut short");
    } else {
      const reader = source.getReader();
      try {
        while (!indexer.done) {
          const { done, value } = await reader.read();
          if (done) break;
          const extra = indexer.write(value);
          await append(extra > 0 ? value.subarray(0, value.length - extra) : value);
          await indexer.settle();
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!indexer.done) throw new GitError("bad-pack", "pack is cut short");
      await storeAppended();
      options.onReceived?.();
    }

    const result = await indexer.finish();
    if (result.objectCount === 0) {
      await cleanup();
      return { handle: null, objectCount: 0, size: total, idxSize: 0, roots: [] };
    }
    const idx = writePackIndex(result.objects, result.checksum);
    const index = new PackIndex(idx);
    let roots: ObjectId[] | null = null;
    if (!options.trusted) {
      const missing = await check.firstMissing(
        (oid) => index.has(oid),
        (oid) => options.existing.hasSync(oid),
      );
      if (missing) throw new GitError("missing-object", `missing necessary object ${missing}`);
      if (fsck) {
        // The `.gitmodules` and `.gitattributes` blobs that did not pass by with their tree.
        const readBack = async (oid: ObjectId): Promise<GitObject | null> => {
          const record = index.lookup(oid);
          if (!record) return options.existing.read(oid);
          return readPackObjectAt(range, record.offset, {
            maxSize: MAX_OBJECT_BYTES,
            resolveBase: readBack,
          });
        };
        await fsck.finish(async (oid) => (await readBack(oid))?.data ?? null);
      }
      roots = [];
      for (let position = 0; position < index.count && roots !== null; position++) {
        const oid = index.oidAt(position);
        if (check.needs(oid)) continue;
        if (roots.length >= MAX_ROOTS) roots = null;
        else roots.push(oid);
      }
    }
    await bucket.put(idxKey(repoId, id), idx);
    const selfContained = result.externalBases.length === 0;
    sql.exec(
      "UPDATE packs SET checksum = ?, size = ?, idx_size = ?, objects = ?, self_contained = ?, upload_id = NULL WHERE id = ?",
      result.checksum,
      total,
      idx.length,
      result.objectCount,
      selfContained ? 1 : 0,
      id,
    );
    const handle = store.handle(id, total, selfContained, index, memory);
    store.adopt(handle);
    return { handle, objectCount: result.objectCount, size: total, idxSize: idx.length, roots };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
