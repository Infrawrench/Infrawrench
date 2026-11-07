import {
  createApiClient,
  withCursorPagination,
  withPagination,
  type HttpHostServices,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";

/**
 * Checkly Public API (`https://api.checklyhq.com`, OpenAPI at
 * `/openapi.json`, verified 2026-10). Auth is `Authorization: Bearer <api key>`
 * (a user API key, `cu_…`, from User settings, API keys) plus
 * `X-Checkly-Account: <account id>`, because a user key can belong to
 * several accounts. Lists paginate with `limit` (at most 100) and `page`.
 */
export const API_URL = "https://api.checklyhq.com";
export const VENDOR = "Checkly";

/** The most the document allows on every list. */
const PAGE_SIZE = 100;
/** 10,000 rows. A list longer than that throws, because a sync prunes what it stops seeing. */
const MAX_PAGES = 100;

export interface ChecklyContext {
  apiKey: string;
  /** Empty for `GET /v1/accounts`, which is sent without the account header. */
  accountId: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class ChecklyApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChecklyApiError";
    this.status = status;
  }
}

function checklyMessage(body: string): string {
  try {
    const parsed: { message?: string; error?: string } = JSON.parse(body);
    return parsed.message ?? parsed.error ?? body;
  } catch {
    return body;
  }
}

/** Drops an empty string, and joins an array into one form-encoded value (`a%2Cb`). */
function serializeQuery(query: Record<string, ParamValue>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    params.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return params.toString();
}

export function createChecklyApi(ctx: ChecklyContext) {
  const api = createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: API_URL,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
      ...(ctx.accountId ? { "X-Checkly-Account": ctx.accountId } : {}),
    },
    serializeQuery,
    httpError: ({ status, path, body }) =>
      new ChecklyApiError(
        status,
        `Checkly API error ${status} for ${path}: ${checklyMessage(body)}`,
      ),
    caCert: ctx.caCert,
    http: ctx.http,
  });
  return withPagination(api, {
    pageParam: "page",
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
  });
}

export type ChecklyApi = ReturnType<typeof createChecklyApi>;

/**
 * The `{ entries, nextId }` lists. The document's one end signal is `nextId` set to
 * null, so an empty page that still names a next one is not the end.
 */
export function checklyCursorApi(api: ChecklyApi) {
  return withCursorPagination(api, {
    cursorParam: "nextId",
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    next: "nextId",
    maxPages: MAX_PAGES,
    continueOnEmptyPage: true,
  });
}

export function statusOf(err: unknown): number {
  return err instanceof ChecklyApiError ? err.status : 0;
}
