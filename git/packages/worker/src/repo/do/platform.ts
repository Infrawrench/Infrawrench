/**
 * The parts of R2 and of Durable Object storage a repository uses, as
 * interfaces of their own. `R2Bucket` and `DurableObjectStorage` satisfy
 * them, and so do the in-memory stand-ins the tests run the same storage
 * code against in Node, where there is no workerd.
 */

export interface BucketObject {
  readonly size: number;
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface MultipartUpload {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: Uint8Array): Promise<UploadedPart>;
  abort(): Promise<void>;
  complete(parts: UploadedPart[]): Promise<unknown>;
}

export interface BucketListing {
  readonly objects: ReadonlyArray<{ readonly key: string; readonly size: number }>;
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface Bucket {
  get(
    key: string,
    options?: { readonly range?: { readonly offset: number; readonly length: number } },
  ): Promise<BucketObject | null>;
  put(key: string, value: Uint8Array | ReadableStream<Uint8Array>): Promise<unknown>;
  /** Up to 1000 keys a call. */
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<BucketListing>;
  createMultipartUpload(key: string): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

export type SqlValue = string | number | null | ArrayBuffer;

export interface SqlCursor<T> {
  toArray(): T[];
}

/** `ctx.storage.sql`: synchronous, one statement a call. */
export interface Sql {
  exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

export interface RepoStorage {
  readonly sql: Sql;
  /** Runs `fn` in a transaction: all of its writes land, or (when it throws) none. */
  transactionSync<T>(fn: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

/** Where a push is announced. The `EVENTS` queue in production. */
export interface EventSink<T> {
  send(event: T): Promise<unknown>;
}
