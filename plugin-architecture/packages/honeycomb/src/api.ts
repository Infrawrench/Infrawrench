import {
  createApiClient,
  requireListPage,
  withLinkPagination,
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

/**
 * The `/2/...` lists. `links.next` is a ready-made relative URL with `page[after]`, null
 * on the last page; 100 is the document's largest `page[size]`, so this reads 10,000 rows.
 */
export function v2Lists(ctx: HoneycombContext) {
  return withLinkPagination(v2(ctx), {
    next: "links.next",
    sizeParam: "page[size]",
    pageSize: 100,
    maxPages: 100,
  });
}

/** `/1/signals`, paged the same way as the `/2/...` lists. */
export function v1Lists(ctx: HoneycombContext, key: string) {
  return withLinkPagination(v1(ctx, key), {
    next: "links.next",
    sizeParam: "page[size]",
    pageSize: 100,
    maxPages: 100,
  });
}

/** A `/1/...` list answers a bare array. Anything else, `null` included, is not "none". */
export function listRows<Row>(rows: readonly Row[] | null | undefined, path: string): Row[] {
  return requireListPage(rows, { vendor: "Honeycomb", path, key: null });
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
