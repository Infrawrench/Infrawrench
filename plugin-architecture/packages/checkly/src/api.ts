import {
  createApiClient,
  type ApiClient,
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

export interface ChecklyContext {
  apiKey: string;
  /** Empty for `GET /v1/accounts`, which is sent without the account header. */
  accountId: string;
  caCert?: string;
  http?: HttpHostServices;
}

export type ChecklyApi = ApiClient<paths>;

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

export function createChecklyApi(ctx: ChecklyContext): ChecklyApi {
  return createApiClient<paths>({
    vendor: "Checkly",
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
    ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
    ...(ctx.http ? { http: ctx.http } : {}),
  });
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Page through a `limit`/`page` list until a short page. A hand loop because
 * `getAll` reads a 200 that is not an array as the end of the list; this throws,
 * and the host prunes what a sync stops seeing.
 */
export async function ckPaged<T>(
  loadPage: (query: { limit: number; page: number }) => Promise<T[] | null | undefined>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = (await loadPage({ limit: PAGE_SIZE, page })) ?? [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

/** Follow `nextId` through `{ entries, nextId }` pages, past an empty page, up to `maxPages`. */
export async function ckEntries<T>(
  loadPage: (cursor: { nextId?: string }) => Promise<{ entries?: T[]; nextId?: string | null }>,
  maxPages: number,
): Promise<T[]> {
  const out: T[] = [];
  let nextId: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await loadPage(nextId ? { nextId } : {});
    out.push(...(res.entries ?? []));
    nextId = res.nextId ?? undefined;
    if (!nextId) break;
  }
  return out;
}

export function statusOf(err: unknown): number {
  return err instanceof ChecklyApiError ? err.status : 0;
}
