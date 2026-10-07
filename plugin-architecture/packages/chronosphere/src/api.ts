import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Chronosphere (now Cortex XCOR) tenant APIs. Everything lives on the
 * tenant's own host, `https://<org>.chronosphere.io`:
 *
 * - Config API v1, `/api/v1/config/<plural>`: list with `page.max_size` and
 *   `page.token` answering `{ page: { next_token }, <plural_snake>: [...] }`;
 *   read `GET /<plural>/{slug}` answering `{ <singular>: {...} }`; create
 *   `POST` and update `PUT /{slug}` with `{ <singular>: {...} }`. Verified
 *   against the swagger the official Terraform provider vendors
 *   (`chronosphere/pkg/configv1/swagger.json`, v1.38.0, 2026-10).
 * - Prometheus API, `/data/metrics/api/v1/query` and `query_range`.
 *
 * Auth is the `API-Token` header (the docs also accept `Authorization:
 * Bearer`), with a service account or personal access token.
 */
export interface ChronoContext {
  baseUrl: string;
  org: string;
  token: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class ChronoApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChronoApiError";
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

/** `acme`, `acme.chronosphere.io` or `https://acme.chronosphere.io/...` → `acme`. */
export function normalizeOrg(raw: string): string {
  let r = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  r = r.split("/")[0] ?? "";
  return r.replace(/\.chronosphere\.io$/, "");
}

/** Chronosphere errors are `{ code, message }` (gRPC gateway style). */
function friendly(status: number, message: string): string {
  const body = message.slice(message.indexOf(": ") + 2);
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return `Chronosphere API error ${status}: ${parsed.message}`;
  } catch {
    // keep raw
  }
  return message;
}

export async function chronoFetch<T>(
  ctx: ChronoContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor: "Chronosphere",
      url: withQuery(`${ctx.baseUrl}${path}`, query),
      errorPath: path,
      headers: { Accept: "application/json", "API-Token": ctx.token },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);
    if (status) throw new ChronoApiError(status, friendly(status, message));
    throw err;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof ChronoApiError ? err.status : 0;
}

const MAX_PAGES = 30;

/** Walk a config list. `listKey` is the snake_case plural in the answer. */
export async function listConfig<T>(
  ctx: ChronoContext,
  plural: string,
  listKey: string,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await chronoFetch<Record<string, unknown>>(ctx, `/api/v1/config/${plural}`, {
      query: { "page.max_size": 500, ...(token ? { "page.token": token } : {}) },
    });
    const items = res?.[listKey];
    if (Array.isArray(items)) out.push(...(items as T[]));
    const page = res?.["page"] as { next_token?: string } | undefined;
    token = page?.next_token || undefined;
    if (!token) break;
  }
  return out;
}
