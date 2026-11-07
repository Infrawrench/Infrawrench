import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  type ApiClient,
  type HostServices,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { paths } from "./api-types.gen.js";
import { apiError, sendRaw, type RawResponse } from "./http.js";

/**
 * Auth0 Management API v2 transport. Verified against Auth0's published
 * OpenAPI document (https://auth0.com/docs/api/management/openapi.json,
 * 2026-10).
 *
 * Auth is a Machine-to-Machine application authorized for the Management
 * API: `POST https://{tenant}/oauth/token` with `grant_type=client_credentials`
 * and `audience=https://{tenant}/api/v2/`. The audience must be the tenant's
 * canonical `*.auth0.com` domain even when a custom domain is configured.
 */

export interface Auth0Credentials {
  domain: string;
  clientId: string;
  clientSecret: string;
  caCert: string;
}

export function normalizeDomain(raw: string): string {
  const host = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!host) throw new Error("Auth0 plugin: missing domain credential");
  return host;
}

export function readCredentials(credentials: Record<string, string>): Auth0Credentials {
  const clientId = (credentials["clientId"] ?? "").trim();
  const clientSecret = (credentials["clientSecret"] ?? "").trim();
  if (!clientId) throw new Error("Auth0 plugin: missing clientId credential");
  if (!clientSecret) throw new Error("Auth0 plugin: missing clientSecret credential");
  return {
    domain: normalizeDomain(credentials["domain"] ?? ""),
    clientId,
    clientSecret,
    caCert: credentials["caCert"] ?? "",
  };
}

/**
 * The public-cloud region a tenant lives in, from its canonical domain:
 * `{tenant}.{us|eu|au|jp|ca|uk}.auth0.com`, or the original US region for a
 * bare `{tenant}.auth0.com`. Private-cloud and custom hosts answer "".
 */
export function regionOfDomain(domain: string): string {
  const match = domain.match(/^[^.]+\.(?:([a-z]{2})\.)?auth0\.com$/);
  if (!match) return "";
  return match[1] ?? "us";
}

/** What every paged list asks for, after its own query. */
export interface Paging {
  page: number;
  per_page: number;
  include_totals: true;
}

/**
 * One page of a list. `include_totals=true` answers `{start, limit, total, <key>: [...]}`,
 * and the document also allows the bare array.
 */
type ListPage<Key extends string, Item> = Item[] | ({ total?: number } & { [K in Key]?: Item[] });

const VENDOR = "Auth0";

/** 50,000 rows at the document's largest page of 100, the most the host can prune. */
const MAX_PAGES = 500;

export interface PagesOptions {
  /** The cap on pages. Past it a list throws, unless it is {@link partial}. */
  maxPages?: number;
  /** Sent as `per_page`, and what makes a page short when a route reports no total. */
  perPage?: number;
  /** Return what was read at the cap, for a picker or a detail view that nothing is stored from. */
  partial?: boolean;
  /** Only a short or empty page ends the list, whatever `total` says. */
  totalIsEstimate?: boolean;
}

function isBadRequest(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === 400;
}

/** What {@link walkPages} read, and what stopped it if that was not the end of the list. */
export interface Walked<Item> {
  rows: Item[];
  /** `depth`: Auth0 refused to page further. `cap`: {@link PagesOptions.maxPages} ran out. */
  cut?: "depth" | "cap";
}

/**
 * Page through an offset-paginated collection (`page`/`per_page` with
 * `include_totals=true`). A hand loop rather than `withCursorPagination` because the
 * document also allows these routes to answer the bare array, and a 400 past the first
 * page has to read as this list being too long, not as a bad request.
 */
export async function walkPages<Key extends string, Item>(
  path: string,
  key: Key,
  fetchPage: (paging: Paging) => Promise<ListPage<Key, Item>>,
  options: PagesOptions = {},
): Promise<Walked<Item>> {
  const { maxPages = MAX_PAGES, perPage = 100, totalIsEstimate } = options;
  const rows: Item[] = [];
  for (let page = 0; page < maxPages; page++) {
    let body: ListPage<Key, Item>;
    try {
      body = await fetchPage({ page, per_page: perPage, include_totals: true });
    } catch (err) {
      // The same request worked for page 0, so what it refuses is the depth: offset
      // paging on /users stops at 1000 rows.
      if (page === 0 || !isBadRequest(err)) throw err;
      return { rows, cut: "depth" };
    }
    let read: Item[];
    let total: number | undefined;
    if (Array.isArray(body)) {
      read = body;
    } else {
      const keyed: { [K in Key]?: Item[] } = body;
      ({ total } = body);
      // The document marks the key optional, and a total of 0 says what its absence means.
      read =
        total === 0 && keyed[key] === undefined
          ? []
          : requireListPage(keyed[key], { vendor: VENDOR, path, key, page: body });
    }
    rows.push(...read);
    if (read.length === 0) return { rows };
    if (typeof total === "number" && !totalIsEstimate) {
      if (rows.length >= total) return { rows };
    } else if (read.length < perPage) {
      return { rows };
    }
  }
  return { rows, cut: "cap" };
}

/** {@link walkPages} for a list that is either whole or an error, or is {@link PagesOptions.partial}. */
export async function pages<Key extends string, Item>(
  path: string,
  key: Key,
  fetchPage: (paging: Paging) => Promise<ListPage<Key, Item>>,
  options: PagesOptions = {},
): Promise<Item[]> {
  const { rows, cut } = await walkPages(path, key, fetchPage, options);
  if (!cut || options.partial) return rows;
  throw new ListTruncatedError(
    cut === "depth"
      ? { vendor: VENDOR, path, items: rows.length, maxItems: rows.length }
      : { vendor: VENDOR, path, items: rows.length, maxPages: options.maxPages ?? MAX_PAGES },
  );
}

/** What a checkpoint-paged list asks for. */
export interface Checkpoint {
  take: number;
  from?: string;
}

/**
 * One page of a checkpoint list. The document also allows the bare array, without
 * saying whether it answers `take` with one or whether one is complete.
 */
type CheckpointPage<Key extends string, Item> =
  Item[] | ({ next?: string } & { [K in Key]?: Item[] });

/**
 * Page by checkpoint (`from`/`take`, ended by `next` going away), which the document
 * requires for reading past 1000 rows of the routes it describes that way. A hand loop
 * because `withCursorPagination` reads no bare array, and its types do not reach
 * `/connections/{id}/clients`. A full array has no cursor to carry on from, so it is
 * refused rather than read as the end.
 */
export async function checkpoints<Key extends string, Item>(
  path: string,
  key: Key,
  fetchPage: (checkpoint: Checkpoint) => Promise<CheckpointPage<Key, Item>>,
  { take = 100, maxPages = MAX_PAGES }: { take?: number; maxPages?: number } = {},
): Promise<Item[]> {
  const out: Item[] = [];
  let from: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage({ take, ...(from ? { from } : {}) });
    if (Array.isArray(body)) {
      out.push(...body);
      if (body.length < take) return out;
      throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxItems: take });
    }
    const keyed: { [K in Key]?: Item[] } = body;
    out.push(...requireListPage(keyed[key], { vendor: VENDOR, path, key, page: body }));
    if (!body.next) return out;
    from = body.next;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}

export class Auth0Api {
  private token: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  /** Last rate-limit headers seen (Auth0 rate-limits the Management API per tenant). */
  lastRateLimit: { limit: number; remaining: number; resetAt: number } | null = null;
  /** The Management API, through {@link send}. */
  readonly rest: ApiClient<paths>;

  constructor(
    readonly creds: Auth0Credentials,
    private readonly services: HostServices | undefined,
  ) {
    this.rest = createApiClient<paths>({
      vendor: "Auth0",
      baseUrl: `https://${creds.domain}/api/v2`,
      headers: { Accept: "application/json" },
      http: { request: (req) => this.send(req) },
      contentType: "with-body",
      emptyBodyIsUndefined: true,
      httpError: ({ status, path, body }) => apiError(status, path, body),
    });
  }

  get domain(): string {
    return this.creds.domain;
  }

  private async accessToken(force: boolean): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** `/oauth/token` is not in the Management API document, so this stays hand-written. */
  private async fetchToken(): Promise<string> {
    const res = await sendRaw(
      {
        url: `https://${this.creds.domain}/oauth/token`,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.creds.clientId,
          client_secret: this.creds.clientSecret,
          audience: `https://${this.creds.domain}/api/v2/`,
        }),
      },
      this.services,
      this.creds.caCert,
    );
    if (res.status < 200 || res.status >= 300) throw apiError(res.status, "/oauth/token", res.body);
    const body: { access_token?: string; expires_in?: number } = JSON.parse(res.body);
    if (!body.access_token)
      throw Object.assign(new Error("Auth0 plugin: no access token returned"), { status: 502 });
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 86400) * 1000,
    };
    return body.access_token;
  }

  /** The transport under {@link rest}: the bearer token, a fresh one after a 401, and the rate limit. */
  private async send(req: Parameters<HttpHostServices["request"]>[0]): Promise<RawResponse> {
    const first = await this.sendWithToken(req, false);
    if (first.status !== 401) return first;
    this.token = null;
    return this.sendWithToken(req, true);
  }

  private async sendWithToken(
    { url, method, headers, body }: Parameters<HttpHostServices["request"]>[0],
    freshToken: boolean,
  ): Promise<RawResponse> {
    const token = await this.accessToken(freshToken);
    const res = await sendRaw(
      {
        url,
        method,
        headers: { Authorization: `Bearer ${token}`, ...headers },
        // The client only ever sends JSON text.
        ...(typeof body === "string" ? { body } : {}),
      },
      this.services,
      this.creds.caCert,
    );
    const limit = Number(res.headers["x-ratelimit-limit"]);
    const remaining = Number(res.headers["x-ratelimit-remaining"]);
    if (Number.isFinite(limit) && Number.isFinite(remaining) && limit > 0) {
      const reset = Number(res.headers["x-ratelimit-reset"]);
      this.lastRateLimit = {
        limit,
        remaining,
        resetAt: Number.isFinite(reset) ? reset * 1000 : Date.now(),
      };
    }
    return res;
  }
}
