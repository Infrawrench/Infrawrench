/**
 * The DigitalOcean control-plane client, typed from DO's OpenAPI document by
 * plugingen (`../plugingen.json`). Every provider call goes through the host's HTTP
 * service when there is one, including the ones `DoApi.fetch` makes off this API.
 */
import {
  createApiClient,
  hostFetch,
  hostTransport,
  ListPageError,
  ListTruncatedError,
  pathEncode,
  restRequest,
  type ApiClient,
  type ApiResponse,
  type HttpHostServices,
  type NoSlashString,
  type PaginatedApiClient,
  type ParamValue,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

const BASE_URL = "https://api.digitalocean.com/v2";

/**
 * An id as one path segment. A blank one would address the collection rather than
 * the resource, which on a delete is the last thing anybody wants.
 */
export function idSegment(id: string | undefined): NoSlashString {
  if (!id) throw new Error("DigitalOcean plugin: this needs a resource id, and it is blank.");
  return pathEncode(id);
}

/** An operation's response, by its `operationId`. */
export type DoResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

/**
 * Whether a failed call answered one of these statuses, for a read where that one
 * really means "none". Anything else has to propagate: a sync prunes what a list
 * stops returning, and a 500 is not "none".
 */
export function failedWith(err: unknown, ...statuses: number[]): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = /\bAPI error (\d{3})\b/.exec(message)?.[1];
  return status !== undefined && statuses.includes(Number(status));
}

/**
 * `per_page`'s documented maximum, and 250 of them is the 50,000 rows the host can
 * prune for one account. The API allows 250 requests a minute, so a walk that long
 * takes a minute. The gen-ai routes document no maximum, and nothing here needs a
 * full page back, so a route that caps it lower still reads to the end.
 */
const PAGE_SIZE = 200;
const MAX_PAGES = 250;

/** For a picker or a side table, where part of a long list is fine: 1,000 rows. */
export const PICKER = { maxPages: 5, partial: true } as const;

/** A field of an answer nothing has validated. */
function field(from: unknown, key: string): unknown {
  return typeof from === "object" && from !== null ? Reflect.get(from, key) : undefined;
}

function reportedTotal(page: unknown): number | undefined {
  const total = field(field(page, "meta"), "total");
  return typeof total === "number" ? total : undefined;
}

function rowsAt(page: unknown, key: string, path: string): object[] {
  const rows = field(page, key);
  if (Array.isArray(rows)) return rows;
  const empty =
    rows == null &&
    typeof page === "object" &&
    page !== null &&
    !reportedTotal(page) &&
    Object.keys(page).every((name) => name === key || name === "links" || name === "meta");
  if (empty) return [];
  throw new ListPageError({ vendor: "DO", path, key, found: rows, page });
}

/**
 * The rows of an answer. Absent or null reads as none only when the rest of the answer
 * agrees: the document marks nearly every list key optional, `/databases` answers
 * `null` on an account that never had one, and the gen-ai routes are proto3 JSON,
 * which leaves an empty list out. Anything else instead of the list is an error, such
 * as a renamed key or a failure wrapped in a 200, because a sync prunes what it stops
 * seeing.
 */
export function rowsOf<Page extends object, Key extends keyof Page & string>(
  page: Page,
  key: Key,
  path: string,
): NonNullable<Page[Key]>;
export function rowsOf(page: object, key: string, path: string): object[] {
  return rowsAt(page, key, path);
}

interface Walk {
  query?: Record<string, ParamValue>;
  pageSize?: number;
  maxPages?: number;
  partial?: boolean;
  stopWhen?: (rows: object[]) => boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Every row of a list. DO numbers its pages and says on each one whether there is
 * more, in `meta.total` or `links.pages.next`; a full page that says neither gets one
 * more request. This is by hand rather than `withPagination` because that ends on a
 * short page, which a route capping `per_page` would read as the last, and because of
 * what {@link rowsAt} tells apart.
 */
export function pageWalker<GetResponse, GetAll>(getResponse: GetResponse): GetAll;
export function pageWalker(
  getResponse: (path: string, request: object) => Promise<{ body: unknown }>,
) {
  return async (path: string, key: string, request: Walk = {}) => {
    const { query, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, partial, stopWhen } = request;
    const { signal, headers } = request;
    const all: object[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { body } = await getResponse(path, {
        query: { ...query, per_page: pageSize, ...(page > 1 ? { page } : {}) },
        ...(signal ? { signal } : {}),
        ...(headers ? { headers } : {}),
      });
      const rows = rowsAt(body, key, path);
      all.push(...rows);
      if (rows.length === 0 || stopWhen?.(rows)) return all;
      const total = reportedTotal(body);
      const more =
        total !== undefined
          ? all.length < total
          : !!field(field(field(body, "links"), "pages"), "next") || rows.length >= pageSize;
      if (!more) return all;
    }
    if (partial) return all;
    throw new ListTruncatedError({ vendor: "DO", path, items: all.length, maxPages });
  };
}

/** A request {@link DoApi.written} sends as given. */
export interface WrittenRequest {
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

export type DoGetAll = PaginatedApiClient<paths, "page" | "per_page">["getAll"];

export type DoApi = ApiClient<paths> & {
  /** Every row of a list, or an error if it cannot say it has them all. */
  getAll: DoGetAll;
  /**
   * A request written out whole, typed by the operation it calls, for what the
   * typed client cannot send: a query the document does not list, or a body that does
   * not fit it, such as one echoed from whatever the last GET returned.
   */
  written<Op extends keyof operations>(
    path: string,
    request?: WrittenRequest,
  ): Promise<DoResponse<Op>>;
  /**
   * A call off this API: the inference hosts, Spaces, a signed log URL. `stream` is
   * for an answer that must arrive as it is written.
   */
  fetch(url: string, init?: RequestInit, options?: { stream?: boolean }): Promise<Response>;
};

/**
 * DO's generic `{"id":"forbidden","message":"failed to create agent"}` tells the
 * user nothing actionable. Translate the common cause (missing GenAI scopes on the
 * personal access token) into a pointer at the fix. Same root cause for the other
 * gen-ai and dedicated-inference endpoints, so cover both.
 */
function withScopeHint(err: unknown, path: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (
    !message.includes("403") ||
    !(path.startsWith("/gen-ai/") || path.startsWith("/dedicated-inferences"))
  ) {
    return err;
  }
  const product = path.startsWith("/dedicated-inferences") ? "Dedicated Inference" : "Gradient AI";
  return new Error(
    `${message}\n\n` +
      `Hint: this is almost always the API token's scope. DigitalOcean ` +
      `${product} endpoints need the \`genai:create\` / \`genai:read\` / ` +
      `\`genai:update\` / \`genai:delete\` scopes (and ` +
      `\`dedicated_inference:*\` for Dedicated Inference), which older ` +
      `personal access tokens don't include. Mint a new token at ` +
      `https://cloud.digitalocean.com/account/api/tokens with the GenAI ` +
      `(or "Full Access") scope and update this account's credentials.`,
  );
}

/** Any failure of a call, not only an HTTP status, gets {@link withScopeHint}. */
function hinted<Send>(send: Send): Send;
function hinted(send: (path: string, ...rest: unknown[]) => Promise<unknown>) {
  return async (path: string, ...rest: unknown[]) => {
    try {
      return await send(path, ...rest);
    } catch (err) {
      throw withScopeHint(err, path);
    }
  };
}

export function createDoApi(token: string, http?: HttpHostServices): DoApi {
  const headers = { Authorization: `Bearer ${token}` };
  const client = createApiClient<paths>({
    vendor: "DO",
    baseUrl: BASE_URL,
    headers,
    http,
  });
  const sendWritten = async <Body>(path: string, request?: WrittenRequest) => {
    const answer = await restRequest<Body>({
      vendor: "DO",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers,
      ...hostTransport(http),
      ...(request ? { init: request } : {}),
    });
    return answer;
  };
  return {
    ...client,
    get: hinted(client.get),
    post: hinted(client.post),
    put: hinted(client.put),
    patch: hinted(client.patch),
    delete: hinted(client.delete),
    getAll: pageWalker<typeof client.getResponse, DoGetAll>(hinted(client.getResponse)),
    written: hinted(
      async <Op extends keyof operations>(path: string, request?: WrittenRequest) =>
        (await sendWritten<DoResponse<Op>>(path, request)).body,
    ),
    fetch: (url, init, options) => hostFetch({ http, ...options }, url, init),
  };
}
