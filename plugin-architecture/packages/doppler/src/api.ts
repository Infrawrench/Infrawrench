import type { HttpHostServices } from "@infrawrench/plugin-base";

export const API = "https://api.doppler.com";

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

/**
 * Every page of a `page`/`per_page` list. Doppler returns no total or next
 * link, so a short page ends the walk; bounded so a misbehaving server cannot
 * spin forever.
 */
export async function dopplerPaged<T>(
  ctx: DopplerContext,
  path: string,
  key: string,
  query: Query = {},
  maxPages = 20,
  /** 0 for endpoints without `per_page` (workplace users): then only an empty page ends the walk. */
  perPage = 100,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await dopplerFetch<Record<string, unknown>>(ctx, path, {
      query: { ...query, page, ...(perPage ? { per_page: perPage } : {}) },
    });
    const items = Array.isArray(res?.[key]) ? (res[key] as T[]) : [];
    out.push(...items);
    if (perPage ? items.length < perPage : items.length === 0) break;
  }
  return out;
}
