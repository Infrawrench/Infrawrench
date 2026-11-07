import {
  createApiClient,
  requireListPage,
  withCursorPagination,
  type ApiClient,
  type HostServices,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Transport for the Baseten management API (`https://api.baseten.co/v1`), typed
 * from `https://api.baseten.co/v1/spec`. Auth is `Authorization: Bearer <api key>`;
 * Baseten still accepts the older `Api-Key <key>` scheme but documents Bearer as
 * current. Requests go through `services.http` when the host provides it, which
 * keeps bastion routing and custom CAs working.
 *
 * Baseten rate-limits per key (100 req/s by default, 20 req/min on
 * activate/deactivate) and answers a 429 with `{error, retry_after}`. One
 * retry is made when `retry_after` is short; anything longer surfaces as an
 * error rather than stalling a sync.
 */

export const API_HOST = "https://api.baseten.co";
export const VENDOR = "Baseten";

export class BasetenApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, path: string, body: string) {
    super(`Baseten API error ${status} for ${path}: ${summarizeBody(body)}`);
    this.name = "BasetenApiError";
    this.status = status;
    this.body = body;
  }
}

/** A field of a JSON value nothing has validated. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** Baseten errors are `{error}` (rate limits) or FastAPI-style `{detail}`. */
export function summarizeBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const detail = field(parsed, "detail");
    for (const candidate of [field(parsed, "error"), field(parsed, "message"), detail]) {
      if (typeof candidate === "string" && candidate) return candidate;
    }
    if (Array.isArray(detail)) {
      const msgs = detail.map((d) => field(d, "msg")).filter((m) => typeof m === "string");
      if (msgs.length) return msgs.join("; ");
    }
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

const MAX_RETRY_AFTER_S = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterSeconds(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const n = Number(field(parsed, "retry_after"));
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The whole of `HttpHostServices` as the client sees it: the host's service where
 * there is one and `fetch` where there is not, with the one retry over either.
 */
function retryingTransport(services: HostServices | undefined): HttpHostServices {
  const host = services?.http;
  const send: HttpHostServices["request"] = async (req) => {
    if (host) {
      const res = await host.request(req);
      return { ...res, body: res.body ?? "" };
    }
    const { url, method, headers } = req;
    // The client only ever sends JSON text.
    const body = typeof req.body === "string" ? { body: req.body } : {};
    const res = await fetch(url, { method, headers, ...body });
    const answered: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      answered[key] = value;
    });
    return { status: res.status, headers: answered, body: await res.text() };
  };
  return {
    request: async (req) => {
      const res = await send(req);
      if (res.status !== 429) return res;
      const wait = retryAfterSeconds(res.body);
      if (wait === null || wait > MAX_RETRY_AFTER_S) return res;
      await sleep(wait * 1000);
      return send(req);
    },
  };
}

export type BasetenApi = ApiClient<paths>;

export function createBasetenApi(
  apiKey: string,
  caCert: string,
  services: HostServices | undefined,
): BasetenApi {
  return createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: API_HOST,
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    http: retryingTransport(services),
    caCert,
    contentType: "with-body",
    httpError: ({ status, path, body }) => new BasetenApiError(status, path, body),
  });
}

/** The most pages a cursor list reads, at the largest page Baseten documents (1000). */
export const MAX_LIST_PAGES = 50;

/** The lists answered with `pagination: {has_more, cursor}`. */
export function basetenPages(api: BasetenApi) {
  return withCursorPagination(api, {
    cursorParam: "cursor",
    next: "pagination.cursor",
    hasMore: "pagination.has_more",
    sizeParam: "limit",
    maxPages: MAX_LIST_PAGES,
  });
}

/** The list a response holds, or an error: the document requires every one of them. */
export function listOf<Key extends string, Row>(
  page: Partial<Record<Key, readonly Row[] | null>> | undefined,
  key: Key,
  path: string,
): Row[] {
  return requireListPage(page?.[key], { vendor: VENDOR, path, key, page });
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  return err instanceof BasetenApiError && statuses.includes(err.status);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
