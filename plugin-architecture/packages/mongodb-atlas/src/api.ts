import type { HttpHostServices } from "@infrawrench/plugin-base";
import { md5Hex } from "./md5.js";

/**
 * Transport for the MongoDB Atlas Administration API v2
 * (https://cloud.mongodb.com/api/atlas/v2, verified against the published
 * OpenAPI document in github.com/mongodb/openapi, 2026-10).
 *
 * Two ways in, chosen from the shape of the credential so nobody has to know
 * which they hold:
 *
 * - **Service account** (preferred by MongoDB): OAuth 2.0 client credentials.
 *   `POST /api/oauth/token` with HTTP Basic `client_id:client_secret` and
 *   `grant_type=client_credentials` returns a one-hour bearer token. Client
 *   ids start with `mdb_sa_id_`. Token generation is limited to 10 requests a
 *   minute, so tokens are cached per credential for the whole process, not per
 *   client instance (the host builds clients freely).
 * - **Programmatic API key**: HTTP Digest (RFC 7616, MD5, `qop=auth`) with the
 *   public key as the user and the private key as the password. The server's
 *   challenge is cached and reused with an incrementing nonce count, so a
 *   steady stream of calls costs one round trip each; a stale or rejected
 *   nonce answers 401 with a fresh challenge and the call is retried once.
 *
 * Every endpoint is versioned by media type: `Accept:
 * application/vnd.atlas.<YYYY-MM-DD>+json`. A wrong version answers 406, so
 * each call names the version its response shape was written against.
 */

export const DEFAULT_BASE_URL = "https://cloud.mongodb.com";
export const DEFAULT_API_VERSION = "2023-01-01";

export type AtlasAuth =
  | { kind: "service-account"; clientId: string; clientSecret: string }
  | { kind: "api-key"; publicKey: string; privateKey: string };

export interface AtlasContext {
  auth: AtlasAuth;
  baseUrl: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** A non-2xx answer, carrying Atlas's own `errorCode` for callers that branch on it. */
export class AtlasApiError extends Error {
  readonly status: number;
  readonly errorCode: string;
  constructor(status: number, message: string, errorCode = "") {
    super(message);
    this.name = "AtlasApiError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof AtlasApiError ? err.status : 0;
}

export function isPermissionError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 403;
}

/** Service account client ids carry this prefix; API key public keys never do. */
const SERVICE_ACCOUNT_PREFIX = "mdb_sa_id_";

/**
 * Build the auth from the two credential fields. The first field holds a
 * service account client id or an API key's public key, the second the
 * matching secret; which one it is follows from the id's prefix.
 */
export function authFromCredentials(credentials: Record<string, string>): AtlasAuth {
  const id = (credentials["clientId"] ?? "").trim();
  const secret = (credentials["clientSecret"] ?? "").trim();
  if (!id || !secret) {
    throw new Error(
      "MongoDB Atlas plugin: enter a service account client ID and secret, or an API key's public and private key",
    );
  }
  return id.startsWith(SERVICE_ACCOUNT_PREFIX)
    ? { kind: "service-account", clientId: id, clientSecret: secret }
    : { kind: "api-key", publicKey: id, privateKey: secret };
}

export function contextFromCredentials(
  credentials: Record<string, string>,
  http?: HttpHostServices,
): AtlasContext {
  const caCert = credentials["caCert"] ?? "";
  return {
    auth: authFromCredentials(credentials),
    baseUrl: DEFAULT_BASE_URL,
    ...(caCert ? { caCert } : {}),
    ...(http ? { http } : {}),
  };
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function header(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return "";
}

/**
 * One HTTP exchange. Goes through the host HTTP service whenever there is
 * one: that is the only path that honours bastion egress and a custom CA.
 */
async function send(
  ctx: AtlasContext,
  req: { url: string; method: string; headers: Record<string, string>; body?: string },
): Promise<RawResponse> {
  if (ctx.http) {
    const res = await ctx.http.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
    return { status: res.status, headers: res.headers ?? {}, body: res.body ?? "" };
  }
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body: await res.text() };
}

// ---------------------------------------------------------------------------
// Service account tokens
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const tokenInflight = new Map<string, Promise<string>>();

/** Clears cached tokens and digest challenges. Tests only. */
export function resetAuthCaches(): void {
  tokenCache.clear();
  tokenInflight.clear();
  digestCache.clear();
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function serviceAccountToken(
  ctx: AtlasContext,
  auth: Extract<AtlasAuth, { kind: "service-account" }>,
  forceRefresh = false,
): Promise<string> {
  const key = `${ctx.baseUrl}|${auth.clientId}|${md5Hex(auth.clientSecret)}`;
  const cached = tokenCache.get(key);
  // Refresh a minute early so a token never expires mid-request.
  if (!forceRefresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  const inflight = tokenInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await send(ctx, {
      url: `${ctx.baseUrl}/api/oauth/token`,
      method: "POST",
      headers: {
        Authorization: `Basic ${base64(`${auth.clientId}:${auth.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (res.status < 200 || res.status >= 300) {
      throw new AtlasApiError(
        res.status === 400 ? 401 : res.status,
        `MongoDB Atlas rejected the service account (HTTP ${res.status}): ${describeError(res.body)}`,
        "SERVICE_ACCOUNT_TOKEN",
      );
    }
    const parsed = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new AtlasApiError(0, "MongoDB Atlas returned no access token");
    tokenCache.set(key, {
      token: parsed.access_token,
      expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
    });
    return parsed.access_token;
  })().finally(() => tokenInflight.delete(key));
  tokenInflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Digest auth
// ---------------------------------------------------------------------------

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop: string;
  opaque?: string;
  algorithm: string;
  nc: number;
}

const digestCache = new Map<string, DigestChallenge>();

/** Parse a `WWW-Authenticate: Digest …` header. Returns undefined for anything else. */
export function parseDigestChallenge(value: string): DigestChallenge | undefined {
  const m = /^\s*Digest\s+(.*)$/i.exec(value);
  if (!m) return undefined;
  const params: Record<string, string> = {};
  const re = /([a-zA-Z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(m[1]!))) {
    params[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  if (!params["nonce"]) return undefined;
  const qops = (params["qop"] ?? "")
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean);
  return {
    realm: params["realm"] ?? "",
    nonce: params["nonce"],
    qop: qops.includes("auth") ? "auth" : (qops[0] ?? ""),
    ...(params["opaque"] ? { opaque: params["opaque"] } : {}),
    algorithm: params["algorithm"] ?? "MD5",
    nc: 0,
  };
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `Authorization: Digest …` value for one request (RFC 7616 MD5 / qop=auth). */
export function digestAuthorization(
  challenge: DigestChallenge,
  user: string,
  password: string,
  method: string,
  uri: string,
  cnonce = randomHex(8),
): string {
  challenge.nc += 1;
  const nc = challenge.nc.toString(16).padStart(8, "0");
  const ha1 = md5Hex(`${user}:${challenge.realm}:${password}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const response = challenge.qop
    ? md5Hex(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${challenge.qop}:${ha2}`)
    : md5Hex(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${challenge.algorithm}`,
    `response="${response}"`,
  ];
  if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function describeError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: string;
      reason?: string;
      errorCode?: string;
      error_description?: string;
    };
    return (
      parsed.detail ??
      parsed.error_description ??
      parsed.reason ??
      parsed.errorCode ??
      body
    ).slice(0, 500);
  } catch {
    return body.slice(0, 500);
  }
}

function errorCodeOf(body: string): string {
  try {
    return String((JSON.parse(body) as { errorCode?: string }).errorCode ?? "");
  } catch {
    return "";
  }
}

export interface AtlasRequestOptions {
  /** Media-type version of the endpoint, e.g. "2024-08-05". */
  version?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

function buildPath(path: string, query?: AtlasRequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

/**
 * Call one Admin API endpoint. `path` starts with `/api/atlas/v2/`. Returns
 * the parsed JSON body (undefined for an empty 2xx), throws
 * {@link AtlasApiError} otherwise.
 */
export async function atlasRequest<T>(
  ctx: AtlasContext,
  method: string,
  path: string,
  opts: AtlasRequestOptions = {},
): Promise<T> {
  const uri = buildPath(path, opts.query);
  const url = `${ctx.baseUrl}${uri}`;
  const mediaType = `application/vnd.atlas.${opts.version ?? DEFAULT_API_VERSION}+json`;
  const headers: Record<string, string> = { Accept: mediaType };
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (body !== undefined) headers["Content-Type"] = mediaType;

  let res: RawResponse;
  if (ctx.auth.kind === "service-account") {
    const auth = ctx.auth;
    headers["Authorization"] = `Bearer ${await serviceAccountToken(ctx, auth)}`;
    res = await send(ctx, { url, method, headers, ...(body !== undefined ? { body } : {}) });
    if (res.status === 401) {
      // A revoked or rotated token: mint one fresh token and try once more.
      headers["Authorization"] = `Bearer ${await serviceAccountToken(ctx, auth, true)}`;
      res = await send(ctx, { url, method, headers, ...(body !== undefined ? { body } : {}) });
    }
  } else {
    const { publicKey, privateKey } = ctx.auth;
    const cacheKey = `${ctx.baseUrl}|${publicKey}`;
    const cached = digestCache.get(cacheKey);
    if (cached)
      headers["Authorization"] = digestAuthorization(cached, publicKey, privateKey, method, uri);
    res = await send(ctx, { url, method, headers, ...(body !== undefined ? { body } : {}) });
    if (res.status === 401) {
      const challenge = parseDigestChallenge(header(res.headers, "www-authenticate"));
      if (challenge) {
        digestCache.set(cacheKey, challenge);
        headers["Authorization"] = digestAuthorization(
          challenge,
          publicKey,
          privateKey,
          method,
          uri,
        );
        res = await send(ctx, { url, method, headers, ...(body !== undefined ? { body } : {}) });
      }
    }
  }

  if (res.status < 200 || res.status >= 300) {
    throw new AtlasApiError(
      res.status,
      `MongoDB Atlas API error ${res.status} for ${method} ${path}: ${describeError(res.body)}`,
      errorCodeOf(res.body),
    );
  }
  if (!res.body) return undefined as T;
  return JSON.parse(res.body) as T;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 40;

/**
 * Walk a paginated list (`{ results, totalCount }`, `pageNum` from 1). Stops
 * on a short page, at `totalCount`, or after {@link MAX_PAGES} pages.
 */
export async function listAll<T>(
  ctx: AtlasContext,
  path: string,
  opts: Omit<AtlasRequestOptions, "body"> = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await atlasRequest<{ results?: T[]; totalCount?: number }>(ctx, "GET", path, {
      ...opts,
      query: { ...opts.query, itemsPerPage: PAGE_SIZE, pageNum: page },
    });
    const results = res?.results ?? [];
    out.push(...results);
    if (results.length < PAGE_SIZE) break;
    if (typeof res.totalCount === "number" && out.length >= res.totalCount) break;
  }
  return out;
}

export const enc = encodeURIComponent;

export interface AtlasOrg {
  id: string;
  name: string;
}

/** Every organization the credential can see (a service account sees its own). */
export async function listOrgs(ctx: AtlasContext): Promise<AtlasOrg[]> {
  const orgs = await listAll<{ id?: string; name?: string; isDeleted?: boolean }>(
    ctx,
    "/api/atlas/v2/orgs",
  );
  return orgs
    .filter((o): o is { id: string; name?: string } => typeof o.id === "string" && !o.isDeleted)
    .map((o) => ({ id: o.id, name: o.name ?? o.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
