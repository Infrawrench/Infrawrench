/**
 * The request surface every Civo module uses.
 *
 * Civo API v2 (https://www.civo.com/api) is JSON over REST at
 * `https://api.civo.com/v2`, authenticated with an account API key sent as
 * `Authorization: bearer <key>`. Almost everything is **regional**: requests
 * carry `region` as a query parameter, and creates/updates also carry it in
 * the body (the official Go client `civo/civogo` does both). DNS, SSH keys,
 * quota, charges and regions are account-wide.
 *
 * Collections come back either as a bare array (`/v2/volumes`,
 * `/v2/networks`, `/v2/firewalls`, `/v2/loadbalancers`, `/v2/dns`, ...) or
 * paginated as `{ page, per_page, pages, items }` (`/v2/instances`,
 * `/v2/kubernetes/clusters`, `/v2/databases`, `/v2/ips`, `/v2/objectstores`,
 * ...); `list()` accepts both and walks the pages.
 *
 * Errors are `{ code, reason }`; the HTTP status is kept on the thrown object
 * (`CivoApiError.status`) for the hosts' backoff classification.
 */

import {
  hostFetch,
  type HostServices,
  ListTruncatedError,
  requireListPage,
} from "@infrawrench/plugin-base";

export const CIVO_API_BASE = "https://api.civo.com/v2";

export class CivoApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(
    status: number,
    private readonly path: string,
    private readonly body: string,
  ) {
    const parsed = parseError(body);
    super(`Civo API error ${status} for ${path}: ${parsed.message}`);
    this.name = "CivoApiError";
    this.status = status;
    this.code = parsed.code;
  }

  /** The same answer, said of every place it came from. */
  everywhere(where: string): CivoApiError {
    return new CivoApiError(this.status, `${this.path} ${where}`, this.body);
  }
}

function parseError(body: string): { message: string; code?: string } {
  try {
    const parsed = JSON.parse(body) as {
      code?: string;
      reason?: string;
      details?: string;
      error?: { message?: string; status?: string; details?: Array<{ reason?: string }> };
    };
    // Civo's gateway wraps its errors, with the reason in the first detail that has one.
    if (parsed.error && typeof parsed.error === "object") {
      const { message, status, details } = parsed.error;
      const code =
        (Array.isArray(details) ? details.find((d) => d.reason)?.reason : undefined) ?? status;
      return { message: message ?? code ?? body.slice(0, 500), ...(code ? { code } : {}) };
    }
    if (parsed.reason || parsed.code) {
      return {
        message: [parsed.reason ?? parsed.code, parsed.details].filter(Boolean).join(": "),
        ...(parsed.code ? { code: parsed.code } : {}),
      };
    }
  } catch {
    // not JSON
  }
  return { message: body.slice(0, 500) };
}

export function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * What civogo's errors.go names for a product a region or account does not offer: the
 * v2 codes, then the gateway's reasons.
 */
const NOT_OFFERED = new Set([
  "region_unavailable",
  "disabled_service",
  "REGION_UNAVAILABLE",
  "REGION_FEATURE_UNAVAILABLE",
]);

/** A 403 for a bad key, as opposed to a good key with no access to this. */
const KEY_REJECTED = new Set(["authentication_failed", "authentication_invalid_key"]);

/**
 * Whether an answer says this credential has no access here or the product is not
 * enabled, which does not change on a retry. Civo's API docs warn that "All resources
 * may not be available to your API key", and call a 403 an unauthorized request. A
 * not-offered code on a 5xx is a region that is down, so its rows are unknown rather
 * than absent.
 */
export function isAccessRefusal(err: unknown): err is CivoApiError {
  if (!(err instanceof CivoApiError) || err.status >= 500) return false;
  if ([401, 408, 429].includes(err.status)) return false;
  if (err.code && NOT_OFFERED.has(err.code)) return true;
  return err.status === 403 && !(err.code && KEY_REJECTED.has(err.code));
}

/** Whether an answer says this does not exist, as a plain page or a Civo error. */
export function isMissing(err: unknown): err is CivoApiError {
  return err instanceof CivoApiError && err.status === 404;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface CivoApi {
  get<T>(path: string, query?: Query): Promise<T>;
  /** Region-scoped write: `region` goes in the query and in the JSON body. */
  send<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    region: string | undefined,
    body?: Record<string, unknown>,
  ): Promise<T>;
  /** Every item of a list endpoint, bare array or paginated. */
  list<T>(path: string, query?: Query): Promise<T[]>;
  /** The host's transport with none of this API's auth, for a signed S3 call. */
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface CivoApiConfig {
  apiKey: string;
  services?: HostServices | undefined;
  caCert?: string;
  baseUrl?: string;
}

/** civogo's page size. Civo documents no maximum. */
const PER_PAGE = 100;
/** 100,000 rows: past this a poll would be killed before it could write them. */
const MAX_PAGES = 1000;

/** A paginated answer. A bare array, or anything else, is told apart at runtime. */
interface ListPage<T> {
  items?: T[] | null;
  pages?: number | string | null;
}

function buildUrl(base: string, path: string, query?: Query): string {
  const url = `${base}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

export function createCivoApi(config: CivoApiConfig): CivoApi {
  const base = config.baseUrl ?? CIVO_API_BASE;
  const http = config.services?.http;

  async function request<T>(method: string, url: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `bearer ${config.apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let status: number;
    let text: string;
    if (http) {
      const res = await http.request({
        url,
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        ...(config.caCert ? { caCert: config.caCert } : {}),
      });
      status = res.status;
      text = res.body;
    } else {
      const res = await fetch(url, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
      status = res.status;
      text = await res.text();
    }
    if (status < 200 || status >= 300) throw new CivoApiError(status, path, text);
    if (status === 204 || !text) return {} as T;
    return JSON.parse(text) as T;
  }

  const api: CivoApi = {
    fetch: (url, init) => hostFetch({ http, caCert: config.caCert }, url, init),
    get<T>(path: string, query?: Query) {
      return request<T>("GET", buildUrl(base, path, query), path);
    },
    send<T>(
      method: "POST" | "PUT" | "DELETE",
      path: string,
      region: string | undefined,
      body?: Record<string, unknown>,
    ) {
      const url = buildUrl(base, path, region ? { region } : undefined);
      const payload =
        method === "DELETE" ? undefined : { ...(body ?? {}), ...(region ? { region } : {}) };
      return request<T>(method, url, path, payload);
    },
    async list<T>(path: string, query?: Query) {
      const where = { vendor: "Civo", path };
      const first = await api.get<T[] | ListPage<T> | null>(path, {
        ...query,
        page: 1,
        per_page: PER_PAGE,
      });
      if (Array.isArray(first)) {
        if (first.length < PER_PAGE) return first;
        // A bare array has no page count to say whether the paging was honoured. civogo
        // calls these routes with no paging, so a full one is asked for that way.
        const whole = await api.get<T[] | null>(path, query);
        return requireListPage(whole, { ...where, key: null });
      }
      const out: T[] = [];
      let body: ListPage<T> | null = first;
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (page > 1) {
          body = await api.get<ListPage<T> | null>(path, { ...query, page, per_page: PER_PAGE });
        }
        const rows = requireListPage(body?.items, { ...where, key: "items", page: body });
        out.push(...rows);
        const pages = Number(body?.pages);
        if (pages > MAX_PAGES) {
          throw new ListTruncatedError({ ...where, items: out.length, maxPages: MAX_PAGES });
        }
        // civogo stops on `pages`. With none, only a short page says this is the last.
        if (pages >= 1 ? page >= pages : rows.length < PER_PAGE) return out;
      }
      throw new ListTruncatedError({ ...where, items: out.length, maxPages: MAX_PAGES });
    },
  };
  return api;
}

/** `{region}/{id}` from a host resource id; account-wide types have no region. */
export function regional(resourceId: string): { region: string; id: string } {
  const ext = resourceId.split(":").slice(2).join(":");
  const i = ext.indexOf("/");
  if (i < 0) return { region: "", id: ext };
  return { region: ext.slice(0, i), id: ext.slice(i + 1) };
}

export function trailingId(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

export function formBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function listValue(v: string | undefined): string[] {
  if (!v) return [];
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed)) return [...new Set(parsed.map(String).filter(Boolean))];
    } catch {
      // fall through
    }
  }
  return [
    ...new Set(
      t
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function intOr(v: string | undefined, d?: number): number | undefined {
  if (v === undefined || v === "") return d;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : d;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapPooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
