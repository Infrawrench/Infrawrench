import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch, ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";

/**
 * Splunk Observability Cloud realms, from the realm index at
 * status.signalfx.com (2026-10). The API lives at
 * `https://api.<realm>.observability.splunkcloud.com/v2` (the published
 * reference's `servers` entry; the older `api.<realm>.signalfx.com` still
 * resolves), SignalFlow at `https://stream.<realm>.observability.splunkcloud.com/v2/signalflow`.
 */
export const REALMS: Array<{ id: string; label: string; location: string }> = [
  { id: "us0", label: "US0", location: "AWS us-east-1" },
  { id: "us1", label: "US1", location: "AWS us-west-2" },
  { id: "us2", label: "US2", location: "GCP us-west-1" },
  { id: "eu0", label: "EU0", location: "AWS eu-west-1" },
  { id: "eu1", label: "EU1", location: "AWS eu-central-1" },
  { id: "eu2", label: "EU2", location: "AWS eu-west-2" },
  { id: "jp0", label: "JP0", location: "AWS ap-northeast-1" },
  { id: "au0", label: "AU0", location: "AWS ap-southeast-2" },
  { id: "sg0", label: "SG0", location: "AWS ap-southeast-1" },
];

const VENDOR = "Splunk Observability";

export interface SplunkContext {
  realm: string;
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status callers branch on. */
export class SplunkApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SplunkApiError";
    this.status = status;
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export function withQuery(url: string, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}

export function normalizeRealm(raw: string): string {
  const r = raw.trim().toLowerCase();
  // Accept a pasted app URL (`https://app.us1.observability.splunkcloud.com`).
  const m = /(?:app|api|ingest|stream)\.([a-z]{2}\d)\./.exec(r);
  return m?.[1] ?? (r || "us0");
}

export function apiBase(ctx: SplunkContext): string {
  return `https://api.${ctx.realm}.observability.splunkcloud.com`;
}

export function appUrl(ctx: SplunkContext): string {
  return `https://app.${ctx.realm}.observability.splunkcloud.com`;
}

export function streamBase(ctx: SplunkContext): string {
  return `https://stream.${ctx.realm}.observability.splunkcloud.com`;
}

/** Splunk error bodies are `{ code, message }`. */
function friendly(status: number, message: string): string {
  const body = message.slice(message.indexOf(": ") + 2);
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return `Splunk Observability API error ${status}: ${parsed.message}`;
  } catch {
    // keep the raw text
  }
  return message;
}

/** A JSON call against the REST API with `X-SF-Token`. `path` includes `/v1` or `/v2`. */
export async function sfFetch<T>(
  ctx: SplunkContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor: VENDOR,
      url: withQuery(`${apiBase(ctx)}${path}`, query),
      errorPath: path,
      headers: { Accept: "application/json", "X-SF-Token": ctx.token },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);
    if (status) throw new SplunkApiError(status, friendly(status, message));
    throw err;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof SplunkApiError ? err.status : 0;
}

const PAGE = 1000;
/** Requests, not rows: 100,000 rows at the default page size. */
const MAX_PAGES = 100;
/**
 * Splunk answers at most 10,000 objects to one query however it is paged
 * ("Retrieve data basics"), so a list that ends there with a count above it is cut.
 */
const RESULT_CEILING = 10_000;

export interface OffsetListOptions<T> {
  page?: number;
  /** For a search sent as a POST. */
  init?: RequestInit;
  /**
   * For a route whose paging is not documented: a row seen twice means it ignored
   * the offset, and counting the same page again would read the rest as deleted.
   */
  idOf?: (row: T) => string | undefined;
}

/**
 * `limit`/`offset` listing whose answer is `{ count, results }`. The next offset is
 * what was read so far, and `count` decides the end, so a server that answers fewer
 * rows than asked is still read to the end.
 */
export async function offsetList<T>(
  ctx: SplunkContext,
  path: string,
  query: Query = {},
  options: OffsetListOptions<T> = {},
): Promise<T[]> {
  const page = options.page ?? PAGE;
  const out: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await sfFetch<{ count?: number; results?: T[] } | T[] | null>(ctx, path, {
      ...options.init,
      query: { ...query, limit: page, offset: out.length },
    });
    const items = Array.isArray(res)
      ? res
      : requireListPage(res?.results, { vendor: VENDOR, path, key: "results" });
    if (options.idOf) {
      for (const row of items) {
        const id = options.idOf(row);
        if (id === undefined) continue;
        if (seen.has(id))
          throw new Error(
            `${VENDOR}: ${path} answered ${id} on two pages, so it is not paging by offset. Refusing to read that as the whole list.`,
          );
        seen.add(id);
      }
    }
    out.push(...items);
    const total = Array.isArray(res) ? undefined : res?.count;
    if (total === undefined) {
      if (items.length < page) return out;
      continue;
    }
    if (out.length >= total) return out;
    if (items.length === 0) {
      if (out.length >= RESULT_CEILING)
        throw new ListTruncatedError({
          vendor: VENDOR,
          path,
          items: out.length,
          maxItems: RESULT_CEILING,
        });
      return out;
    }
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages: MAX_PAGES });
}
