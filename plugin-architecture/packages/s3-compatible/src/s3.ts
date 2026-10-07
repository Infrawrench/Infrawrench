import type { HttpHostServices } from "@infrawrench/plugin-base";
import { bytesToBase64 } from "@infrawrench/plugin-base";
import { signV4 } from "./sigv4.js";

/**
 * A small S3 REST client: SigV4 from `sigv4.ts`, sent through the host HTTP
 * service whenever there is one so bastion egress and a custom CA apply. XML is read with tag scanners rather than a parser, the
 * same choice plugin-base's S3 helpers make.
 *
 * Kept self-contained (and duplicated from the wasabi plugin) so each
 * S3-based plugin owns its own copy rather than growing plugin-base.
 */

export interface S3Config {
  /** Origin, e.g. `https://s3.us-east-2.wasabisys.com` or `https://minio.lan:9000`. */
  endpoint: string;
  region: string;
  /** `https://host/bucket/key` instead of `https://bucket.host/key`. */
  pathStyle: boolean;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "S3Error";
    this.status = status;
    this.code = code;
  }
}

export interface S3Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Query = Record<string, string>;

export interface S3RequestOptions {
  bucket?: string;
  key?: string;
  query?: Query;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
  /** Statuses returned instead of thrown (e.g. 404 for "no lifecycle"). */
  allow?: number[];
  /** Overrides the signing service (IAM, STS). */
  service?: string;
}

/** One exchange through the host HTTP service, or `fetch` without one. */
export async function transport(
  cfg: Pick<S3Config, "http" | "caCert">,
  req: { url: string; method: string; headers: Record<string, string>; body?: string | Uint8Array },
): Promise<S3Response> {
  if (cfg.http) {
    const res = await cfg.http.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(cfg.caCert ? { caCert: cfg.caCert } : {}),
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
    return { status: res.status, headers, body: res.body };
  }
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body as BodyInit } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Inner XML of every `<tag>` (namespaces and attributes tolerated). */
export function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? "");
  return out;
}

export function xmlFirst(xml: string, tag: string): string {
  const v = xmlAll(xml, tag)[0];
  return v === undefined ? "" : xmlUnescape(v.trim());
}

export function xmlTexts(xml: string, tag: string): string[] {
  return xmlAll(xml, tag).map((v) => xmlUnescape(v.trim()));
}

/** Pull the code and message out of an S3 `<Error>` body. */
export function s3ErrorFrom(status: number, body: string, label: string): S3Error {
  const code = xmlFirst(body, "Code");
  const message = xmlFirst(body, "Message") || body.slice(0, 200);
  return new S3Error(
    status,
    code,
    `S3 ${label} failed (${status}${code ? ` ${code}` : ""}): ${message}`,
  );
}

// ── MD5 (Content-MD5 for lifecycle, CORS and multi-delete bodies) ─────────
// WebCrypto has no MD5, and the S3 operations that take a configuration body
// require Content-MD5 on most S3-compatible servers.

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
);

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i]! + view.getUint32(off + g * 4, true)) >>> 0;
      b = (b + ((x << MD5_S[i]!) | (x >>> (32 - MD5_S[i]!)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return out;
}

export function contentMd5(body: string): string {
  return bytesToBase64(md5(new TextEncoder().encode(body)));
}

// ── Model ─────────────────────────────────────────────────────────────────

export interface S3Bucket {
  name: string;
  creationDate: string;
}

export interface S3LifecycleRule {
  id: string;
  enabled: boolean;
  prefix: string;
  expirationDays?: number;
  noncurrentDays?: number;
  abortMultipartDays?: number;
  expiredDeleteMarker?: boolean;
}

export interface S3CorsRule {
  id: string;
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds?: number;
}

export interface S3ObjectLock {
  enabled: boolean;
  mode?: string;
  days?: number;
  years?: number;
}

export interface S3ListPage {
  folders: string[];
  objects: Array<{ key: string; size: number; lastModified: string }>;
}

function num(raw: string): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function parseLifecycle(xml: string): S3LifecycleRule[] {
  return xmlAll(xml, "Rule").map((rule, i) => {
    const filter = xmlAll(rule, "Filter")[0] ?? "";
    const prefix =
      xmlFirst(filter, "Prefix") ||
      xmlFirst(rule.replace(/<Filter[\s\S]*?<\/Filter>/, ""), "Prefix");
    const expiration = xmlAll(rule, "Expiration")[0] ?? "";
    const r: S3LifecycleRule = {
      id: xmlFirst(rule, "ID") || `rule-${i + 1}`,
      enabled: xmlFirst(rule, "Status") === "Enabled",
      prefix,
    };
    const exp = num(xmlFirst(expiration, "Days"));
    if (exp !== undefined) r.expirationDays = exp;
    if (xmlFirst(expiration, "ExpiredObjectDeleteMarker") === "true") r.expiredDeleteMarker = true;
    const nc = num(
      xmlFirst(xmlAll(rule, "NoncurrentVersionExpiration")[0] ?? "", "NoncurrentDays"),
    );
    if (nc !== undefined) r.noncurrentDays = nc;
    const abort = num(
      xmlFirst(xmlAll(rule, "AbortIncompleteMultipartUpload")[0] ?? "", "DaysAfterInitiation"),
    );
    if (abort !== undefined) r.abortMultipartDays = abort;
    return r;
  });
}

export function lifecycleXml(rules: S3LifecycleRule[]): string {
  const body = rules
    .map((r) => {
      const parts = [
        `<ID>${xmlEscape(r.id)}</ID>`,
        `<Filter><Prefix>${xmlEscape(r.prefix)}</Prefix></Filter>`,
        `<Status>${r.enabled ? "Enabled" : "Disabled"}</Status>`,
      ];
      if (r.expirationDays) parts.push(`<Expiration><Days>${r.expirationDays}</Days></Expiration>`);
      else if (r.expiredDeleteMarker) {
        parts.push(
          "<Expiration><ExpiredObjectDeleteMarker>true</ExpiredObjectDeleteMarker></Expiration>",
        );
      }
      if (r.noncurrentDays) {
        parts.push(
          `<NoncurrentVersionExpiration><NoncurrentDays>${r.noncurrentDays}</NoncurrentDays></NoncurrentVersionExpiration>`,
        );
      }
      if (r.abortMultipartDays) {
        parts.push(
          `<AbortIncompleteMultipartUpload><DaysAfterInitiation>${r.abortMultipartDays}</DaysAfterInitiation></AbortIncompleteMultipartUpload>`,
        );
      }
      return `<Rule>${parts.join("")}</Rule>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</LifecycleConfiguration>`;
}

export function parseCors(xml: string): S3CorsRule[] {
  return xmlAll(xml, "CORSRule").map((rule, i) => {
    const r: S3CorsRule = {
      id: xmlFirst(rule, "ID") || `rule-${i + 1}`,
      allowedOrigins: xmlTexts(rule, "AllowedOrigin"),
      allowedMethods: xmlTexts(rule, "AllowedMethod"),
      allowedHeaders: xmlTexts(rule, "AllowedHeader"),
      exposeHeaders: xmlTexts(rule, "ExposeHeader"),
    };
    const age = num(xmlFirst(rule, "MaxAgeSeconds"));
    if (age !== undefined) r.maxAgeSeconds = age;
    return r;
  });
}

export function corsXml(rules: S3CorsRule[]): string {
  const body = rules
    .map((r) => {
      const parts = [`<ID>${xmlEscape(r.id)}</ID>`];
      for (const o of r.allowedOrigins)
        parts.push(`<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`);
      for (const m of r.allowedMethods)
        parts.push(`<AllowedMethod>${xmlEscape(m)}</AllowedMethod>`);
      for (const h of r.allowedHeaders)
        parts.push(`<AllowedHeader>${xmlEscape(h)}</AllowedHeader>`);
      for (const h of r.exposeHeaders) parts.push(`<ExposeHeader>${xmlEscape(h)}</ExposeHeader>`);
      if (r.maxAgeSeconds !== undefined)
        parts.push(`<MaxAgeSeconds>${r.maxAgeSeconds}</MaxAgeSeconds>`);
      return `<CORSRule>${parts.join("")}</CORSRule>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</CORSConfiguration>`;
}

export function parseObjectLock(xml: string): S3ObjectLock {
  const lock: S3ObjectLock = { enabled: xmlFirst(xml, "ObjectLockEnabled") === "Enabled" };
  const mode = xmlFirst(xml, "Mode");
  if (mode) lock.mode = mode;
  const days = num(xmlFirst(xml, "Days"));
  if (days !== undefined) lock.days = days;
  const years = num(xmlFirst(xml, "Years"));
  if (years !== undefined) lock.years = years;
  return lock;
}

export function objectLockXml(mode: string | undefined, days: number | undefined): string {
  const rule =
    mode && days
      ? `<Rule><DefaultRetention><Mode>${xmlEscape(mode)}</Mode><Days>${days}</Days></DefaultRetention></Rule>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?><ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled>${rule}</ObjectLockConfiguration>`;
}

export function parseTags(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of xmlAll(xml, "Tag")) out[xmlFirst(tag, "Key")] = xmlFirst(tag, "Value");
  return out;
}

export function tagsXml(tags: Record<string, string>): string {
  const body = Object.entries(tags)
    .map(([k, v]) => `<Tag><Key>${xmlEscape(k)}</Key><Value>${xmlEscape(v)}</Value></Tag>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${body}</TagSet></Tagging>`;
}

/** `k=v, k2=v2` → map. */
export function parseTagString(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) throw new Error(`"${p}" is not a key=value tag.`);
    out[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return out;
}

export function tagString(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

// ── Client ────────────────────────────────────────────────────────────────

export class S3Client {
  constructor(readonly cfg: S3Config) {}

  withRegion(region: string, endpoint?: string): S3Client {
    return new S3Client({ ...this.cfg, region, ...(endpoint ? { endpoint } : {}) });
  }

  url(bucket: string | undefined, key: string | undefined, query: Query = {}): string {
    const origin = this.cfg.endpoint.replace(/\/+$/, "");
    const qs = Object.entries(query)
      .map(([k, v]) =>
        v === "" ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
      )
      .join("&");
    const suffix = qs ? `?${qs}` : "";
    const path = key ? `/${encodeKey(key)}` : "/";
    if (!bucket) return `${origin}/${suffix}`;
    if (this.cfg.pathStyle)
      return `${origin}/${encodeURIComponent(bucket)}${key ? path : ""}${suffix}`;
    const u = new URL(origin);
    return `${u.protocol}//${bucket}.${u.host}${path}${suffix}`;
  }

  async send(method: string, opts: S3RequestOptions = {}, label = method): Promise<S3Response> {
    const url = this.url(opts.bucket, opts.key, opts.query);
    const signed = await signV4({
      method,
      url,
      headers: opts.headers ?? {},
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      accessKey: this.cfg.accessKey,
      secretKey: this.cfg.secretKey,
      region: this.cfg.region,
      service: opts.service ?? "s3",
      ...(this.cfg.sessionToken ? { sessionToken: this.cfg.sessionToken } : {}),
    });
    const out = await transport(this.cfg, {
      url,
      method,
      headers: signed,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    });
    const ok = out.status >= 200 && out.status < 300;
    if (ok || opts.allow?.includes(out.status)) return out;
    throw s3ErrorFrom(out.status, out.body, label);
  }

  private xmlBody(xml: string): { body: string; headers: Record<string, string> } {
    return {
      body: xml,
      headers: { "content-type": "application/xml", "content-md5": contentMd5(xml) },
    };
  }

  async listBuckets(): Promise<S3Bucket[]> {
    const res = await this.send("GET", {}, "ListBuckets");
    return xmlAll(res.body, "Bucket").map((b) => ({
      name: xmlFirst(b, "Name"),
      creationDate: xmlFirst(b, "CreationDate"),
    }));
  }

  /** GetBucketLocation; `""` (us-east-1 on AWS-style servers) when unset. */
  async bucketLocation(bucket: string): Promise<string> {
    const res = await this.send("GET", { bucket, query: { location: "" } }, "GetBucketLocation");
    return xmlFirst(res.body, "LocationConstraint");
  }

  async createBucket(
    bucket: string,
    opts: { region?: string; objectLock?: boolean } = {},
  ): Promise<void> {
    const xml =
      opts.region && opts.region !== "us-east-1"
        ? `<?xml version="1.0" encoding="UTF-8"?><CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${xmlEscape(opts.region)}</LocationConstraint></CreateBucketConfiguration>`
        : undefined;
    await this.send(
      "PUT",
      {
        bucket,
        ...(xml ? { body: xml } : {}),
        headers: {
          ...(xml ? { "content-type": "application/xml" } : {}),
          ...(opts.objectLock ? { "x-amz-bucket-object-lock-enabled": "true" } : {}),
        },
      },
      "CreateBucket",
    );
  }

  async deleteBucket(bucket: string): Promise<void> {
    await this.send("DELETE", { bucket }, "DeleteBucket");
  }

  async getVersioning(bucket: string): Promise<string> {
    const res = await this.send(
      "GET",
      { bucket, query: { versioning: "" } },
      "GetBucketVersioning",
    );
    return xmlFirst(res.body, "Status") || "Unversioned";
  }

  async putVersioning(bucket: string, status: "Enabled" | "Suspended"): Promise<void> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`;
    await this.send(
      "PUT",
      { bucket, query: { versioning: "" }, ...this.xmlBody(xml) },
      "PutBucketVersioning",
    );
  }

  async getLifecycle(bucket: string): Promise<S3LifecycleRule[]> {
    const res = await this.send(
      "GET",
      { bucket, query: { lifecycle: "" }, allow: [404] },
      "GetBucketLifecycle",
    );
    return res.status === 404 ? [] : parseLifecycle(res.body);
  }

  async putLifecycle(bucket: string, rules: S3LifecycleRule[]): Promise<void> {
    if (rules.length === 0) {
      await this.send(
        "DELETE",
        { bucket, query: { lifecycle: "" }, allow: [404] },
        "DeleteBucketLifecycle",
      );
      return;
    }
    await this.send(
      "PUT",
      { bucket, query: { lifecycle: "" }, ...this.xmlBody(lifecycleXml(rules)) },
      "PutBucketLifecycle",
    );
  }

  async getCors(bucket: string): Promise<S3CorsRule[]> {
    const res = await this.send(
      "GET",
      { bucket, query: { cors: "" }, allow: [404] },
      "GetBucketCors",
    );
    return res.status === 404 ? [] : parseCors(res.body);
  }

  async putCors(bucket: string, rules: S3CorsRule[]): Promise<void> {
    if (rules.length === 0) {
      await this.send("DELETE", { bucket, query: { cors: "" }, allow: [404] }, "DeleteBucketCors");
      return;
    }
    await this.send(
      "PUT",
      { bucket, query: { cors: "" }, ...this.xmlBody(corsXml(rules)) },
      "PutBucketCors",
    );
  }

  async getPolicy(bucket: string): Promise<string> {
    const res = await this.send(
      "GET",
      { bucket, query: { policy: "" }, allow: [404] },
      "GetBucketPolicy",
    );
    return res.status === 404 ? "" : res.body;
  }

  async putPolicy(bucket: string, policy: string): Promise<void> {
    const body = policy.trim();
    if (!body) {
      await this.send(
        "DELETE",
        { bucket, query: { policy: "" }, allow: [404] },
        "DeleteBucketPolicy",
      );
      return;
    }
    await this.send(
      "PUT",
      { bucket, query: { policy: "" }, body, headers: { "content-type": "application/json" } },
      "PutBucketPolicy",
    );
  }

  async getTags(bucket: string): Promise<Record<string, string>> {
    const res = await this.send(
      "GET",
      { bucket, query: { tagging: "" }, allow: [404] },
      "GetBucketTagging",
    );
    return res.status === 404 ? {} : parseTags(res.body);
  }

  async putTags(bucket: string, tags: Record<string, string>): Promise<void> {
    if (Object.keys(tags).length === 0) {
      await this.send(
        "DELETE",
        { bucket, query: { tagging: "" }, allow: [404] },
        "DeleteBucketTagging",
      );
      return;
    }
    await this.send(
      "PUT",
      { bucket, query: { tagging: "" }, ...this.xmlBody(tagsXml(tags)) },
      "PutBucketTagging",
    );
  }

  async getObjectLock(bucket: string): Promise<S3ObjectLock> {
    const res = await this.send(
      "GET",
      { bucket, query: { "object-lock": "" }, allow: [404, 400] },
      "GetObjectLockConfiguration",
    );
    return res.status >= 400 ? { enabled: false } : parseObjectLock(res.body);
  }

  async putObjectLock(
    bucket: string,
    mode: string | undefined,
    days: number | undefined,
  ): Promise<void> {
    await this.send(
      "PUT",
      { bucket, query: { "object-lock": "" }, ...this.xmlBody(objectLockXml(mode, days)) },
      "PutObjectLockConfiguration",
    );
  }

  /** One ListObjectsV2 page set (all pages) under `prefix`. */
  async listObjects(
    bucket: string,
    prefix: string,
    delimiter = "/",
    maxPages = 50,
  ): Promise<S3ListPage> {
    const out: S3ListPage = { folders: [], objects: [] };
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const query: Query = { "list-type": "2", "max-keys": "1000" };
      if (delimiter) query["delimiter"] = delimiter;
      if (prefix) query["prefix"] = prefix;
      if (token) query["continuation-token"] = token;
      const res = await this.send("GET", { bucket, query }, "ListObjectsV2");
      for (const p of xmlAll(res.body, "CommonPrefixes")) out.folders.push(xmlFirst(p, "Prefix"));
      for (const c of xmlAll(res.body, "Contents")) {
        out.objects.push({
          key: xmlFirst(c, "Key"),
          size: Number(xmlFirst(c, "Size") || 0),
          lastModified: xmlFirst(c, "LastModified"),
        });
      }
      token =
        xmlFirst(res.body, "IsTruncated") === "true"
          ? xmlFirst(res.body, "NextContinuationToken")
          : undefined;
      if (!token) break;
    }
    return out;
  }

  async putObject(
    bucket: string,
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.send(
      "PUT",
      { bucket, key, body, headers: { "content-type": contentType || "application/octet-stream" } },
      "PutObject",
    );
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.send("DELETE", { bucket, key, allow: [404] }, "DeleteObject");
  }

  /** DeleteObjects in batches of 1,000; throws on the first per-key error. */
  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const xml = `<?xml version="1.0" encoding="UTF-8"?><Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>${batch
        .map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`)
        .join("")}</Delete>`;
      const res = await this.send(
        "POST",
        { bucket, query: { delete: "" }, ...this.xmlBody(xml) },
        "DeleteObjects",
      );
      const errors = xmlAll(res.body, "Error");
      if (errors.length > 0) {
        const first = errors[0]!;
        throw new S3Error(
          409,
          xmlFirst(first, "Code"),
          `Could not delete ${xmlFirst(first, "Key")}: ${xmlFirst(first, "Message")}`,
        );
      }
    }
  }
}
