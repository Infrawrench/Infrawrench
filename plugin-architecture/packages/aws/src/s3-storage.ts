import type { StorageObject } from "@infrawrench/plugin-base";
import type { AwsCredentials } from "./auth.js";
import { parseXml, ensureArray } from "./auth.js";
import { fetchSigned } from "./signed-request.js";

/** S3-specific XML GET for ListObjectsV2 */
async function s3Xml<T>(
  creds: AwsCredentials,
  bucket: string,
  params: Record<string, string>,
): Promise<T> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const searchParams = new URLSearchParams(params);
  const url = `https://${host}/?${searchParams}`;
  const res = await fetchSigned({
    method: "GET",
    url,
    headers: { Host: host },
    service: "s3",
    credentials: creds,
  });
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
  await fetchSigned({
    method: "PUT",
    url,
    headers: { Host: host, "Content-Type": "application/octet-stream" },
    body,
    service: "s3",
    credentials: creds,
  });
}

/** S3 DELETE object */
async function s3Delete(creds: AwsCredentials, bucket: string, key: string): Promise<void> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const url = `https://${host}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  await fetchSigned({
    method: "DELETE",
    url,
    headers: { Host: host },
    service: "s3",
    credentials: creds,
  });
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
  await fetchSigned({
    method: "PUT",
    url,
    headers: {
      Host: host,
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": String(body.byteLength),
    },
    body,
    service: "s3",
    credentials: creds,
  });
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

export async function getBucketPolicy(creds: AwsCredentials, bucket: string): Promise<string> {
  // S3 returns 404 + NoSuchBucketPolicy when no policy is set, and `fetchSigned`
  // throws on non-2xx with the body inlined in the message — catch that and
  // surface an empty editor instead of an error banner.
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  try {
    const res = await fetchSigned({
      method: "GET",
      url: `https://${host}/?policy=`,
      headers: { Host: host },
      service: "s3",
      credentials: creds,
    });
    return await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/NoSuchBucketPolicy/i.test(msg) || /\b404\b/.test(msg)) return "";
    throw e;
  }
}

export async function putBucketPolicy(
  creds: AwsCredentials,
  bucket: string,
  policy: string,
): Promise<void> {
  const host = `${bucket}.s3.${creds.region}.amazonaws.com`;
  const trimmed = policy.trim();
  if (!trimmed) {
    // `fetchSigned` already throws with the body inlined on non-2xx — except
    // a 404 here just means "no policy to delete", which we treat as success.
    try {
      await fetchSigned({
        method: "DELETE",
        url: `https://${host}/?policy=`,
        headers: { Host: host },
        service: "s3",
        credentials: creds,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/NoSuchBucketPolicy/i.test(msg) || /\b404\b/.test(msg)) return;
      throw e;
    }
    return;
  }
  await fetchSigned({
    method: "PUT",
    url: `https://${host}/?policy=`,
    headers: { Host: host, "Content-Type": "application/json" },
    body: trimmed,
    service: "s3",
    credentials: creds,
  });
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
