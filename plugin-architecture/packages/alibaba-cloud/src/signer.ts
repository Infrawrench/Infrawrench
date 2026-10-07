/**
 * Alibaba Cloud request signing, hand-rolled on WebCrypto so the plugin runs
 * unchanged on the server and in the desktop renderer without the 30-odd
 * `@alicloud/*` SDK packages.
 *
 * Two schemes:
 *
 * - **ACS3-HMAC-SHA256** (OpenAPI signature V3) for every RPC and ROA
 *   product: ECS, VPC, SLB, ALB, RDS, R-KVStore, CS (ACK), FC 3.0, Alidns,
 *   CloudMonitor, BSS OpenAPI, RAM, STS, Quota Center. Spec:
 *   https://www.alibabacloud.com/help/en/sdk/product-overview/v3-request-structure-and-signature
 *   The published worked example (RunInstances on ecs.cn-shanghai) is
 *   reproduced in the tests.
 * - **OSS4-HMAC-SHA256** (OSS signature V4) for Object Storage, which does
 *   not accept ACS3. Reproduced from the official Go SDK v2
 *   (`alibabacloud-oss-go-sdk-v2/oss/signer/v4.go`) and checked against its
 *   `TestV4AuthHeader` vector.
 *
 * Browsers forbid setting `Host`, so `host` is signed but never set: every
 * transport derives the same value from the URL.
 */

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: Uint8Array | string, data: string): Promise<ArrayBuffer> {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const k = await crypto.subtle.importKey(
    "raw",
    raw as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/**
 * Alibaba's percentEncode: RFC 3986 unreserved characters stay, everything
 * else is `%XX` in upper case (so a space is `%20`, `*` is `%2A`).
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Percent-encode a path, leaving the `/` separators alone. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => percentEncode(segment))
    .join("/");
}

/** Canonical query string: keys sorted, both halves percent-encoded. */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(query[k] ?? "")}`)
    .join("&");
}

export interface AcsCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}

export interface AcsSignInput {
  method: string;
  host: string;
  /** Canonical URI: `/` for RPC, the resource path for ROA. Not yet encoded. */
  path: string;
  query: Record<string, string>;
  action: string;
  version: string;
  /** Exact body bytes sent (empty string for none). */
  body: string;
  /** Content type of the body, signed when present. */
  contentType?: string;
  /** Overrides for reproducing the published test vector. */
  date?: string;
  nonce?: string;
}

function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sign one request with ACS3-HMAC-SHA256. Returns the headers to send
 * (everything signed except `host`) plus the canonical request, which the
 * tests compare against Alibaba's worked example.
 */
export async function signAcs3(
  creds: AcsCredentials,
  input: AcsSignInput,
): Promise<{ headers: Record<string, string>; canonicalRequest: string }> {
  const date = input.date ?? isoSeconds(new Date());
  const nonce = input.nonce ?? randomNonce();
  const payloadHash = await sha256Hex(input.body);
  const signed: Record<string, string> = {
    host: input.host,
    "x-acs-action": input.action,
    "x-acs-content-sha256": payloadHash,
    "x-acs-date": date,
    "x-acs-signature-nonce": nonce,
    "x-acs-version": input.version,
  };
  if (input.contentType) signed["content-type"] = input.contentType;
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    encodePath(input.path || "/"),
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${await sha256Hex(canonicalRequest)}`;
  const signature = hex(await hmac(creds.accessKeySecret, stringToSign));
  const headers: Record<string, string> = {};
  for (const n of names) if (n !== "host") headers[n] = signed[n]!;
  headers["authorization"] =
    `ACS3-HMAC-SHA256 Credential=${creds.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { headers, canonicalRequest };
}

// ---------------------------------------------------------------------------
// OSS V4

export interface OssSignInput {
  method: string;
  /** Region id, e.g. `cn-hangzhou` (not `oss-cn-hangzhou`). */
  region: string;
  bucket?: string;
  /** Object key, unencoded. */
  key?: string;
  /** The raw query string exactly as sent, without the leading `?`. */
  rawQuery: string;
  /** Headers to send that OSS signs by default (`x-oss-*`, content-type, content-md5). */
  headers: Record<string, string>;
  /** Override for tests. */
  date?: Date;
}

function ossEscapePath(path: string): string {
  let out = "";
  for (const byte of encoder.encode(path)) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~/]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function ossCanonicalQuery(rawQuery: string): string {
  const values = new Map<string, string>();
  const keys: string[] = [];
  for (const part of rawQuery.replace(/\+/g, "%20").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq < 0 ? part : part.slice(0, eq);
    const v = eq < 0 ? "" : part.slice(eq + 1);
    values.set(k, v);
    keys.push(k);
  }
  keys.sort();
  return keys.map((k) => (values.get(k) ? `${k}=${values.get(k)}` : k)).join("&");
}

function ossSignedHeader(name: string): boolean {
  return name.startsWith("x-oss-") || name === "content-type" || name === "content-md5";
}

function ossDate(date: Date): { datetime: string; day: string } {
  const iso = date.toISOString().replace(/[-:]/g, "");
  return { datetime: `${iso.slice(0, 15)}Z`, day: iso.slice(0, 8) };
}

/**
 * Sign an OSS request with V4. Returns the full header set to send: the
 * caller's headers plus `x-oss-date`, `x-oss-content-sha256` and
 * `authorization`.
 */
export async function signOssV4(
  creds: AcsCredentials,
  input: OssSignInput,
): Promise<Record<string, string>> {
  const { datetime, day } = ossDate(input.date ?? new Date());
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers["x-oss-date"] = datetime;
  headers["x-oss-content-sha256"] = "UNSIGNED-PAYLOAD";
  let uri = "/";
  if (input.bucket) uri += `${input.bucket}/`;
  if (input.key) uri += input.key;
  const names = Object.keys(headers).filter(ossSignedHeader).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    ossEscapePath(uri),
    ossCanonicalQuery(input.rawQuery),
    canonicalHeaders,
    "",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = `${day}/${input.region}/oss/aliyun_v4_request`;
  const stringToSign = `OSS4-HMAC-SHA256\n${datetime}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
  let key = new Uint8Array(await hmac(`aliyun_v4${creds.accessKeySecret}`, day));
  for (const part of [input.region, "oss", "aliyun_v4_request"]) {
    key = new Uint8Array(await hmac(key, part));
  }
  const signature = hex(await hmac(key, stringToSign));
  headers["authorization"] =
    `OSS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope},Signature=${signature}`;
  return headers;
}
