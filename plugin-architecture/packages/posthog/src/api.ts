import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * PostHog's private (management) API, verified against the OpenAPI schema
 * served at `https://us.posthog.com/api/schema/` (2026-10): personal API key
 * as `Authorization: Bearer phx_…`, every list a DRF page
 * (`{count, next, previous, results}` with `limit`/`offset`), project objects
 * under `/api/projects/{project_id}/…`, organization objects under
 * `/api/organizations/{organization_id}/…`.
 */
export const CLOUD_HOSTS: Record<string, string> = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
};

export interface PostHogContext {
  baseUrl: string;
  /** `us`, `eu` or `self-hosted`; resources carry it as their `region`. */
  region: string;
  apiKey: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class PostHogApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PostHogApiError";
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

/** Region picker value plus optional self-hosted URL → API base. */
export function resolveHost(region: string, host: string): { baseUrl: string; region: string } {
  const custom = host.trim().replace(/\/+$/, "");
  if (custom) {
    const url = /^https?:\/\//i.test(custom) ? custom : `https://${custom}`;
    let hostname = "";
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    // Cloud app and ingest hostnames all mean the cloud API host of that region.
    if (/^(us|app|us\.i)\.posthog\.com$/.test(hostname))
      return { baseUrl: CLOUD_HOSTS["us"]!, region: "us" };
    if (/^eu(\.i)?\.posthog\.com$/.test(hostname))
      return { baseUrl: CLOUD_HOSTS["eu"]!, region: "eu" };
    return { baseUrl: url, region: "self-hosted" };
  }
  const r = region.trim().toLowerCase();
  return CLOUD_HOSTS[r]
    ? { baseUrl: CLOUD_HOSTS[r]!, region: r }
    : { baseUrl: CLOUD_HOSTS["us"]!, region: "us" };
}

/** DRF errors are `{ type, code, detail, attr }`. */
function friendly(status: number, message: string): string {
  const body = message.slice(message.indexOf(": ") + 2);
  try {
    const parsed = JSON.parse(body) as { detail?: string; attr?: string };
    if (parsed.detail)
      return `PostHog API error ${status}: ${parsed.detail}${parsed.attr ? ` (${parsed.attr})` : ""}`;
  } catch {
    // keep raw
  }
  return message;
}

export async function phFetch<T>(
  ctx: PostHogContext,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  try {
    return await jsonRestFetch<T>({
      vendor: "PostHog",
      url: withQuery(`${ctx.baseUrl}${path}`, query),
      errorPath: path,
      headers: { Accept: "application/json", Authorization: `Bearer ${ctx.apiKey}` },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);
    if (status) throw new PostHogApiError(status, friendly(status, message));
    throw err;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof PostHogApiError ? err.status : 0;
}

const PAGE = 200;
const MAX_PAGES = 25;

/** Walk a DRF `limit`/`offset` list. */
export async function pagedList<T>(
  ctx: PostHogContext,
  path: string,
  query: Query = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await phFetch<{ results?: T[]; next?: string | null; count?: number }>(ctx, path, {
      query: { ...query, limit: PAGE, offset: i * PAGE },
    });
    const items = res?.results ?? [];
    out.push(...items);
    if (!res?.next || items.length === 0) break;
  }
  return out;
}
