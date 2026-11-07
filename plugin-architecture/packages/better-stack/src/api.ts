import type { HttpHostServices } from "@infrawrench/plugin-base";
import {
  ListTruncatedError,
  followableLink,
  hostTransport,
  jsonRestFetch,
  linkHostsUnder,
  requireListPage,
} from "@infrawrench/plugin-base";

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

const VENDOR = "Better Stack";
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
      vendor: VENDOR,
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

export interface Paging {
  /** The route's documented largest page. Most say 250; incidents say 50. */
  perPage?: number;
  /** For a `partial` read. A list that must be whole keeps the cap worked out below. */
  maxPages?: number;
  /** For a read nothing is stored from, such as a picker: return what the cap reached. */
  partial?: boolean;
}

const DEFAULT_PER_PAGE = 250;
// One poll's limits for a list that goes through the resource sync.
const MAX_ROWS = 100_000;
const MAX_REQUESTS = 1000;

/** Follow `pagination.next` to the end, or throw: a sync prunes whatever a list stops returning. */
export async function bsPaged<A>(
  ctx: BetterStackContext,
  host: Host,
  path: string,
  query: Query = {},
  paging: Paging = {},
): Promise<{ data: Array<JsonApiItem<A>>; included: JsonApiItem[] }> {
  const perPage = paging.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = paging.maxPages ?? Math.min(MAX_REQUESTS, Math.ceil(MAX_ROWS / perPage));
  const data: Array<JsonApiItem<A>> = [];
  const included: JsonApiItem[] = [];
  let next = path;
  for (let page = 0; page < maxPages; page++) {
    const res: Page<A> = await bsFetch<Page<A>>(
      ctx,
      host,
      next,
      page === 0 ? { query: { per_page: perPage, ...query } } : undefined,
    );
    data.push(...requireListPage(res.data, { vendor: VENDOR, path, key: "data" }));
    included.push(...(res.included ?? []));
    const link = res.pagination?.next;
    if (!link) return { data, included };
    next = onChosenHost(link, `${baseOf(host)}${next}`, path);
  }
  if (paging.partial) return { data, included };
  throw new ListTruncatedError({ vendor: VENDOR, path, items: data.length, maxPages });
}

/**
 * Better Stack's documented next links name incidents.betterstack.com for the Uptime API.
 * Anything under betterstack.com goes back to the host this list started on, whose token it is.
 */
function onChosenHost(link: string, pageUrl: string, path: string): string {
  const url = new URL(
    followableLink(link, pageUrl, {
      vendor: VENDOR,
      path,
      foreignLinks: linkHostsUnder("betterstack.com"),
    }),
  );
  return `${url.pathname}${url.search}`;
}

/**
 * Better Stack answers 401 to a dead token and to a live team token on the other product's
 * host alike. This asks whether `ctx.token` itself is accepted on a host other than `host`,
 * so the first can fail its type and the second need not. A probe that cannot say answers false.
 */
export async function tokenWorksBeyond(ctx: BetterStackContext, host: Host): Promise<boolean> {
  const ownToken = { token: ctx.token, ...hostTransport(ctx.http, ctx.caCert) };
  const probes: Array<{ host: Host; path: string }> = [
    { host: "uptime", path: "/api/v2/monitors" },
    { host: "telemetry", path: "/api/v2/sources" },
  ];
  for (const probe of probes) {
    if (probe.host === host) continue;
    try {
      await bsFetch(ownToken, probe.host, probe.path, { query: { per_page: 1 } });
      return true;
    } catch (err) {
      const status = statusOf(err);
      // A 403 is a token Better Stack recognised and turned down.
      if (status === 403) return true;
      if (status !== 401) return false;
    }
  }
  return false;
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
