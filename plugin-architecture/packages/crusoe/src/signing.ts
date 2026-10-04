/**
 * Crusoe Cloud request signing (signature version 1.0).
 *
 * Verified against Crusoe's API reference (docs.cloud.crusoe.ai/reference/api,
 * "Authentication") and the reference implementation in
 * `crusoecloud/terraform-provider-crusoe` (`internal/common/auth.go`), 2026-10:
 *
 *   payload   = http_path + "\n" + canonical_query + "\n" + VERB + "\n" + timestamp + "\n"
 *   key       = base64url-decode(secret key)            (unpadded, URL-safe alphabet)
 *   signature = base64url(HMAC-SHA256(key, payload))     (unpadded)
 *   headers   X-Crusoe-Timestamp: <RFC 3339, second precision>
 *             Authorization: Bearer 1.0:<access key id>:<signature>
 *
 * `http_path` includes the `/v1` API prefix. The canonical query is Go's
 * `url.Values.Encode()` over the parsed query: keys sorted, each value
 * `QueryEscape`d (space as `+`), repeated keys kept in their original order.
 * The request is sent with exactly the query string this module builds, so
 * the two can never disagree.
 *
 * Web Crypto rather than `node:crypto`: the client also runs in the desktop
 * renderer, and `crypto.subtle` exists in both.
 */

export const SIGNATURE_VERSION = "1.0";
export const TIMESTAMP_HEADER = "X-Crusoe-Timestamp";

/** One query parameter. Arrays become repeated keys (`projects=a&projects=b`). */
export type QueryValue = string | number | boolean | readonly string[] | undefined;

/** Go's `url.QueryEscape`: unreserved characters pass, space is `+`. */
export function goQueryEscape(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/**
 * Build the canonical (sorted) query string. Undefined and empty-array values
 * are dropped, because an absent filter and an empty one mean the same thing
 * to the API and only one of them can be signed.
 */
export function canonicalQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const keys = Object.keys(query)
    .filter((k) => {
      const v = query[k];
      if (v === undefined) return false;
      if (Array.isArray(v)) return v.length > 0;
      return true;
    })
    .sort();
  const parts: string[] = [];
  for (const key of keys) {
    const raw = query[key];
    const values = Array.isArray(raw) ? (raw as readonly string[]) : [String(raw)];
    for (const v of values) parts.push(`${goQueryEscape(key)}=${goQueryEscape(v)}`);
  }
  return parts.join("&");
}

/** RFC 3339 at second precision, the shape both reference clients send. */
export function crusoeTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function signaturePayload(
  path: string,
  query: string,
  method: string,
  timestamp: string,
): string {
  return `${path}\n${query}\n${method.toUpperCase()}\n${timestamp}\n`;
}

export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Produce the two auth headers for one request. `path` must already carry the
 * `/v1` prefix; `query` must be the exact string that goes on the URL.
 */
export async function signRequest(opts: {
  accessKeyId: string;
  secretKey: string;
  method: string;
  path: string;
  query: string;
  now?: Date;
}): Promise<Record<string, string>> {
  const timestamp = crusoeTimestamp(opts.now);
  const payload = signaturePayload(opts.path, opts.query, opts.method, timestamp);
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlDecode(opts.secretKey);
  } catch {
    throw new Error(
      "Crusoe plugin: the secret key is not valid base64. Paste it exactly as the console showed it.",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const signature = base64UrlEncode(new Uint8Array(mac));
  return {
    [TIMESTAMP_HEADER]: timestamp,
    Authorization: `Bearer ${SIGNATURE_VERSION}:${opts.accessKeyId}:${signature}`,
  };
}
