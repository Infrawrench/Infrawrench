/**
 * Shared S3-compatible storage helpers for object-store plugins.
 *
 * AWS S3, DigitalOcean Spaces, and Scaleway Object Storage all expose the
 * same S3 REST API (ListObjectsV2, PUT object, DELETE object). This module
 * centralises the verbs so each plugin only has to declare its endpoint
 * convention (virtual-hosted vs path-style) and the signer credentials.
 *
 * AWS uses its own internal signer (via `client-transport.ts`) because it
 * needs to integrate with the host's HTTP proxy for self-signed CA certs;
 * DO and Scaleway use the shared `signedS3Fetch` from this package.
 */

import type { StorageObject } from "./schema.js";
import { signedS3Fetch } from "./signed-s3-request.js";

export interface S3StorageConfig {
  accessKey: string;
  secretKey: string;
  /** AWS-style region label, e.g. "nyc3", "fr-par". */
  region: string;
  /**
   * Build the request URL for a given bucket/key/query. Lets plugins pick
   * virtual-hosted ({bucket}.{host}/{key}) or path-style ({host}/{bucket}/{key}).
   * `key` is "" for bucket-level requests.
   */
  buildUrl: (bucket: string, key: string, query?: Record<string, string>) => string;
}

function joinQuery(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return qs ? `?${qs}` : "";
}

/** Build a virtual-hosted-style URL: https://{bucket}.{baseHost}/{key}?qs */
export function virtualHostedUrl(baseHostForRegion: (region: string) => string) {
  return (region: string) =>
    (bucket: string, key: string, query: Record<string, string> = {}): string => {
      const host = baseHostForRegion(region);
      const path = key
        ? `/${key
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/")}`
        : "/";
      return `https://${bucket}.${host}${path}${joinQuery(query)}`;
    };
}

/** Build a path-style URL: https://{host}/{bucket}/{key}?qs */
export function pathStyleUrl(hostForRegion: (region: string) => string) {
  return (region: string) =>
    (bucket: string, key: string, query: Record<string, string> = {}): string => {
      const host = hostForRegion(region);
      const encodedKey = key
        ? key
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/")
        : "";
      const path = encodedKey ? `/${bucket}/${encodedKey}` : `/${bucket}`;
      return `https://${host}${path}${joinQuery(query)}`;
    };
}

async function s3Fetch(
  cfg: S3StorageConfig,
  method: string,
  bucket: string,
  key: string,
  query: Record<string, string> = {},
  body?: string | Uint8Array,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = cfg.buildUrl(bucket, key, query);
  const init: Parameters<typeof signedS3Fetch>[0] = {
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region,
    method,
    url,
  };
  if (extraHeaders) init.headers = extraHeaders;
  if (body !== undefined) init.body = body;
  return signedS3Fetch(init);
}

function ensureOk(res: Response, label: string): Promise<Response> {
  if (res.ok) return Promise.resolve(res);
  return res.text().then((text) => {
    throw new Error(`S3 ${label} failed: ${res.status} ${text.slice(0, 200)}`);
  });
}

/**
 * Minimal extractor for the repeating <Tag>…</Tag> patterns in ListObjectsV2
 * responses. Avoids pulling a full XML parser into the browser bundle.
 */
function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1] ?? "");
  }
  return out;
}

function extractFirst(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(xml);
  return m ? (m[1] ?? "") : "";
}

export async function listS3Objects(
  cfg: S3StorageConfig,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const results: StorageObject[] = [];
  let continuationToken: string | undefined;

  do {
    const query: Record<string, string> = {
      "list-type": "2",
      delimiter: "/",
      "max-keys": "1000",
    };
    if (prefix) query["prefix"] = prefix;
    if (continuationToken) query["continuation-token"] = continuationToken;

    const res = await ensureOk(await s3Fetch(cfg, "GET", bucket, "", query), "ListObjectsV2");
    const xml = await res.text();

    // Common prefixes → directories.
    for (const block of extractAll(xml, "CommonPrefixes")) {
      const dirKey = extractFirst(block, "Prefix");
      if (!dirKey) continue;
      const name = dirKey.slice(prefix.length).replace(/\/$/, "");
      results.push({ key: dirKey, name, size: 0, lastModified: "", isDirectory: true });
    }

    // Contents → files.
    for (const block of extractAll(xml, "Contents")) {
      const key = extractFirst(block, "Key");
      if (!key || key === prefix) continue;
      const name = key.slice(prefix.length);
      results.push({
        key,
        name,
        size: Number(extractFirst(block, "Size") || 0),
        lastModified: extractFirst(block, "LastModified"),
        isDirectory: false,
      });
    }

    const truncated = extractFirst(xml, "IsTruncated") === "true";
    continuationToken = truncated ? extractFirst(xml, "NextContinuationToken") : undefined;
  } while (continuationToken);

  return results;
}

export async function uploadS3Object(
  cfg: S3StorageConfig,
  bucket: string,
  key: string,
  file: File,
): Promise<void> {
  const body = new Uint8Array(await file.arrayBuffer());
  await ensureOk(
    await s3Fetch(cfg, "PUT", bucket, key, {}, body, {
      "content-type": file.type || "application/octet-stream",
      "content-length": String(body.byteLength),
    }),
    "PUT object",
  );
}

export async function makeS3Folder(
  cfg: S3StorageConfig,
  bucket: string,
  key: string,
): Promise<void> {
  const folderKey = key.endsWith("/") ? key : `${key}/`;
  await ensureOk(
    await s3Fetch(cfg, "PUT", bucket, folderKey, {}, new Uint8Array(0), {
      "content-type": "application/x-directory",
      "content-length": "0",
    }),
    "PUT folder marker",
  );
}

async function s3DeleteSingle(cfg: S3StorageConfig, bucket: string, key: string): Promise<void> {
  const res = await s3Fetch(cfg, "DELETE", bucket, key);
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`S3 DELETE object failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function deleteS3Object(
  cfg: S3StorageConfig,
  bucket: string,
  key: string,
): Promise<void> {
  if (!key.endsWith("/")) {
    return s3DeleteSingle(cfg, bucket, key);
  }
  // Folder: enumerate the prefix flat (no delimiter) and delete each object.
  let continuationToken: string | undefined;
  const allKeys: string[] = [];
  do {
    const query: Record<string, string> = {
      "list-type": "2",
      "max-keys": "1000",
      prefix: key,
    };
    if (continuationToken) query["continuation-token"] = continuationToken;
    const res = await ensureOk(await s3Fetch(cfg, "GET", bucket, "", query), "ListObjectsV2");
    const xml = await res.text();
    for (const block of extractAll(xml, "Contents")) {
      const k = extractFirst(block, "Key");
      if (k) allKeys.push(k);
    }
    const truncated = extractFirst(xml, "IsTruncated") === "true";
    continuationToken = truncated ? extractFirst(xml, "NextContinuationToken") : undefined;
  } while (continuationToken);

  await Promise.all(allKeys.map((k) => s3DeleteSingle(cfg, bucket, k)));
  if (!allKeys.includes(key)) {
    // Best-effort: also remove the placeholder marker if it wasn't in the listing.
    await s3DeleteSingle(cfg, bucket, key);
  }
}

export async function getS3BucketPolicy(cfg: S3StorageConfig, bucket: string): Promise<string> {
  const res = await s3Fetch(cfg, "GET", bucket, "", { policy: "" });
  if (res.status === 404) return "";
  // Some S3-compatible vendors return a vendor XML error (NoSuchBucketPolicy)
  // instead of a 404 — treat that as "no policy set" so the editor opens
  // cleanly on an empty bucket.
  if (!res.ok) {
    const text = await res.text();
    if (/NoSuchBucketPolicy/i.test(text)) return "";
    throw new Error(`GetBucketPolicy failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.text();
}

export async function putS3BucketPolicy(
  cfg: S3StorageConfig,
  bucket: string,
  policy: string,
): Promise<void> {
  const body = policy.trim();
  if (!body) {
    const res = await s3Fetch(cfg, "DELETE", bucket, "", { policy: "" });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new Error(`DeleteBucketPolicy failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return;
  }
  const res = await s3Fetch(cfg, "PUT", bucket, "", { policy: "" }, body, {
    "content-type": "application/json",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PutBucketPolicy failed: ${res.status} ${text.slice(0, 200)}`);
  }
}
