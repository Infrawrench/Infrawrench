import type { HttpHostServices } from "@infrawrench/plugin-base";
import { utf8ToBase64 } from "@infrawrench/plugin-base";

/**
 * Backblaze B2 Native API transport (API version 4, the current one since
 * 2025-04-24; https://www.backblaze.com/apidocs, verified 2026-10).
 *
 * `b2_authorize_account` takes HTTP Basic auth with `applicationKeyId:
 * applicationKey` against the fixed host `api.backblazeb2.com` and answers
 * with an account token (valid for 24 hours) plus the cluster-specific
 * `apiUrl`, `downloadUrl` and `s3ApiUrl` every later call has to use. Every
 * other call carries that token verbatim in `Authorization` (no scheme).
 * Errors are JSON `{status, code, message}`.
 */

export const AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v4/b2_authorize_account";
export const API_VERSION_PATH = "/b2api/v4";

export interface B2Context {
  keyId: string;
  key: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer; `status` is what the poller classifies on. */
export class B2ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "B2ApiError";
    this.status = status;
    this.code = code;
  }
}

export function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    return typeof s === "number" ? s : 0;
  }
  return 0;
}

export interface RawRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  binary?: boolean;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody?: Uint8Array;
}

/**
 * One HTTP exchange, through the host HTTP service whenever there is one (the
 * only path that honours bastion egress and a custom CA), else `fetch`.
 */
export async function send(ctx: B2Context, req: RawRequest): Promise<RawResponse> {
  if (ctx.http) {
    const res = await ctx.http.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(req.binary ? { responseEncoding: "binary" as const } : {}),
    });
    return res;
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
  if (req.binary) {
    return {
      status: res.status,
      headers,
      body: "",
      rawBody: new Uint8Array(await res.arrayBuffer()),
    };
  }
  return { status: res.status, headers, body: await res.text() };
}

/** Turn a B2 error body into a thrown {@link B2ApiError}. */
export function b2Error(status: number, body: string, label: string): B2ApiError {
  let code = "";
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    code = parsed.code ?? "";
    if (parsed.message) message = parsed.message;
  } catch {
    // not JSON
  }
  return new B2ApiError(
    status,
    code,
    `Backblaze B2 API error ${status}${code ? ` (${code})` : ""} for ${label}: ${message}`,
  );
}

export interface B2AuthorizeResponse {
  accountId: string;
  authorizationToken: string;
  applicationKeyExpirationTimestamp?: number | null;
  apiInfo?: {
    storageApi?: {
      apiUrl?: string;
      downloadUrl?: string;
      s3ApiUrl?: string;
      recommendedPartSize?: number;
      absoluteMinimumPartSize?: number;
      allowed?: {
        buckets?: Array<{ id?: string; name?: string | null }> | null;
        capabilities?: string[];
        namePrefix?: string | null;
      };
    };
  };
}

export interface B2Session {
  accountId: string;
  token: string;
  apiUrl: string;
  downloadUrl: string;
  s3ApiUrl: string;
  capabilities: string[];
  /** Buckets the key is restricted to; null for an all-buckets key. */
  allowedBuckets: Array<{ id: string; name: string }> | null;
  namePrefix: string;
  keyExpiresAt?: number;
  obtainedAt: number;
}

/** Session lifetime we trust: B2 tokens last 24 hours, refresh well before. */
const SESSION_TTL_MS = 20 * 60 * 60 * 1000;

export function sessionFrom(res: B2AuthorizeResponse, now = Date.now()): B2Session {
  const storage = res.apiInfo?.storageApi ?? {};
  const allowed = storage.allowed ?? {};
  const buckets = allowed.buckets ?? null;
  return {
    accountId: res.accountId,
    token: res.authorizationToken,
    apiUrl: (storage.apiUrl ?? "").replace(/\/+$/, ""),
    downloadUrl: (storage.downloadUrl ?? "").replace(/\/+$/, ""),
    s3ApiUrl: (storage.s3ApiUrl ?? "").replace(/\/+$/, ""),
    capabilities: allowed.capabilities ?? [],
    allowedBuckets:
      buckets && buckets.length > 0
        ? buckets
            .filter((b): b is { id: string; name: string | null } => typeof b?.id === "string")
            .map((b) => ({ id: b.id, name: b.name ?? "" }))
        : null,
    namePrefix: allowed.namePrefix ?? "",
    ...(res.applicationKeyExpirationTimestamp
      ? { keyExpiresAt: res.applicationKeyExpirationTimestamp }
      : {}),
    obtainedAt: now,
  };
}

/** `https://s3.us-west-004.backblazeb2.com` → `us-west-004`. */
export function s3RegionOf(s3ApiUrl: string): string {
  const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(s3ApiUrl);
  return m?.[1]?.toLowerCase() ?? "";
}

/**
 * `us-west-004` → `us-west`: the region the status page names ("US West
 * Region"). The numeric suffix is the cluster, which the status page does not
 * break out.
 */
export function coarseRegionOf(s3Region: string): string {
  return s3Region.replace(/-\d+$/, "");
}

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(url: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * A B2 Native API client bound to one application key. Authorizes lazily,
 * caches the session, and re-authorizes once when a call reports the token
 * expired.
 */
export class B2Api {
  private session: B2Session | undefined;
  private inflight: Promise<B2Session> | undefined;

  constructor(readonly ctx: B2Context) {}

  async getSession(): Promise<B2Session> {
    if (this.session && Date.now() - this.session.obtainedAt < SESSION_TTL_MS) {
      return this.session;
    }
    this.inflight ??= this.authorize().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async authorize(): Promise<B2Session> {
    const res = await send(this.ctx, {
      url: AUTHORIZE_URL,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${utf8ToBase64(`${this.ctx.keyId}:${this.ctx.key}`)}`,
      },
    });
    if (res.status < 200 || res.status >= 300) {
      throw b2Error(res.status, res.body, "b2_authorize_account");
    }
    const session = sessionFrom(JSON.parse(res.body) as B2AuthorizeResponse);
    if (!session.apiUrl) {
      throw new B2ApiError(502, "no_api_url", "Backblaze B2 returned no API URL for this key.");
    }
    this.session = session;
    return session;
  }

  /** Forget the session so the next call re-authorizes. */
  invalidate(): void {
    this.session = undefined;
  }

  /**
   * Call one `b2_*` operation. POST sends `body` as JSON; GET sends `query`.
   */
  async call<T>(
    op: string,
    opts: { method?: "GET" | "POST"; body?: unknown; query?: Query } = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.getSession();
      const method = opts.method ?? "POST";
      const url = withQuery(`${s.apiUrl}${API_VERSION_PATH}/${op}`, opts.query);
      const res = await send(this.ctx, {
        url,
        method,
        headers: {
          Accept: "application/json",
          Authorization: s.token,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
      });
      if (
        res.status === 401 &&
        attempt === 0 &&
        /expired_auth_token|bad_auth_token/.test(res.body)
      ) {
        this.invalidate();
        continue;
      }
      if (res.status < 200 || res.status >= 300) throw b2Error(res.status, res.body, op);
      return (res.body ? JSON.parse(res.body) : undefined) as T;
    }
    throw new B2ApiError(401, "expired_auth_token", `Backblaze B2: could not re-authorize ${op}`);
  }

  /** A request against an arbitrary B2 URL (download host, upload URL). */
  async raw(req: RawRequest, label: string): Promise<RawResponse> {
    const res = await send(this.ctx, req);
    if (res.status < 200 || res.status >= 300) throw b2Error(res.status, res.body, label);
    return res;
  }
}
