import type { ResourceInstance, StorageObject } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapR2Bucket(
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
  const cfAccountId = await api.getAccountId();
  const response = await api.fetch<{ buckets: Array<Record<string, unknown>> }>(
    `/accounts/${cfAccountId}/r2/buckets`,
  );
  const buckets = response?.buckets ?? (Array.isArray(response) ? response : []);
  return (buckets as Array<Record<string, unknown>>).map((b) =>
    mapR2Bucket(b, accountId, cfAccountId),
  );
}

export async function getR2Bucket(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const bucket = await api.fetch<Record<string, unknown>>(
    `/accounts/${cfAccountId}/r2/buckets/${externalId}`,
  );
  return mapR2Bucket(bucket, accountId, cfAccountId);
}

export async function createR2Bucket(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const body: Record<string, unknown> = { name: fields["name"] };
  if (fields["locationHint"]) body["locationHint"] = fields["locationHint"];
  const bucket = await api.fetch<Record<string, unknown>>(`/accounts/${cfAccountId}/r2/buckets`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return mapR2Bucket(bucket, accountId, cfAccountId);
}

export async function deleteR2Bucket(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/r2/buckets/${externalId}`, { method: "DELETE" });
}

export async function listR2StorageObjects(
  api: CloudflareApi,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const cfAccountId = await api.getAccountId();
  const params = new URLSearchParams({ prefix, delimiter: "/" });
  const res = await api.fetch<Record<string, unknown>>(
    `/accounts/${cfAccountId}/r2/buckets/${bucket}/objects?${params.toString()}`,
  );

  const objects: StorageObject[] = [];

  // Directories (common prefixes)
  const prefixes = (res as unknown as { delimited_prefixes?: string[] })?.delimited_prefixes ?? [];
  for (const p of prefixes) {
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
  const items = (res as unknown as { objects?: Array<Record<string, unknown>> })?.objects ?? [];
  for (const item of items) {
    const key = String(item["key"] ?? "");
    if (key === prefix) continue; // skip the prefix itself
    const name = key.slice(prefix.length);
    if (!name) continue;
    objects.push({
      key,
      name,
      size: Number(item["size"] ?? 0),
      lastModified: String(item["uploaded"] ?? ""),
      isDirectory: false,
      contentType: String(item["httpMetadata"]?.toString() ?? ""),
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
