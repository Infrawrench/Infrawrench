import type { HttpHostServices } from "@infrawrench/plugin-base";
import { ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";

export const API = "https://api.doppler.com";
const VENDOR = "Doppler";

/** Everything one Doppler API request needs. */
export interface DopplerContext {
  token: string;
  http?: HttpHostServices;
}

export class DopplerApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DopplerApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof DopplerApiError ? err.status : 0;
}

/** What kind of token the user pasted, from Doppler's documented prefixes. */
export function tokenKind(
  token: string,
): "personal" | "service-account" | "cli" | "service" | "scim" | "audit" | "unknown" {
  if (token.startsWith("dp.pt.")) return "personal";
  if (token.startsWith("dp.sa.")) return "service-account";
  if (token.startsWith("dp.ct.")) return "cli";
  if (token.startsWith("dp.st.")) return "service";
  if (token.startsWith("dp.scim.")) return "scim";
  if (token.startsWith("dp.audit.")) return "audit";
  return "unknown";
}

/** Doppler errors are `{"messages": ["…"], "success": false}`. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { messages?: unknown[]; message?: unknown };
    const msgs = (parsed.messages ?? []).map(String).filter(Boolean);
    if (msgs.length) return msgs.join("; ");
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 500);
}

export type Query = Record<string, string | number | boolean | undefined>;

function buildQuery(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** One Bearer-authenticated call, through the host HTTP service when there is one. */
export async function dopplerFetch<T>(
  ctx: DopplerContext,
  path: string,
  opts: { method?: string; query?: Query; body?: unknown } = {},
): Promise<T> {
  const url = `${API}${path}${buildQuery(opts.query)}`;
  const method = opts.method ?? "GET";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${ctx.token}`,
    ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
  };
  let status: number;
  let text: string;
  if (ctx.http) {
    const res = await ctx.http.request({
      url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    status = res.status;
    text = res.body;
  } else {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    status = res.status;
    text = await res.text();
  }
  if (status < 200 || status >= 300) {
    throw new DopplerApiError(
      status,
      `Doppler API error ${status} for ${path}: ${errorDetail(text)}`,
    );
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** A list answered whole, which refuses an answer without one rather than read it as empty. */
export async function dopplerList<T>(
  ctx: DopplerContext,
  path: string,
  key: string,
  query: Query = {},
): Promise<T[]> {
  const page = await dopplerFetch<Record<string, T[] | null | undefined> | undefined>(ctx, path, {
    query,
  });
  return requireListPage(page?.[key], { vendor: VENDOR, path, key, page });
}

/**
 * Every page of a `page`/`per_page` list. Doppler returns no total or next
 * link, so a short page ends the walk. Past `maxPages` it throws, since a sync
 * prunes whatever a list stops returning.
 */
export async function dopplerPaged<T>(
  ctx: DopplerContext,
  path: string,
  key: string,
  query: Query = {},
  /** 10,000 rows. The document gives no maximum `per_page`, so this keeps the 100 it always sent. */
  maxPages = 100,
  /** 0 for endpoints without `per_page` (workplace users): then only an empty page ends the walk. */
  perPage = 100,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await dopplerList<T>(ctx, path, key, {
      ...query,
      page,
      ...(perPage ? { per_page: perPage } : {}),
    });
    out.push(...items);
    if (perPage ? items.length < perPage : items.length === 0) return out;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}
