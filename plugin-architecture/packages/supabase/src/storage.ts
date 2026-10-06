import type { StorageObject } from "@infrawrench/plugin-base";
import type { SupabaseContext } from "./api.js";
import { enc, parseResponse, projectUrl, rawRequest } from "./api.js";
import type { SbStorageBucket, SbStorageObject } from "./types.js";

/**
 * Supabase Storage API (`https://{ref}.supabase.co/storage/v1`), the
 * project-level service behind buckets and objects. The Management API only
 * lists buckets, so creating, editing, emptying and browsing go here, signed
 * with one of the project's secret API keys.
 *
 * New `sb_secret_…` keys go in the `apikey` header only (the gateway mints the
 * service-role JWT itself; they are not JWTs and must not be sent as a Bearer
 * token). A legacy `service_role` key is a JWT and is sent in both headers.
 */
function storageHeaders(key: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key, Accept: "application/json" };
  if (key.startsWith("eyJ")) headers["Authorization"] = `Bearer ${key}`;
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

async function storageFetch<T>(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await rawRequest(ctx, {
    method,
    url: `${projectUrl(ref)}/storage/v1${path}`,
    headers: storageHeaders(key, body !== undefined ? "application/json" : undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return parseResponse<T>(res, `storage${path}`);
}

export async function listStorageBuckets(
  ctx: SupabaseContext,
  ref: string,
  key: string,
): Promise<SbStorageBucket[]> {
  return (await storageFetch<SbStorageBucket[]>(ctx, ref, key, "GET", "/bucket")) ?? [];
}

export interface BucketInput {
  public?: boolean;
  fileSizeLimit?: number | null;
  allowedMimeTypes?: string[] | null;
}

export async function createBucket(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  name: string,
  input: BucketInput,
): Promise<void> {
  await storageFetch(ctx, ref, key, "POST", "/bucket", {
    id: name,
    name,
    public: input.public ?? false,
    ...(input.fileSizeLimit != null ? { file_size_limit: input.fileSizeLimit } : {}),
    ...(input.allowedMimeTypes?.length ? { allowed_mime_types: input.allowedMimeTypes } : {}),
  });
}

export async function getBucket(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  id: string,
): Promise<SbStorageBucket> {
  return storageFetch<SbStorageBucket>(ctx, ref, key, "GET", `/bucket/${enc(id)}`);
}

export async function updateBucket(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  id: string,
  input: BucketInput,
): Promise<void> {
  // PUT replaces the bucket's options, so unchanged values are carried over.
  const current = await getBucket(ctx, ref, key, id);
  await storageFetch(ctx, ref, key, "PUT", `/bucket/${enc(id)}`, {
    id,
    name: current.name,
    public: input.public ?? current.public,
    file_size_limit:
      input.fileSizeLimit !== undefined ? input.fileSizeLimit : (current.file_size_limit ?? null),
    allowed_mime_types:
      input.allowedMimeTypes !== undefined
        ? input.allowedMimeTypes
        : (current.allowed_mime_types ?? null),
  });
}

/** Buckets must be empty before Supabase lets them go. */
export async function deleteBucket(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  id: string,
): Promise<void> {
  await storageFetch(ctx, ref, key, "POST", `/bucket/${enc(id)}/empty`, {});
  await storageFetch(ctx, ref, key, "DELETE", `/bucket/${enc(id)}`);
}

export async function emptyBucket(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  id: string,
): Promise<void> {
  await storageFetch(ctx, ref, key, "POST", `/bucket/${enc(id)}/empty`, {});
}

const PAGE = 1000;

async function listObjectsPage(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  bucket: string,
  prefix: string,
  offset: number,
): Promise<SbStorageObject[]> {
  return (
    (await storageFetch<SbStorageObject[]>(ctx, ref, key, "POST", `/object/list/${enc(bucket)}`, {
      prefix,
      limit: PAGE,
      offset,
      sortBy: { column: "name", order: "asc" },
    })) ?? []
  );
}

/** One directory level, the shape the host's file browser expects. */
export async function listObjects(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const folder = prefix.replace(/\/+$/, "");
  const out: StorageObject[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const batch = await listObjectsPage(ctx, ref, key, bucket, folder, offset);
    for (const item of batch) {
      // Supabase writes this zero-byte file to make empty folders visible.
      if (item.name === ".emptyFolderPlaceholder") continue;
      const fullKey = folder ? `${folder}/${item.name}` : item.name;
      const isDirectory = item.id === null;
      out.push({
        key: isDirectory ? `${fullKey}/` : fullKey,
        name: item.name,
        size: isDirectory ? 0 : Number(item.metadata?.size ?? 0),
        lastModified: item.updated_at ?? item.created_at ?? "",
        isDirectory,
        ...(item.metadata?.mimetype ? { contentType: item.metadata.mimetype } : {}),
      });
    }
    if (batch.length < PAGE) return out;
  }
}

/** Every object key under a prefix, recursively (for deleting a folder). */
async function listKeysRecursive(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  bucket: string,
  folder: string,
): Promise<string[]> {
  const keys: string[] = [];
  for (const entry of await listObjects(ctx, ref, key, bucket, folder)) {
    if (entry.isDirectory) {
      keys.push(...(await listKeysRecursive(ctx, ref, key, bucket, entry.key.replace(/\/$/, ""))));
    } else {
      keys.push(entry.key);
    }
  }
  const placeholder = folder ? `${folder}/.emptyFolderPlaceholder` : "";
  if (placeholder) keys.push(placeholder);
  return keys;
}

export async function deleteObject(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  bucket: string,
  objectKey: string,
): Promise<void> {
  const keys = objectKey.endsWith("/")
    ? await listKeysRecursive(ctx, ref, key, bucket, objectKey.replace(/\/+$/, ""))
    : [objectKey];
  for (let i = 0; i < keys.length; i += PAGE) {
    await storageFetch(ctx, ref, key, "DELETE", `/object/${enc(bucket)}`, {
      prefixes: keys.slice(i, i + PAGE),
    });
  }
}

export async function uploadObject(
  ctx: SupabaseContext,
  ref: string,
  key: string,
  bucket: string,
  objectKey: string,
  data: Uint8Array,
  contentType: string,
): Promise<void> {
  const path = objectKey.split("/").map(enc).join("/");
  const res = await rawRequest(ctx, {
    method: "POST",
    url: `${projectUrl(ref)}/storage/v1/object/${enc(bucket)}/${path}`,
    headers: {
      ...storageHeaders(key, contentType || "application/octet-stream"),
      "x-upsert": "true",
    },
    body: data,
  });
  parseResponse(res, `storage/object/${bucket}`);
}

/** `{ref}/{bucket}`, the name the storage browser is handed. */
export function parseBucketHandle(handle: string): { ref: string; bucket: string } {
  const slash = handle.indexOf("/");
  if (slash <= 0) throw new Error(`Supabase plugin: bad bucket handle "${handle}".`);
  return { ref: handle.slice(0, slash), bucket: handle.slice(slash + 1) };
}
