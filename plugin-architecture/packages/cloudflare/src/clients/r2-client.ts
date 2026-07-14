import type { ResourceInstance, StorageObject } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord } from "./shared.js";

/**
 * R2 bucket CRUD uses the official SDK (`cf.r2.buckets.*`). The R2 *object*
 * plane (list/upload/delete per-object) is not exposed by the SDK so those
 * operations remain on `api.fetch`. See task spec for details.
 */

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
  const params: Record<string, unknown> = { account_id, name: fields["name"] ?? "" };
  if (fields["locationHint"]) params["locationHint"] = fields["locationHint"];
  const bucket = await api.cf.r2.buckets.create(
    params as unknown as Parameters<typeof api.cf.r2.buckets.create>[0],
  );
  return mapR2Bucket(asRecord(bucket), accountId, account_id);
}

export async function deleteR2Bucket(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.r2.buckets.delete(externalId, { account_id });
}

// --- R2 object plane (intentionally left on raw fetch — SDK has no coverage) ---

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
