import {
  createApiClient,
  type ApiClient,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Resend REST API (https://resend.com/docs/api-reference, OpenAPI spec at
 * https://github.com/resend/resend-openapi `resend.json`, version 1.5.1,
 * verified 2026-10).
 *
 * - One host, `api.resend.com`, Bearer auth with an `re_…` API key or an
 *   OAuth access token ("Connect with Resend", see oauth.ts).
 * - JSON bodies; updates are `PATCH`.
 * - Lists page with `limit` (1–100) and an `after=<last id>` cursor, and say
 *   `has_more`.
 * - Errors are `{ statusCode, message, name }`. A malformed key answers 400
 *   `validation_error`; a sending-access key answers 401 `restricted_api_key`
 *   on anything but sending.
 * - The default rate limit is 10 requests a second per team, shared across
 *   keys; a 429 carries `retry-after` (seconds), which this client honours.
 * - `api.resend.com` sends no CORS headers, so the desktop renderer must use
 *   the host HTTP service.
 */
export const API_BASE = "https://api.resend.com";
export const DASHBOARD_BASE = "https://resend.com";

export interface ResendContext {
  apiKey: string;
  /**
   * A currently valid OAuth access token, for an account connected with
   * Resend. Its access tokens live 15 minutes, so each request asks the host
   * (which refreshes and persists the rotated refresh token) instead of
   * reusing the token the client was built with.
   */
  getToken?: () => Promise<string>;
  http?: HttpHostServices;
  caCert?: string;
  /** Injected in tests so 429 back-off does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class ResendApiError extends Error {
  readonly status: number;
  /** Resend's error `name` (`validation_error`, `restricted_api_key`, …). */
  readonly errorName: string;
  constructor(status: number, message: string, errorName = "") {
    super(message);
    this.name = "ResendApiError";
    this.status = status;
    this.errorName = errorName;
  }
}

/** The key is a sending-access key, or lacks scope for this call. */
export function isRestrictedKey(err: unknown): err is ResendApiError {
  return (
    err instanceof ResendApiError &&
    (err.errorName === "restricted_api_key" || err.errorName === "invalid_permission")
  );
}

function buildQuery(query: Record<string, ParamValue> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length > 0) params.set(k, v.join(","));
    } else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function parseError(text: string): { message: string; name: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : "";
      return { message: parsed.message, name };
    }
  } catch {
    // Not JSON.
  }
  return { message: text.slice(0, 500), name: "" };
}

const MAX_RETRIES = 3;

/** The request as it goes out: the host's HTTP service where there is one, or `fetch`. */
function send(ctx: ResendContext): HttpHostServices["request"] {
  const { http } = ctx;
  if (http) return (req) => http.request(req);
  return async ({ url, method, headers, body }) => {
    // Only ever JSON text: nothing here uploads bytes.
    const res = await fetch(url, {
      method,
      headers,
      ...(typeof body === "string" ? { body } : {}),
    });
    const retryAfter = res.headers.get("retry-after");
    return {
      status: res.status,
      headers: retryAfter === null ? {} : { "retry-after": retryAfter },
      body: await res.text(),
    };
  };
}

/**
 * Each attempt asks for a current token and backs off a 429, so both sit below
 * the typed client, which only sees the answer that came of them.
 */
function transport(ctx: ResendContext): HttpHostServices {
  const sendOnce = send(ctx);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async request(req) {
      for (let attempt = 0; ; attempt++) {
        const res = await sendOnce(
          ctx.getToken
            ? {
                ...req,
                headers: { ...req.headers, Authorization: `Bearer ${await ctx.getToken()}` },
              }
            : req,
        );
        if (res.status === 429 && attempt < MAX_RETRIES) {
          const { name } = parseError(res.body);
          // Quota errors do not clear by waiting a second.
          if (name !== "daily_quota_exceeded" && name !== "monthly_quota_exceeded") {
            const seconds = Number(res.headers["retry-after"] ?? res.headers["Retry-After"]);
            await sleep(
              Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : 1000,
            );
            continue;
          }
        }
        return res;
      }
    },
  };
}

export type ResendApi = ApiClient<paths>;

export function createResendApi(ctx: ResendContext): ResendApi {
  return createApiClient<paths>({
    vendor: "Resend",
    baseUrl: API_BASE,
    headers: { Authorization: `Bearer ${ctx.apiKey}`, Accept: "application/json" },
    http: transport(ctx),
    caCert: ctx.caCert,
    contentType: "with-body",
    serializeQuery: (query) => buildQuery(query).slice(1),
    httpError: ({ status, path, body }) => {
      const { message, name } = parseError(body);
      return new ResendApiError(status, `Resend API error ${status} for ${path}: ${message}`, name);
    },
  });
}

/** What every list in the document answers with. */
interface Page<Item> {
  data?: Item[];
  has_more?: boolean;
}

/**
 * Every page of a cursor list, up to `maxPages` × 100 items:
 * `listAll((query) => api.get("/domains", { query }))`.
 *
 * Not `withCursorPagination`, which reads a `data` that is not an array as an empty
 * list. Here it throws, and an empty list is what lets the host prune a resource.
 */
export async function listAll<Item extends { id?: string }>(
  fetchPage: (query: { limit: number; after?: string }) => Promise<Page<Item>>,
  maxPages = 10,
): Promise<Item[]> {
  const out: Item[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage({ limit: 100, ...(after ? { after } : {}) });
    const data = res?.data ?? [];
    out.push(...data);
    const last = data[data.length - 1]?.id;
    if (!res?.has_more || !last) break;
    after = last;
  }
  return out;
}
