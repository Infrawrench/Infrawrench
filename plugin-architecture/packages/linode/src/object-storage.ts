/**
 * Object browser for buckets, entirely through the Linode API rather than S3
 * keys: `GET .../object-list` lists with `prefix`/`delimiter`/`marker`, and
 * `POST .../object-url` hands out pre-signed URLs for PUT and DELETE, so the
 * account's personal access token is the only credential needed.
 * The `bucket` argument is the resource's external id, `{region}/{name}`.
 */

import type { StorageObject } from "@infrawrench/plugin-base";
import type { LinodeApi } from "./api.js";

interface ObjectListResponse {
  data?: Array<{
    name: string;
    size?: number | null;
    last_modified?: string | null;
    etag?: string | null;
  }>;
  is_truncated?: boolean;
  next_marker?: string | null;
}

export function splitBucket(bucket: string): { region: string; name: string } {
  const i = bucket.indexOf("/");
  if (i <= 0) throw new Error(`Linode plugin: bucket reference "${bucket}" is not region/name`);
  return { region: bucket.slice(0, i), name: bucket.slice(i + 1) };
}

function base(bucket: string): string {
  const { region, name } = splitBucket(bucket);
  return `/object-storage/buckets/${region}/${encodeURIComponent(name)}`;
}

async function listRaw(
  api: LinodeApi,
  bucket: string,
  prefix: string,
  delimiter: boolean,
): Promise<NonNullable<ObjectListResponse["data"]>> {
  const out: NonNullable<ObjectListResponse["data"]> = [];
  let marker: string | undefined;
  for (let i = 0; i < 200; i++) {
    const res = await api.get<ObjectListResponse>(`${base(bucket)}/object-list`, {
      query: {
        prefix,
        ...(delimiter ? { delimiter: "/" } : {}),
        page_size: 500,
        ...(marker ? { marker } : {}),
      },
    });
    out.push(...(res.data ?? []));
    if (!res.is_truncated || !res.next_marker) break;
    marker = res.next_marker;
  }
  return out;
}

export async function listObjects(
  api: LinodeApi,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const rows = await listRaw(api, bucket, prefix, true);
  return rows
    .filter((o) => o.name !== prefix)
    .map((o) => {
      const isDirectory = o.name.endsWith("/") && o.size == null;
      const trimmed = o.name.slice(prefix.length).replace(/\/$/, "");
      return {
        key: o.name,
        name: trimmed || o.name,
        size: o.size ?? 0,
        lastModified: o.last_modified ?? "",
        isDirectory,
      };
    });
}

async function signedUrl(
  api: LinodeApi,
  bucket: string,
  name: string,
  method: "PUT" | "DELETE",
  contentType?: string,
): Promise<string> {
  const res = await api.send<{ url?: string }>("POST", `${base(bucket)}/object-url`, {
    name,
    method,
    expires_in: 600,
    ...(contentType ? { content_type: contentType } : {}),
  });
  if (!res.url) throw new Error("Linode did not return a signed URL");
  return res.url;
}

export async function uploadObject(
  api: LinodeApi,
  bucket: string,
  key: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const contentType = file.type || "application/octet-stream";
  const url = await signedUrl(api, bucket, key, "PUT", contentType);
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  onProgress?.(100);
}

export async function makeFolder(api: LinodeApi, bucket: string, key: string): Promise<void> {
  const name = key.endsWith("/") ? key : `${key}/`;
  const url = await signedUrl(api, bucket, name, "PUT", "application/x-directory");
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/x-directory" },
    body: "",
  });
  if (!res.ok) throw new Error(`Creating the folder failed: ${res.status}`);
}

export async function deleteObject(api: LinodeApi, bucket: string, key: string): Promise<void> {
  const names = key.endsWith("/")
    ? (await listRaw(api, bucket, key, false)).map((o) => o.name)
    : [key];
  if (key.endsWith("/") && !names.includes(key)) names.push(key);
  for (const name of names) {
    const url = await signedUrl(api, bucket, name, "DELETE");
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`Deleting ${name} failed: ${res.status}`);
  }
}
