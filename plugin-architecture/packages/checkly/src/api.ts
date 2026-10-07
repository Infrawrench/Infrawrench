import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

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

const STATUS_IN_MESSAGE = /Checkly API error (\d{3})/;
type Query = Record<string, string | number | boolean | string[] | undefined>;

function checklyMessage(raw: string, path: string): string {
  const prefix = `for ${path}: `;
  const i = raw.indexOf(prefix);
  const body = i >= 0 ? raw.slice(i + prefix.length) : raw;
  try {
    const parsed = JSON.parse(body) as { message?: string; error?: string };
    return parsed.message ?? parsed.error ?? body;
  } catch {
    return body;
  }
}

export async function ckFetch<T>(
  ctx: ChecklyContext,
  path: string,
  init?: RequestInit & { query?: Query; noAccount?: boolean },
): Promise<T> {
  const { query, noAccount, ...rest } = init ?? {};
  const url = new URL(`${API_URL}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === "") continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  try {
    return await jsonRestFetch<T>({
      vendor: "Checkly",
      url: url.toString(),
      errorPath: path,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
        ...(!noAccount && ctx.accountId ? { "X-Checkly-Account": ctx.accountId } : {}),
      },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status)
      throw new ChecklyApiError(
        status,
        `Checkly API error ${status} for ${path}: ${checklyMessage(message, path)}`,
      );
    throw err;
  }
}

/** Page through a `limit`/`page` list until a short page. */
export async function ckPaged<T>(
  ctx: ChecklyContext,
  path: string,
  query: Query = {},
  maxPages = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = (await ckFetch<T[]>(ctx, path, { query: { ...query, limit: 100, page } })) ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export function statusOf(err: unknown): number {
  return err instanceof ChecklyApiError ? err.status : 0;
}
