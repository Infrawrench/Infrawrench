/**
 * R2 and Durable Object storage for Node: a bucket in a Map that enforces
 * the rules R2 enforces, and SQLite from `node:sqlite`. The repository's
 * storage code runs on these unchanged, so its tests need no workerd.
 */
import { DatabaseSync } from "node:sqlite";
import type {
  Bucket,
  BucketListing,
  BucketObject,
  MultipartUpload,
  RepoStorage,
  SqlValue,
  UploadedPart,
} from "../../src/repo/do/platform";

const MIN_PART_BYTES = 5 * 1024 * 1024;

export class MemoryBucket implements Bucket {
  readonly objects = new Map<string, Uint8Array>();
  /** Uploads begun and neither completed nor aborted. */
  readonly openUploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  /** Counts by operation, for tests that care how storage was used. */
  readonly calls = { get: 0, rangeGet: 0, put: 0, delete: 0, uploadPart: 0 };
  private nextUpload = 1;

  async get(
    key: string,
    options?: { readonly range?: { readonly offset: number; readonly length: number } },
  ): Promise<BucketObject | null> {
    const whole = this.objects.get(key);
    if (!whole) return null;
    if (options?.range) this.calls.rangeGet++;
    else this.calls.get++;
    const bytes = options?.range
      ? whole.subarray(options.range.offset, options.range.offset + options.range.length)
      : whole;
    return {
      size: whole.length,
      get body(): ReadableStream<Uint8Array> {
        let at = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (at >= bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.slice(at, at + 65536));
            at += 65536;
          },
        });
      },
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }

  async put(key: string, value: Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    this.calls.put++;
    if (value instanceof Uint8Array) {
      this.objects.set(key, value.slice());
      return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = value.getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.objects.set(key, out);
  }

  async delete(keys: string | string[]): Promise<void> {
    this.calls.delete++;
    const list = typeof keys === "string" ? [keys] : keys;
    if (list.length > 1000) throw new Error("R2 deletes at most 1000 keys a call");
    for (const key of list) this.objects.delete(key);
  }

  async list(options: { prefix: string; cursor?: string; limit?: number }): Promise<BucketListing> {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = Math.min(options.limit ?? 1000, 1000);
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.length })),
      truncated,
      ...(truncated ? { cursor: String(start + limit) } : {}),
    };
  }

  private upload(key: string, uploadId: string): MultipartUpload {
    return {
      uploadId,
      uploadPart: async (partNumber, value): Promise<UploadedPart> => {
        this.calls.uploadPart++;
        const open = this.openUploads.get(uploadId);
        if (!open) throw new Error("no such upload");
        open.parts.set(partNumber, value.slice());
        return { partNumber, etag: `etag-${partNumber}` };
      },
      abort: async () => {
        this.openUploads.delete(uploadId);
      },
      complete: async (parts) => {
        const open = this.openUploads.get(uploadId);
        if (!open) throw new Error("no such upload");
        const bytes = parts.map((part) => open.parts.get(part.partNumber)!);
        // R2's rule: every part but the last is the same size, and at least 5 MiB.
        for (let i = 0; i < bytes.length - 1; i++) {
          if (bytes[i]!.length < MIN_PART_BYTES || bytes[i]!.length !== bytes[0]!.length) {
            throw new Error("all parts except the last must be the same size, at least 5 MiB");
          }
        }
        let total = 0;
        for (const part of bytes) total += part.length;
        const out = new Uint8Array(total);
        let at = 0;
        for (const part of bytes) {
          out.set(part, at);
          at += part.length;
        }
        this.objects.set(key, out);
        this.openUploads.delete(uploadId);
      },
    };
  }

  async createMultipartUpload(key: string): Promise<MultipartUpload> {
    const uploadId = `upload-${this.nextUpload++}`;
    this.openUploads.set(uploadId, { key, parts: new Map() });
    return this.upload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload {
    return this.upload(key, uploadId);
  }
}

export interface NodeStorage extends RepoStorage {
  /** The alarm as last set, or null. */
  alarm: number | null;
  /** Statements that wrote, for tests that count billed writes. */
  writes: number;
}

export function nodeStorage(): NodeStorage {
  let database = new DatabaseSync(":memory:");
  const storage: NodeStorage = {
    alarm: null,
    writes: 0,
    sql: {
      exec<T>(query: string, ...bindings: SqlValue[]) {
        const statement = database.prepare(query);
        const reads = /^\s*(SELECT|WITH)/i.test(query);
        let rows: T[] = [];
        if (reads) {
          rows = statement.all(...(bindings as never[])) as T[];
        } else {
          statement.run(...(bindings as never[]));
          storage.writes++;
        }
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      database.exec("BEGIN");
      try {
        const result = fn();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    getAlarm: async () => storage.alarm,
    setAlarm: async (at) => {
      storage.alarm = at;
    },
    deleteAlarm: async () => {
      storage.alarm = null;
    },
    deleteAll: async () => {
      database.close();
      database = new DatabaseSync(":memory:");
    },
  };
  return storage;
}
