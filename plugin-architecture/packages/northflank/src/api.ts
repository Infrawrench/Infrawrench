import type { HttpHostServices } from "@infrawrench/plugin-base";
import {
  jsonRestFetch,
  ListPageError,
  ListTruncatedError,
  requireListPage,
} from "@infrawrench/plugin-base";

/**
 * Northflank REST API (`https://api.northflank.com/v1`, OpenAPI document at
 * `/v1/swagger-json`; verified 2026-10).
 *
 * Auth is `Authorization: Bearer <API token>`. A token belongs either to a
 * team or to an organisation (`GET /v1/auth` says which). Team-scoped
 * endpoints accept an optional `/v1/teams/{teamId}` prefix, which is how an
 * organisation token reaches one of its teams; a team token simply omits it.
 *
 * Errors come back as `{ "error": { "status", "message", "details"? } }`.
 * The default limit is 1000 requests per hour per account, reported in the
 * `x-ratelimit-*` headers and answered with 429.
 */
export const NORTHFLANK_API = "https://api.northflank.com";

export interface NorthflankContext {
  token: string;
  /** Team id (slug) an organisation token acts for; empty for team tokens. */
  teamId?: string;
  /** PEM trust anchor for TLS-intercepting proxies; needs `http`. */
  caCert?: string;
  http?: HttpHostServices;
  /** Overridable for tests; production always uses {@link NORTHFLANK_API}. */
  baseUrl?: string;
}

/** Thrown for any non-2xx answer, carrying the status the poller classifies on. */
export class NorthflankApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NorthflankApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Northflank API error (\d{3})/;

export type Query = Record<string, string | number | boolean | string[] | undefined>;

export function buildQuery(query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Prefix a `/v1/...` path with the team segment when the account acts for a
 * team through an organisation token. `teamScoped: false` is for the few
 * endpoints that have no team variant (`/v1/auth`, `/v1/plans`, …).
 */
export function scopedPath(ctx: NorthflankContext, path: string, teamScoped = true): string {
  if (!teamScoped || !ctx.teamId) return path;
  return path.replace(/^\/v1\//, `/v1/teams/${encodeURIComponent(ctx.teamId)}/`);
}

/** JSON request against the Northflank API, routed through the host when present. */
export async function nfFetch<T>(
  ctx: NorthflankContext,
  method: string,
  path: string,
  options: { body?: unknown; query?: Query; teamScoped?: boolean } = {},
): Promise<T> {
  const fullPath = scopedPath(ctx, path, options.teamScoped ?? true);
  try {
    return await jsonRestFetch<T>({
      vendor: "Northflank",
      url: `${ctx.baseUrl ?? NORTHFLANK_API}${fullPath}${buildQuery(options.query)}`,
      errorPath: fullPath,
      headers: { Accept: "application/json", Authorization: `Bearer ${ctx.token}` },
      init: {
        method,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      ...(ctx.http ? { http: ctx.http } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) throw new NorthflankApiError(status, friendlyError(status, message));
    throw err;
  }
}

/** Pull Northflank's own `error.message` (and field details) out of an error body. */
export function friendlyError(status: number, raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: string; details?: unknown };
      };
      const msg = parsed.error?.message;
      if (msg) {
        const details = describeDetails(parsed.error?.details);
        if (status === 401) {
          return `Northflank API error 401: ${msg}. Check the API token, and that it has not expired or been revoked.`;
        }
        if (status === 403) {
          return `Northflank API error 403: ${msg}. The token's API role does not grant this permission.`;
        }
        return `Northflank API error ${status}: ${msg}${details ? ` (${details})` : ""}`;
      }
    } catch {
      /* not JSON: keep the raw message */
    }
  }
  if (status === 429) {
    return "Northflank API error 429: the account's API rate limit (1000 requests an hour by default) is exhausted; it resets within the hour.";
  }
  return raw;
}

function describeDetails(details: unknown): string {
  if (!details || typeof details !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (Array.isArray(value)) parts.push(`${key}: ${value.map(String).join(", ")}`);
    else if (typeof value === "string") parts.push(`${key}: ${value}`);
  }
  return parts.slice(0, 3).join("; ");
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof NorthflankApiError ? err.status : 0;
}

export interface NfPagination {
  hasNextPage?: boolean;
  cursor?: string;
  count?: number;
}

export interface NfPage<T> {
  data: T;
  pagination?: NfPagination;
}

/**
 * Pages a list reads before it throws: 10,000 rows at the documented maximum of 100 a
 * page. Northflank's default allowance is 1000 requests an hour, so a longer list could
 * not be read in one poll anyway.
 */
export const NF_LIST_MAX_PAGES = 100;
export const NF_PAGE_SIZE = 100;

/**
 * The cursor to ask for next, `undefined` at the end, or a {@link ListPageError} for a page
 * that says there is more and gives no way to ask for it. Every listing documents
 * `pagination.hasNextPage` as required and `cursor` as optional.
 */
export function nextCursor(
  pagination: NfPagination | undefined,
  where: { vendor: string; path: string; key: string | null; page: unknown },
): string | undefined {
  if (!pagination?.hasNextPage) return undefined;
  if (pagination.cursor) return pagination.cursor;
  throw new ListPageError({ ...where, found: undefined, saysMoreWith: "no cursor" });
}

/**
 * Walk a cursor-paginated listing whose rows are at `data[key]`, or are `data` itself when
 * `key` is `null` (volumes). `alsoKey` reads a second documented or historical shape:
 * the volumes listing is documented as an array and has been answered as `{ volumes }`.
 *
 * A page whose list is missing throws, and so does a list longer than `maxPages`, unless
 * `partial` says part of it is fine (pickers, a detail view's rows).
 */
export async function nfList<T>(
  ctx: NorthflankContext,
  path: string,
  key: string | null,
  options: {
    query?: Query;
    maxPages?: number;
    teamScoped?: boolean;
    partial?: boolean;
    alsoKey?: string;
  } = {},
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  const maxPages = options.maxPages ?? NF_LIST_MAX_PAGES;
  const where = { vendor: "Northflank", path, key };
  for (let page = 0; page < maxPages; page++) {
    const res = await nfFetch<NfPage<T[] | Record<string, T[] | null | undefined>> | null>(
      ctx,
      "GET",
      path,
      {
        query: { per_page: NF_PAGE_SIZE, ...options.query, ...(cursor ? { cursor } : {}) },
        ...(options.teamScoped !== undefined ? { teamScoped: options.teamScoped } : {}),
      },
    );
    out.push(...requireListPage(listIn(res?.data, key, options.alsoKey), { ...where, page: res }));
    cursor = nextCursor(res?.pagination, { ...where, page: res });
    if (!cursor) return out;
  }
  if (options.partial) return out;
  throw new ListTruncatedError({ ...where, items: out.length, maxPages });
}

function listIn<T>(
  data: T[] | Record<string, T[] | null | undefined> | undefined,
  key: string | null,
  alsoKey: string | undefined,
): readonly T[] | null | undefined {
  if (Array.isArray(data)) return key === null ? data : undefined;
  if (data === undefined || data === null) return undefined;
  const primary = key === null ? undefined : data[key];
  if (primary !== undefined || alsoKey === undefined) return primary;
  return data[alsoKey];
}
