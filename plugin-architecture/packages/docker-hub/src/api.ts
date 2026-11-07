import {
  createApiClient,
  restRequest,
  type ApiBody,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

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
    const parsed: { detail?: unknown; message?: unknown } = JSON.parse(body);
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

/**
 * The token exchange. Documented, but kept off the typed client: it is what the
 * client's headers need, carries no bearer, and has its own failure message.
 */
async function exchange(ctx: HubContext): Promise<string> {
  const credentials: ApiBody<operations["AuthCreateAccessToken"]> = {
    identifier: ctx.identifier,
    secret: ctx.secret,
  };
  const res = await rawRequest(
    ctx.http,
    `${HUB}/v2/auth/token`,
    "POST",
    { "Content-Type": "application/json", Accept: "application/json" },
    JSON.stringify(credentials),
  );
  if (res.status < 200 || res.status >= 300) {
    throw new HubApiError(
      res.status,
      `Docker Hub rejected the credentials (${res.status}): ${errorDetail(res.text)}. Check the username (or organization name for an organization access token) and the token.`,
    );
  }
  const answer: ApiResponse<operations["AuthCreateAccessToken"]> = JSON.parse(res.text);
  const token = answer.access_token;
  if (!token) throw new HubApiError(500, "Docker Hub returned no access token");
  // The JWT lives ten minutes; refresh a minute early.
  ctx.jwt = { token, until: Date.now() + 9 * 60_000 };
  return token;
}

async function bearer(ctx: HubContext): Promise<string> {
  if (ctx.jwt && ctx.jwt.until > Date.now()) return ctx.jwt.token;
  return exchange(ctx);
}

const authHeaders = async (ctx: HubContext) => ({
  Accept: "application/json",
  Authorization: `Bearer ${await bearer(ctx)}`,
});

function apiError(status: number, path: string, body: string): HubApiError {
  return new HubApiError(
    status,
    `Docker Hub API error ${status} for ${path}: ${errorDetail(body)}`,
  );
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host service or `fetch`, whichever {@link rawRequest} picks, with what Docker
 * Hub's calls have always had around it: a 401 drops the cached JWT and retries
 * once (the token may have expired mid-pass), and a 2xx whose body is not JSON
 * reads as that text rather than failing, which `restRequest` would otherwise do.
 */
function hubTransport(ctx: HubContext): HttpHostServices {
  return {
    async request({ url, method, headers, body: sent }) {
      // Every body here is JSON text; the interface also allows bytes.
      const body = typeof sent === "string" ? sent : undefined;
      let res = await rawRequest(ctx.http, url, method, headers, body);
      if (res.status === 401) {
        delete ctx.jwt;
        res = await rawRequest(
          ctx.http,
          url,
          method,
          { ...headers, Authorization: `Bearer ${await bearer(ctx)}` },
          body,
        );
      }
      const ok = res.status >= 200 && res.status < 300;
      return {
        // `restRequest` drops the body of a 204, and these calls read one if it comes.
        status: res.status === 204 ? 200 : res.status,
        headers: res.headers,
        body: ok && res.text && !isJson(res.text) ? JSON.stringify(res.text) : res.text,
      };
    },
  };
}

export type HubApi = ApiClient<paths>;

/** Docker Hub, typed from its document (`plugingen.json`). */
export function hubApi(ctx: HubContext): HubApi {
  return createApiClient<paths>({
    vendor: "Docker Hub",
    baseUrl: HUB,
    headers: () => authHeaders(ctx),
    http: hubTransport(ctx),
    contentType: "with-body",
    httpError: ({ status, path, body }) => apiError(status, path, body),
  });
}

/** What every list asks for on its first page. */
export const FIRST_PAGE = { query: { page_size: 100 } };

/** One page of a `{results, next}` list. */
export interface HubPage<Row> {
  results?: Row[];
  next?: string | null;
}

/**
 * A next link as Docker Hub wrote it, absolute on the real service. The parameter
 * is `path` because a `next` that is not text fails right here, and that is the
 * message a failed sync has always carried.
 */
async function followLink<Row>(ctx: HubContext, path: string): Promise<HubPage<Row> | undefined> {
  const absolute = path.startsWith("http");
  const { body } = await restRequest<HubPage<Row> | undefined>({
    vendor: "Docker Hub",
    url: absolute ? path : `${HUB}${path}`,
    headers: await authHeaders(ctx),
    http: hubTransport(ctx),
    contentType: "with-body",
    httpError: ({ status, body: text }) =>
      apiError(status, absolute ? new URL(path).pathname : path, text),
  });
  return body;
}

/**
 * Every page of a `{results, next}` list from its first page, bounded so a looping
 * `next` cannot spin forever.
 *
 * This is a hand loop rather than `withLinkPagination` because that reads a
 * `results` that is not an array as an empty page, and the host prunes what a sync
 * stops seeing. Here it fails the sync, as it always has.
 */
export async function hubPaged<Row>(
  ctx: HubContext,
  first: () => Promise<HubPage<Row> | undefined>,
  maxPages = 20,
): Promise<Row[]> {
  const out: Row[] = [];
  let res = await first();
  for (let page = 0; ; page++) {
    out.push(...(res?.results ?? []));
    const next = res?.next;
    if (!next || page + 1 >= maxPages) break;
    res = await followLink<Row>(ctx, next);
  }
  return out;
}

/**
 * Like {@link hubPaged}, but every page or nothing: running past `maxPages`
 * throws instead of truncating, because a reader that stores the result as
 * the complete set (the seat inventory) must never see a partial list.
 */
export async function hubPagedAll<Row>(
  ctx: HubContext,
  /** Names the list in the error. */
  path: string,
  first: () => Promise<HubPage<Row> | undefined>,
  maxPages = 500,
): Promise<Row[]> {
  const out: Row[] = [];
  let res = await first();
  for (let page = 1; ; page++) {
    out.push(...(res?.results ?? []));
    const next = res?.next;
    if (!next) return out;
    if (page >= maxPages)
      throw new HubApiError(
        500,
        `Docker Hub plugin: ${path} has more than ${maxPages} pages; refusing to return a partial list`,
      );
    res = await followLink<Row>(ctx, next);
  }
}
