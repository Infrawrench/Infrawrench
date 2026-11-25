/**
 * Receiving a pack: the bytes go to R2 as they arrive while the indexer
 * reads them, so a pack is never held in memory. What comes out is a pack
 * in R2 with its `.idx` beside it, verified, and still outside the
 * repository: publishing it is `updateRefs`' job.
 */
import {
  GitError,
  type ObjectReader,
  PackIndex,
  PackIndexer,
  memoryRangeReader,
  writePackIndex,
} from "@infrawrench/git-core";
import { ConnectivityCheck } from "@infrawrench/git-protocol";
import { PackHandle, type PackStore, idxKey, packKey, rangeFetcher } from "./pack-store";
import type { MultipartUpload, UploadedPart } from "./platform";

/**
 * R2 wants every part but the last to be the same size, at least 5 MiB. The
 * smallest allowed keeps the buffer small against a Durable Object's 128 MB
 * and still allows a 48 GiB pack in R2's 10 000 parts.
 */
export const PART_BYTES = 5 * 1024 * 1024;

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
}

export interface Ingested {
  /** Null when the pack held no objects: nothing was stored. */
  readonly handle: PackHandle | null;
  readonly objectCount: number;
  readonly size: number;
  readonly idxSize: number;
}

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
  let buffer = new Uint8Array(PART_BYTES);
  let filled = 0;
  let total = 0;
  /** The whole pack, when it turned out smaller than one part. */
  let memory: Uint8Array | null = null;
  let stored = false;

  const flushPart = async (bytes: Uint8Array): Promise<void> => {
    if (!upload) {
      upload = await bucket.createMultipartUpload(key);
      sql.exec("UPDATE packs SET upload_id = ? WHERE id = ?", upload.uploadId, id);
    }
    parts.push(await upload.uploadPart(parts.length + 1, bytes));
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
    ...(options.trusted ? {} : { onObject: (object, data) => check.note(object.type, data) }),
  });

  const cleanup = async (): Promise<void> => {
    const pending = upload as MultipartUpload | null;
    if (pending && !stored) await pending.abort().catch(() => undefined);
    await store.deleteFiles(id).catch(() => undefined);
    sql.exec("DELETE FROM packs WHERE id = ?", id);
    store.forget(id);
  };

  try {
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

    if (upload === null) {
      memory = buffer.slice(0, filled);
      await bucket.put(key, memory);
      range = memoryRangeReader(memory);
    } else {
      if (filled > 0) await flushPart(buffer.subarray(0, filled));
      await (upload as MultipartUpload).complete(parts);
    }
    stored = true;
    // Free the part buffer before the indexer's second pass needs the room.
    buffer = new Uint8Array(0);

    if (memory === null) range = rangeFetcher(bucket, key, total);
    const result = await indexer.finish();
    if (result.objectCount === 0) {
      await cleanup();
      return { handle: null, objectCount: 0, size: total, idxSize: 0 };
    }
    const idx = writePackIndex(result.objects, result.checksum);
    const index = new PackIndex(idx);
    if (!options.trusted) {
      const missing = await check.firstMissing(
        (oid) => index.has(oid),
        (oid) => options.existing.hasSync(oid),
      );
      if (missing) throw new GitError("missing-object", `missing necessary object ${missing}`);
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
    const handle = new PackHandle(id, key, total, selfContained, index, bucket, memory);
    store.adopt(handle);
    return { handle, objectCount: result.objectCount, size: total, idxSize: idx.length };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
