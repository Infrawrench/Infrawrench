import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import type { HoneycombRegion } from "./regions.js";

/**
 * Everything a Honeycomb request needs. Honeycomb has two kinds of key with
 * two API generations:
 *
 * - **Configuration keys** (`X-Honeycomb-Team: <token>`) are scoped to one
 *   environment and drive every `/1/...` route: datasets, columns, triggers,
 *   SLOs, boards, markers, recipients and queries.
 * - **Management keys** (`Authorization: Bearer <keyId>:<secret>`) are scoped
 *   to the team and drive the `/2/teams/{team}/...` routes: environments and
 *   API keys. They cannot read anything inside an environment.
 */
export interface HoneycombContext {
  region: HoneycombRegion;
  /** `keyId:secret`, when the account has a management key. */
  managementToken?: string;
  caCert?: string;
  http?: HttpHostServices;
}

/** Thrown for any non-2xx answer, carrying the status the callers branch on. */
export class HoneycombApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HoneycombApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Honeycomb API error (\d{3})/;

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`;
}

/** Pull Honeycomb's own error text out of a v1 `{error}` or v2 JSON:API body. */
function honeycombMessage(raw: string, path: string): string {
  const prefix = `for ${path}: `;
  const i = raw.indexOf(prefix);
  const body = i >= 0 ? raw.slice(i + prefix.length) : raw;
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      title?: string;
      errors?: Array<{ title?: string; detail?: string }>;
      type_detail?: Array<{ field?: string; description?: string }>;
    };
    const details = (parsed.type_detail ?? [])
      .map((d) => [d.field, d.description].filter(Boolean).join(": "))
      .filter(Boolean);
    if (details.length > 0) return details.join("; ");
    if (parsed.errors?.length) {
      return parsed.errors
        .map((e) => e.detail || e.title || "")
        .filter(Boolean)
        .join("; ");
    }
    return parsed.error ?? parsed.title ?? body;
  } catch {
    return body;
  }
}

async function request<T>(
  ctx: HoneycombContext,
  path: string,
  headers: Record<string, string>,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  const fullPath = withQuery(path, query);
  try {
    return await jsonRestFetch<T>({
      vendor: "Honeycomb",
      url: `${ctx.region.apiUrl}${fullPath}`,
      errorPath: path,
      headers,
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) {
      throw new HoneycombApiError(
        status,
        `Honeycomb API error ${status} for ${path}: ${honeycombMessage(message, path)}`,
      );
    }
    throw err;
  }
}

/** A `/1/...` call with an environment's configuration key. */
export function v1<T>(
  ctx: HoneycombContext,
  key: string,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  return request<T>(ctx, path, { Accept: "application/json", "X-Honeycomb-Team": key }, init);
}

/** A `/2/...` call with the team's management key (JSON:API bodies). */
export function v2<T>(
  ctx: HoneycombContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  if (!ctx.managementToken) {
    throw new HoneycombApiError(
      401,
      "This account has no Honeycomb management key. Edit the account's credentials and add one to manage environments and API keys.",
    );
  }
  return request<T>(
    ctx,
    path,
    {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${ctx.managementToken}`,
    },
    init,
  );
}

export interface JsonApiResource<A> {
  id: string;
  type?: string;
  attributes?: A;
  relationships?: Record<string, { data?: { id?: string; type?: string } | null }>;
  links?: { self?: string };
}

/**
 * Page through a v2 list. Pagination is a cursor: `links.next` is a
 * ready-made relative URL (with `page[after]`), or null on the last page.
 */
export async function v2Paged<A>(
  ctx: HoneycombContext,
  path: string,
  query: Query = {},
  maxPages = 50,
): Promise<Array<JsonApiResource<A>>> {
  const out: Array<JsonApiResource<A>> = [];
  let next: string | null = withQuery(path, { "page[size]": 100, ...query });
  for (let page = 0; page < maxPages && next; page++) {
    const res: { data?: Array<JsonApiResource<A>>; links?: { next?: string | null } } = await v2(
      ctx,
      next,
    );
    out.push(...(res.data ?? []));
    const link = res.links?.next ?? null;
    next = link ? relativePath(link) : null;
  }
  return out;
}

function relativePath(link: string): string {
  if (link.startsWith("/")) return link;
  try {
    const u = new URL(link);
    return `${u.pathname}${u.search}`;
  } catch {
    return link;
  }
}

/** HTTP status of a failed call, or 0 for a transport error. */
export function statusOf(err: unknown): number {
  return err instanceof HoneycombApiError ? err.status : 0;
}

/** Path segment for a dataset slug (`__all__` for environment-wide routes). */
export function ds(slug: string): string {
  return encodeURIComponent(slug);
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
