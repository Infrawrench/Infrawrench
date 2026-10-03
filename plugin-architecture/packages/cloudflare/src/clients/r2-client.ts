import type { ResourceInstance, StorageObject } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord } from "./shared.js";
import type { BucketCreateParams } from "cloudflare/resources/r2/buckets/buckets";

/**
 * R2 bucket CRUD uses the official SDK (`cf.r2.buckets.*`). The R2 *object*
 * plane (list/upload/delete per-object) is not exposed by the SDK so those
 * operations remain on `api.fetch`. See task spec for details.
 */

/**
 * The complete set of location hints the R2 API accepts
 * (`BucketCreateParams.locationHint`). Anything else is rejected by Cloudflare,
 * so an unrecognised hint is dropped rather than forwarded: omitting the hint
 * means "let R2 choose", which is the create form's "Automatic" option.
 */
const R2_LOCATION_HINTS = [
  "apac",
  "eeur",
  "enam",
  "weur",
  "wnam",
  "oc",
] as const satisfies readonly NonNullable<BucketCreateParams["locationHint"]>[];
type R2LocationHint = (typeof R2_LOCATION_HINTS)[number];

/**
 * Default storage classes for new objects (`BucketCreateParams.storageClass`,
 * and the `cf-r2-storage-class` header the PATCH endpoint reads). Infrequent
 * Access trades a lower storage price for per-GB retrieval fees and a 30-day
 * minimum storage duration.
 */
const R2_STORAGE_CLASSES = ["Standard", "InfrequentAccess"] as const satisfies readonly NonNullable<
  BucketCreateParams["storageClass"]
>[];
type R2StorageClass = (typeof R2_STORAGE_CLASSES)[number];

function isR2StorageClass(value: string): value is R2StorageClass {
  return (R2_STORAGE_CLASSES as readonly string[]).includes(value);
}

function isR2LocationHint(value: string): value is R2LocationHint {
  return (R2_LOCATION_HINTS as readonly string[]).includes(value);
}

function mapR2Bucket(
  b: Record<string, unknown>,
  accountId: string,
  cfAccountId: string,
): ResourceInstance {
  const name = String(b["name"] ?? "");
  return {
    id: `${accountId}:r2-bucket:${name}`,
    pluginId: "cloudflare",
    resourceTypeId: "r2-bucket",
    accountId,
    displayName: name,
    fields: {
      name,
      location: String(b["location"] ?? ""),
      storageClass: String(b["storage_class"] ?? "Standard"),
      jurisdiction: String(b["jurisdiction"] ?? "default"),
      createdOn: String(b["creation_date"] ?? b["created"] ?? ""),
    },
    resolvedOutputs: {
      bucketName: name,
      s3Endpoint: `https://${cfAccountId}.r2.cloudflarestorage.com`,
    },
    secretStates: [],
    externalId: name,
    createdAt: String(b["creation_date"] ?? b["created"] ?? new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

export async function listR2Buckets(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const response = await api.cf.r2.buckets.list({ account_id });
  return (response.buckets ?? []).map((b) => mapR2Bucket(asRecord(b), accountId, account_id));
}

export async function getR2Bucket(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const bucket = await api.cf.r2.buckets.get(externalId, { account_id });
  return mapR2Bucket(asRecord(bucket), accountId, account_id);
}

export async function createR2Bucket(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const locationHint = fields["locationHint"] ?? "";
  const storageClass = fields["storageClass"] ?? "";
  const params: BucketCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    ...(isR2LocationHint(locationHint) ? { locationHint } : {}),
    ...(isR2StorageClass(storageClass) ? { storageClass } : {}),
  };
  const bucket = await api.cf.r2.buckets.create(params);
  return mapR2Bucket(asRecord(bucket), accountId, account_id);
}

/**
 * Change a bucket's default storage class (`PATCH /r2/buckets/{name}` with the
 * `cf-r2-storage-class` header, which the SDK sets from `storage_class`). Only
 * new uploads pick up the class; existing objects keep theirs.
 */
export async function editR2Bucket(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const storageClass = fields["storageClass"] ?? "";
  if (!isR2StorageClass(storageClass)) {
    throw new Error(`Unknown R2 storage class "${storageClass}".`);
  }
  const bucket = await api.cf.r2.buckets.edit(externalId, {
    account_id,
    storage_class: storageClass,
  });
  return mapR2Bucket(asRecord(bucket), accountId, account_id);
}

/**
 * The bucket's public r2.dev development URL
 * (`GET /r2/buckets/{name}/domains/managed`). `domain` is filled in whether or
 * not public access is on; `enabled` says whether it actually serves.
 */
export async function getR2DevDomain(
  api: CloudflareApi,
  bucketName: string,
  jurisdiction = "",
): Promise<{ domain: string; enabled: boolean }> {
  const account_id = await api.getAccountId();
  const res = asRecord(
    await api.cf.r2.buckets.domains.managed.list(bucketName, {
      account_id,
      ...jurisdictionParam(jurisdiction),
    }),
  );
  return { domain: String(res["domain"] ?? ""), enabled: Boolean(res["enabled"]) };
}

/** Turn public r2.dev access on or off (`PUT /r2/buckets/{name}/domains/managed`). */
export async function setR2DevDomain(
  api: CloudflareApi,
  bucketName: string,
  enabled: boolean,
  jurisdiction = "",
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.r2.buckets.domains.managed.update(bucketName, {
    account_id,
    enabled,
    ...jurisdictionParam(jurisdiction),
  });
}

/**
 * Buckets created in a data-location jurisdiction are only addressable with
 * the matching `cf-r2-jurisdiction` header; the default jurisdiction needs none.
 */
function jurisdictionParam(jurisdiction: string): { jurisdiction?: "eu" | "fedramp" } {
  return jurisdiction === "eu" || jurisdiction === "fedramp" ? { jurisdiction } : {};
}

export async function deleteR2Bucket(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.r2.buckets.delete(externalId, { account_id });
}

// --- R2 object plane (intentionally left on raw fetch: SDK has no coverage) ---

export async function listR2StorageObjects(
  api: CloudflareApi,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const cfAccountId = await api.getAccountId();
  const params = new URLSearchParams({ prefix, delimiter: "/" });
  // The list-objects endpoint puts objects in the envelope's `result` array
  // (not a nested `objects` field) and common prefixes in
  // `result_info.delimited`. `api.fetch` only returns `result`, so go through
  // raw fetch to access `result_info`.
  const path = `/accounts/${cfAccountId}/r2/buckets/${bucket}/objects?${params.toString()}`;
  const res = await fetch(`${api.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${api.apiToken}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Cloudflare API error ${res.status} for ${path}: ${await res.text()}`);
  }
  const envelope = (await res.json()) as {
    success: boolean;
    result?: Array<Record<string, unknown>>;
    result_info?: { delimited?: string[] };
    errors?: Array<{ message: string }>;
  };
  if (!envelope.success) {
    const msgs = envelope.errors?.map((e) => e.message).join(", ") ?? "unknown error";
    throw new Error(`Cloudflare API error for ${path}: ${msgs}`);
  }

  const objects: StorageObject[] = [];

  // Directories (common prefixes)
  for (const p of envelope.result_info?.delimited ?? []) {
    const name = p.endsWith("/") ? p.slice(prefix.length, -1) : p.slice(prefix.length);
    objects.push({
      key: p,
      name: name || p,
      size: 0,
      lastModified: "",
      isDirectory: true,
    });
  }

  // Files
  for (const item of envelope.result ?? []) {
    const key = String(item["key"] ?? "");
    if (key === prefix) continue; // skip the prefix itself
    const name = key.slice(prefix.length);
    if (!name) continue;
    const httpMeta = item["http_metadata"] as { contentType?: string } | undefined;
    objects.push({
      key,
      name,
      size: Number(item["size"] ?? 0),
      lastModified: String(item["last_modified"] ?? ""),
      isDirectory: false,
      contentType: String(httpMeta?.contentType ?? ""),
    });
  }

  return objects;
}

export async function deleteR2StorageObject(
  api: CloudflareApi,
  bucket: string,
  key: string,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  if (key.endsWith("/")) {
    // Delete all objects under this prefix
    const objects = await listR2StorageObjects(api, bucket, key);
    for (const obj of objects) {
      await deleteR2StorageObject(api, bucket, obj.key);
    }
  }
  await api.fetch(
    `/accounts/${cfAccountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    {
      method: "DELETE",
    },
  );
}

export async function uploadR2StorageObject(
  api: CloudflareApi,
  bucket: string,
  key: string,
  file: File,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  const arrayBuffer = await file.arrayBuffer();
  const res = await fetch(
    `${api.baseUrl}/accounts/${cfAccountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: arrayBuffer,
    },
  );
  if (!res.ok) {
    throw new Error(`R2 upload error ${res.status}: ${await res.text()}`);
  }
}

export async function makeR2StorageFolder(
  api: CloudflareApi,
  bucket: string,
  key: string,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  const folderKey = key.endsWith("/") ? key : `${key}/`;
  const res = await fetch(
    `${api.baseUrl}/accounts/${cfAccountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(folderKey)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/x-directory",
        "Content-Length": "0",
      },
      body: null,
    },
  );
  if (!res.ok) {
    throw new Error(`R2 mkdir error ${res.status}: ${await res.text()}`);
  }
}
