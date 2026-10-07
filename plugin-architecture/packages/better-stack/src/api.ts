import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * Better Stack spreads its API over three hosts, all JSON:API and all
 * `Authorization: Bearer <token>`:
 *
 * - `uptime.betterstack.com` (also served as `incidents.betterstack.com`):
 *   monitors, heartbeats, status pages, on-call, incidents, escalation policies.
 * - `telemetry.betterstack.com`: sources, source groups, dashboards, alerts,
 *   SQL connections.
 * - `betterstack.com`: organization-wide endpoints (usage and billing, team
 *   members), which only accept a global API token.
 *
 * A global API token works everywhere; a team-scoped Uptime or Telemetry
 * token only on its own host. Lists paginate with `pagination.next`, a full URL.
 */
export const UPTIME_URL = "https://uptime.betterstack.com";
export const TELEMETRY_URL = "https://telemetry.betterstack.com";
export const MAIN_URL = "https://betterstack.com";

export type Host = "uptime" | "telemetry" | "main";

export interface BetterStackContext {
  token: string;
  telemetryToken?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class BetterStackApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BetterStackApiError";
    this.status = status;
  }
}

const STATUS_IN_MESSAGE = /Better Stack API error (\d{3})/;

type Query = Record<string, string | number | boolean | undefined>;

function baseOf(host: Host): string {
  return host === "uptime" ? UPTIME_URL : host === "telemetry" ? TELEMETRY_URL : MAIN_URL;
}

function bsMessage(raw: string, path: string): string {
  const prefix = `for ${path}: `;
  const i = raw.indexOf(prefix);
  const body = i >= 0 ? raw.slice(i + prefix.length) : raw;
  try {
    const parsed = JSON.parse(body) as { errors?: unknown; error?: string; message?: string };
    if (typeof parsed.errors === "string") return parsed.errors;
    if (Array.isArray(parsed.errors))
      return parsed.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("; ");
    if (parsed.errors && typeof parsed.errors === "object") {
      return Object.entries(parsed.errors as Record<string, unknown>)
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("; ");
    }
    return parsed.error ?? parsed.message ?? body;
  } catch {
    return body;
  }
}

export async function bsFetch<T>(
  ctx: BetterStackContext,
  host: Host,
  path: string,
  init?: RequestInit & { query?: Query },
): Promise<T> {
  const { query, ...rest } = init ?? {};
  const isAbsolute = /^https?:\/\//.test(path);
  const url = new URL(isAbsolute ? path : `${baseOf(host)}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const label = url.pathname;
  const token = host === "telemetry" ? (ctx.telemetryToken ?? ctx.token) : ctx.token;
  try {
    return await jsonRestFetch<T>({
      vendor: "Better Stack",
      url: url.toString(),
      errorPath: label,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      ...(Object.keys(rest).length > 0 ? { init: rest } : {}),
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(STATUS_IN_MESSAGE.exec(message)?.[1] ?? 0);
    if (status) {
      throw new BetterStackApiError(
        status,
        `Better Stack API error ${status} for ${label}: ${bsMessage(message, label)}`,
      );
    }
    throw err;
  }
}

export interface JsonApiItem<A = Record<string, unknown>> {
  id: string;
  type?: string;
  attributes?: A;
  relationships?: Record<string, { data?: unknown }>;
}

interface Page<A> {
  data?: Array<JsonApiItem<A>>;
  included?: JsonApiItem[];
  pagination?: { next?: string | null };
}

/** Follow `pagination.next` until it runs out (hard stop at `maxPages`). */
export async function bsPaged<A>(
  ctx: BetterStackContext,
  host: Host,
  path: string,
  query: Query = {},
  maxPages = 50,
): Promise<{ data: Array<JsonApiItem<A>>; included: JsonApiItem[] }> {
  const data: Array<JsonApiItem<A>> = [];
  const included: JsonApiItem[] = [];
  let next: string | null = path;
  let first = true;
  for (let page = 0; page < maxPages && next; page++) {
    const res: Page<A> = await bsFetch<Page<A>>(ctx, host, next, first ? { query } : undefined);
    first = false;
    data.push(...(res.data ?? []));
    included.push(...(res.included ?? []));
    next = relative(res.pagination?.next ?? null);
  }
  return { data, included };
}

/** Keep pagination on the host we chose (links may name incidents.betterstack.com). */
function relative(link: string | null): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    return `${u.pathname}${u.search}`;
  } catch {
    return link;
  }
}

export function statusOf(err: unknown): number {
  return err instanceof BetterStackApiError ? err.status : 0;
}

export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}
