import {
  createApiClient,
  restRequest,
  type ApiClient,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { paths as ConfigPaths } from "./api-types.config.gen.js";
import type { paths as ManagementPaths } from "./api-types.management.gen.js";
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

interface ErrorBody {
  error?: string;
  title?: string;
  errors?: Array<{ title?: string; detail?: string }>;
  type_detail?: Array<{ field?: string; description?: string }>;
}

/** Pull Honeycomb's own error text out of a v1 `{error}` or v2 JSON:API body. */
function honeycombMessage(body: string): string {
  try {
    const parsed: ErrorBody = JSON.parse(body);
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

function apiError(status: number, path: string, body: string): HoneycombApiError {
  return new HoneycombApiError(
    status,
    `Honeycomb API error ${status} for ${path}: ${honeycombMessage(body)}`,
  );
}

const transport = (ctx: HoneycombContext) => ({
  ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
  ...(ctx.http ? { http: ctx.http } : {}),
});

export type ConfigApi = ApiClient<ConfigPaths>;

/** The `/1/...` routes with an environment's configuration key. */
export function v1(ctx: HoneycombContext, key: string): ConfigApi {
  return createApiClient<ConfigPaths>({
    vendor: "Honeycomb",
    baseUrl: ctx.region.apiUrl,
    headers: { Accept: "application/json", "X-Honeycomb-Team": key },
    ...transport(ctx),
    // Error text names the path alone, without the call's query.
    httpError: ({ status, path, body }) => apiError(status, path, body),
  });
}

function managementHeaders(token: string) {
  return {
    Accept: "application/vnd.api+json",
    "Content-Type": "application/vnd.api+json",
    Authorization: `Bearer ${token}`,
  };
}

function managementToken(ctx: HoneycombContext): string {
  if (!ctx.managementToken) {
    throw new HoneycombApiError(
      401,
      "This account has no Honeycomb management key. Edit the account's credentials and add one to manage environments and API keys.",
    );
  }
  return ctx.managementToken;
}

/** The `/2/...` routes with the team's management key (JSON:API bodies). */
export function v2(ctx: HoneycombContext): ApiClient<ManagementPaths> {
  return createApiClient<ManagementPaths>({
    vendor: "Honeycomb",
    baseUrl: ctx.region.apiUrl,
    headers: managementHeaders(managementToken(ctx)),
    ...transport(ctx),
    // Only a list carries a query here, and its error text names it.
    httpError: ({ status, target, body }) => apiError(status, target, body),
  });
}

interface JsonApiPage<Row> {
  data?: Row[];
  links?: { next?: string | null };
}

/**
 * Walk a v2 list from its first page. Pagination is a cursor: `links.next` is a
 * ready-made relative URL (with `page[after]`), or null on the last page. A link
 * is sent to the region's API host whatever host it names.
 *
 * This is a hand loop rather than `withLinkPagination` because that reads a `data`
 * that is not an array as an empty page, and the host prunes what a sync stops
 * seeing. Here it fails the sync, as it always has.
 */
export async function v2Paged<Row>(
  ctx: HoneycombContext,
  first: () => Promise<JsonApiPage<Row>>,
  maxPages = 50,
): Promise<Row[]> {
  const out: Row[] = [];
  let next: string | null = null;
  for (let page = 0; page < maxPages && (page === 0 || next); page++) {
    const res: JsonApiPage<Row> = next === null ? await first() : await followLink(ctx, next);
    out.push(...(res.data ?? []));
    const link: string | null = res.links?.next ?? null;
    next = link ? relativePath(link) : null;
  }
  return out;
}

/** A next link as Honeycomb wrote it: no operation in the document has this shape. */
async function followLink<Row>(ctx: HoneycombContext, path: string): Promise<JsonApiPage<Row>> {
  const { body } = await restRequest<JsonApiPage<Row>>({
    vendor: "Honeycomb",
    url: `${ctx.region.apiUrl}${path}`,
    errorPath: path,
    headers: managementHeaders(managementToken(ctx)),
    ...transport(ctx),
    httpError: ({ status, body: text }) => apiError(status, path, text),
  });
  return body;
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
