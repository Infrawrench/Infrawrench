import {
  createApiClient,
  ListTruncatedError,
  pathEncode,
  requireListPage,
  restRequest,
  type ApiClientOptions,
  type ApiResponse,
  type HttpHostServices,
  type NoSlashString,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths as ComputePaths } from "./api-types.compute.gen.js";
import type { paths as CorePaths } from "./api-types.core.gen.js";
import type { paths as McPaths } from "./api-types.mc.gen.js";
import type { paths as StoragePaths } from "./api-types.storage.gen.js";

/**
 * bunny.net transport. Three hosts, one account API key (Account settings →
 * API key) sent as the `AccessKey` header:
 * - Core API `https://api.bunny.net` (pull zones, storage zones, DNS, Stream
 *   libraries, statistics, billing; spec
 *   core-api-public-docs.b-cdn.net/docs/v3/public.json) and the Edge
 *   Scripting endpoints under `/compute` (…/v3/compute.json).
 * - Magic Containers `https://api.bunny.net/mc` (api-mc.opsbunny.net/docs/
 *   public/swagger.json), camelCase JSON.
 * - Edge Storage `https://{StorageHostname}/{zone}/{path}`, where `AccessKey`
 *   is the storage zone's own password, not the account key.
 * Errors are `{ErrorKey, Field, Message}`. Verified 2026-10.
 */

export const API_BASE = "https://api.bunny.net";

export interface BunnyContext {
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class BunnyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BunnyApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    return typeof err.status === "number" ? err.status : 0;
  }
  return 0;
}

interface ErrorBody {
  Message?: string;
  message?: string;
  ErrorKey?: string;
  title?: string;
  detail?: string;
}

function errorText(body: string): string {
  try {
    const p: ErrorBody = JSON.parse(body);
    return p.Message ?? p.message ?? p.detail ?? p.title ?? p.ErrorKey ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300);
  }
}

function apiError(status: number, url: string, body: string): BunnyApiError {
  const path = new URL(url).pathname;
  return new BunnyApiError(status, `bunny.net API error ${status} for ${path}: ${errorText(body)}`);
}

/**
 * An id as one path segment. A blank one would address the collection, or a different
 * route, rather than the resource, which on a delete is the last thing anybody wants.
 */
export function idSegment(id: string | number | undefined): NoSlashString {
  if (id === undefined || String(id).trim() === "") {
    throw new Error("bunny.net plugin: this needs a resource id, and it is blank.");
  }
  return pathEncode(id);
}

/** An empty value is left out rather than sent as `x=`. */
function writeQuery(query: Record<string, ParamValue>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  return p.toString();
}

/** One client per document: the Core API, Edge Scripting and Magic Containers. */
export function createBunnyApis(ctx: BunnyContext) {
  const shared: Omit<ApiClientOptions, "baseUrl"> = {
    vendor: VENDOR,
    headers: { Accept: "application/json", AccessKey: ctx.apiKey },
    http: ctx.http,
    caCert: ctx.caCert,
    contentType: "with-body",
    emptyBodyIsUndefined: true,
    serializeQuery: writeQuery,
    httpError: ({ status, url, body }) => apiError(status, url, body),
  };
  return {
    core: createApiClient<CorePaths>({ ...shared, baseUrl: API_BASE }),
    compute: createApiClient<ComputePaths>({ ...shared, baseUrl: API_BASE }),
    mc: createApiClient<McPaths>({ ...shared, baseUrl: `${API_BASE}/mc` }),
  };
}

export type BunnyApis = ReturnType<typeof createBunnyApis>;

const VENDOR = "bunny.net";
const PER_PAGE = 1000;
const MAX_PAGES = 50;
const MC_PAGE_SIZE = 100;
const MC_MAX_PAGES = 100;

/**
 * `{Items, CurrentPage, TotalItems, HasMoreItems}` listings. A hand loop rather
 * than `getAll`: an empty page with more to come carries on, an answer that is
 * the array itself ends the list, and `page` goes before `perPage`.
 */
export async function bunnyPaged<Item>(
  path: string,
  fetchPage: (paging: {
    page: number;
    perPage: number;
  }) => Promise<{ Items?: Item[] | null; HasMoreItems?: boolean } | Item[]>,
): Promise<Item[]> {
  const out: Item[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchPage({ page, perPage: PER_PAGE });
    if (Array.isArray(res)) return [...out, ...res];
    // The document has `Items` nullable, so null is an empty page. Left out is not.
    const items =
      res?.Items === null
        ? []
        : requireListPage(res?.Items, { vendor: VENDOR, path, key: "Items" });
    out.push(...items);
    if (!res?.HasMoreItems) return out;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages: MAX_PAGES });
}

type AppList = ApiResponse<McPaths["/apps"]["get"]>;

/**
 * Magic Containers' cursor listing (`items`, `cursor`). A hand loop rather than
 * `getAll`: a page with no items ends the list even when it still has a cursor.
 */
export async function mcApps(mc: BunnyApis["mc"]): Promise<NonNullable<AppList["items"]>> {
  const out: NonNullable<AppList["items"]> = [];
  let cursor: string | undefined;
  for (let page = 0; page < MC_MAX_PAGES; page++) {
    const res = await mc.get("/apps", {
      query: { limit: MC_PAGE_SIZE, ...(cursor ? { nextCursor: cursor } : {}) },
    });
    const items = requireListPage(res?.items, { vendor: VENDOR, path: "/apps", key: "items" });
    out.push(...items);
    cursor = res?.cursor ?? undefined;
    if (!cursor || items.length === 0) return out;
  }
  throw new ListTruncatedError({
    vendor: VENDOR,
    path: "/apps",
    items: out.length,
    maxPages: MC_MAX_PAGES,
  });
}

/**
 * Edge Storage stays on `restRequest`. Each zone has its own host and password,
 * a key is any number of segments where the document has `{path}/{fileName}`, the
 * root listing is `/{zone}/` with no `{path}` at all, and an upload is binary.
 */
function storageOptions(ctx: BunnyContext, url: string, accessKey: string) {
  return {
    vendor: VENDOR,
    url,
    headers: { Accept: "application/json", AccessKey: accessKey },
    contentType: "with-body" as const,
    httpError: ({ status, body }: { status: number; body: string }) => apiError(status, url, body),
    ...(ctx.http ? { http: ctx.http } : {}),
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
  };
}

export type StorageListing = ApiResponse<StoragePaths["/{storageZoneName}/{path}/"]["get"]>;

export async function listStorage(
  ctx: BunnyContext,
  url: string,
  accessKey: string,
): Promise<StorageListing> {
  const { body } = await restRequest<StorageListing | undefined>({
    ...storageOptions(ctx, url, accessKey),
    init: { method: "GET" },
    emptyBodyIsUndefined: true,
  });
  return body === undefined
    ? []
    : requireListPage(body, { vendor: VENDOR, path: new URL(url).pathname, key: null });
}

/** A write whose answer is not read, so it need not be JSON. */
export async function writeStorage(
  ctx: BunnyContext,
  url: string,
  accessKey: string,
  init: { method: "PUT" | "DELETE"; bytes?: Uint8Array<ArrayBuffer> },
): Promise<void> {
  await restRequest<string>({
    ...storageOptions(ctx, url, accessKey),
    init: {
      method: init.method,
      ...(init.bytes
        ? { body: init.bytes, headers: { "Content-Type": "application/octet-stream" } }
        : {}),
    },
    responseAs: "text",
  });
}

type ChartValue = number | string | null;

export interface ChartPoint {
  timestamp?: ChartValue;
  x?: ChartValue;
  date?: ChartValue;
  time?: ChartValue;
  value?: ChartValue;
  y?: ChartValue;
}

export type Chart = Record<string, number | null> | Array<ChartPoint | null> | null | undefined;

/**
 * Bunny charts are `{ "2026-10-01T00:00:00Z": value, … }`. Magic Containers
 * charts are not described in its spec beyond "object", so arrays of
 * `{x|timestamp|date, y|value}` points are accepted too.
 */
export function chartPoints(chart: Chart): Array<{ timestamp: number; value: number }> {
  const parse = (k: string) =>
    Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(k) || !/T/.test(k) ? k : `${k}Z`);
  let pts: Array<{ timestamp: number; value: number }> = [];
  if (Array.isArray(chart)) {
    pts = chart.map((p) => {
      const o: ChartPoint = p ?? {};
      const t = o.timestamp ?? o.x ?? o.date ?? o.time;
      return {
        timestamp: typeof t === "number" ? t : parse(String(t)),
        value: Number(o.value ?? o.y),
      };
    });
  } else if (chart && typeof chart === "object") {
    pts = Object.entries(chart).map(([k, v]) => ({
      timestamp: parse(k),
      value: Number(v),
    }));
  }
  return pts
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value))
    .sort((a, b) => a.timestamp - b.timestamp);
}
