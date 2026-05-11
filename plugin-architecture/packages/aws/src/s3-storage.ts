import type { StorageObject } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { signRequest, parseXml, ensureArray } from "./auth.js";

/** S3-specific XML GET for ListObjectsV2 */
async function s3Xml<T>(
  creds: AwsCredentials,
  bucket: string,
  params: Record<string, string>,
): Promise<T> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const searchParams = new URLSearchParams(params);
  const url = `https://${host}/?${searchParams}`;
  const headers = await signRequest({
    method: "GET",
    url,
    headers: { Host: host },
    service: "s3",
    credentials: creds,
  });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`S3 ListObjectsV2 failed: ${res.status}`);
  const xml = await res.text();
  return parseXml(xml) as T;
}

/** S3 PUT object */
async function s3Put(
  creds: AwsCredentials,
  bucket: string,
  key: string,
  body: string | ArrayBuffer,
): Promise<void> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  const bodyStr = typeof body === "string" ? body : "";
  const headers = await signRequest({
    method: "PUT",
    url,
    headers: { Host: host, "Content-Type": "application/octet-stream" },
    body: bodyStr,
    service: "s3",
    credentials: creds,
  });
  const res = await fetch(url, { method: "PUT", headers, body });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
}

/** S3 DELETE object */
async function s3Delete(creds: AwsCredentials, bucket: string, key: string): Promise<void> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  const headers = await signRequest({
    method: "DELETE",
    url,
    headers: { Host: host },
    service: "s3",
    credentials: creds,
  });
  const res = await fetch(url, { method: "DELETE", headers });
  if (!res.ok) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
}

export async function uploadStorageObject(
  creds: AwsCredentials,
  bucket: string,
  key: string,
  file: File,
): Promise<void> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  const body = await file.arrayBuffer();
  const bodyStr = new TextDecoder().decode(body);
  const headers = await signRequest({
    method: "PUT",
    url,
    headers: {
      Host: host,
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": String(body.byteLength),
    },
    body: bodyStr,
    service: "s3",
    credentials: creds,
  });
  const res = await fetch(url, { method: "PUT", headers, body });
  if (!res.ok) throw new Error(`S3 upload ${key} failed: ${res.status}`);
}

export async function listStorageObjects(
  creds: AwsCredentials,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const results: StorageObject[] = [];
  let continuationToken: string | undefined;

  do {
    const params: Record<string, string> = {
      "list-type": "2",
      delimiter: "/",
      "max-keys": "1000",
    };
    if (prefix) params["prefix"] = prefix;
    if (continuationToken) params["continuation-token"] = continuationToken;

    const data = await s3Xml<Record<string, unknown>>(creds, bucket, params);

    // Common prefixes (directories)
    const prefixes = ensureArray(data["CommonPrefixes"]) as Record<string, unknown>[];
    for (const p of prefixes) {
      const key = String(p["Prefix"] ?? "");
      const name = key.slice(prefix.length).replace(/\/$/, "");
      results.push({ key, name, size: 0, lastModified: "", isDirectory: true });
    }

    // Objects
    const contents = ensureArray(data["Contents"]) as Record<string, unknown>[];
    for (const obj of contents) {
      const key = String(obj["Key"] ?? "");
      if (key === prefix) continue; // skip folder placeholder
      const name = key.slice(prefix.length);
      results.push({
        key,
        name,
        size: Number(obj["Size"] ?? 0),
        lastModified: String(obj["LastModified"] ?? ""),
        isDirectory: false,
      });
    }

    continuationToken =
      data["IsTruncated"] === "true" ? String(data["NextContinuationToken"] ?? "") : undefined;
  } while (continuationToken);

  return results;
}

export async function makeStorageFolder(
  creds: AwsCredentials,
  bucket: string,
  key: string,
): Promise<void> {
  const folderKey = key.endsWith("/") ? key : `${key}/`;
  await s3Put(creds, bucket, folderKey, "");
}

export async function deleteStorageObject(
  creds: AwsCredentials,
  bucket: string,
  key: string,
): Promise<void> {
  if (key.endsWith("/")) {
    // Delete all objects under this prefix
    const objects = await listStorageObjects(creds, bucket, key);
    for (const obj of objects) {
      if (obj.isDirectory) {
        await deleteStorageObject(creds, bucket, obj.key);
      } else {
        await s3Delete(creds, bucket, obj.key);
      }
    }
    // Delete the folder placeholder itself
    await s3Delete(creds, bucket, key);
  } else {
    await s3Delete(creds, bucket, key);
  }
}
