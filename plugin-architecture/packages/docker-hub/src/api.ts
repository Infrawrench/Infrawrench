import type { HttpHostServices } from "@infrawrench/plugin-base";

export const HUB = "https://hub.docker.com";

/**
 * Everything a Docker Hub API request needs. Split out of the client so the
 * credential-option loader and the tests can run without one.
 *
 * Docker Hub does not take the user's PAT/OAT as a bearer directly: it is
 * exchanged at `POST /v2/auth/token` (`{identifier, secret}`) for a JWT that
 * lives ten minutes. The context caches that JWT and re-exchanges on expiry or
 * on a 401.
 */
export interface HubContext {
  /** Docker ID (PAT or password) or organization name (OAT). */
  identifier: string;
  secret: string;
  http?: HttpHostServices;
  /** Cached bearer and when to stop trusting it (ms since epoch). */
  jwt?: { token: string; until: number };
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class HubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HubApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof HubApiError ? err.status : 0;
}

/** What kind of secret the user pasted, from its documented prefix. */
export function secretKind(secret: string): "pat" | "oat" | "password" {
  if (secret.startsWith("dckr_oat_")) return "oat";
  if (secret.startsWith("dckr_pat_")) return "pat";
  return "password";
}

export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown; errinfo?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return parsed.message;
    if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 500);
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** One raw HTTP call through the host service (bastion, CA) or `fetch`. */
export async function rawRequest(
  http: HttpHostServices | undefined,
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  if (http) {
    const res = await http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
    return { status: res.status, headers: lower, text: res.body };
  }
  const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
  const lower: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    lower[k.toLowerCase()] = v;
  });
  return { status: res.status, headers: lower, text: await res.text() };
}

async function exchange(ctx: HubContext): Promise<string> {
  const res = await rawRequest(
    ctx.http,
    `${HUB}/v2/auth/token`,
    "POST",
    { "Content-Type": "application/json", Accept: "application/json" },
    JSON.stringify({ identifier: ctx.identifier, secret: ctx.secret }),
  );
  if (res.status < 200 || res.status >= 300) {
    throw new HubApiError(
      res.status,
      `Docker Hub rejected the credentials (${res.status}): ${errorDetail(res.text)}. Check the username (or organization name for an organization access token) and the token.`,
    );
  }
  const token = (JSON.parse(res.text) as { access_token?: string }).access_token;
  if (!token) throw new HubApiError(500, "Docker Hub returned no access token");
  // The JWT lives ten minutes; refresh a minute early.
  ctx.jwt = { token, until: Date.now() + 9 * 60_000 };
  return token;
}

async function bearer(ctx: HubContext): Promise<string> {
  if (ctx.jwt && ctx.jwt.until > Date.now()) return ctx.jwt.token;
  return exchange(ctx);
}

export type Query = Record<string, string | number | boolean | undefined>;

export function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * One authenticated Hub call. `path` is relative to `https://hub.docker.com`
 * or an absolute `next` URL from a paged response. A 401 drops the cached JWT
 * and retries once (the token may have expired mid-pass).
 */
export async function hubFetch<T>(
  ctx: HubContext,
  path: string,
  opts: { method?: string; query?: Query; body?: unknown } = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${HUB}${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const send = async () =>
    rawRequest(
      ctx.http,
      url,
      method,
      {
        Accept: "application/json",
        Authorization: `Bearer ${await bearer(ctx)}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body,
    );
  let res = await send();
  if (res.status === 401) {
    delete ctx.jwt;
    res = await send();
  }
  if (res.status < 200 || res.status >= 300) {
    const short = path.startsWith("http") ? new URL(path).pathname : path;
    throw new HubApiError(
      res.status,
      `Docker Hub API error ${res.status} for ${short}: ${errorDetail(res.text)}`,
    );
  }
  if (!res.text) return undefined as T;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return res.text as unknown as T;
  }
}

/** Every page of a `{results, next}` list, bounded so a looping `next` cannot spin forever. */
export async function hubPaged<T>(
  ctx: HubContext,
  path: string,
  query: Query = {},
  maxPages = 20,
): Promise<T[]> {
  const out: T[] = [];
  let res = await hubFetch<{ results?: T[]; next?: string | null }>(ctx, path, {
    query: { page_size: 100, ...query },
  });
  for (let page = 0; ; page++) {
    out.push(...(res?.results ?? []));
    const next = res?.next;
    if (!next || page + 1 >= maxPages) break;
    res = await hubFetch(ctx, next);
  }
  return out;
}
