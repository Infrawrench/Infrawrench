/**
 * A typed client over a provider's OpenAPI document. `paths` comes from
 * `scripts/generate-plugin-api-types.mjs`, and everything else is worked out from
 * it in this one file, so a plugin gets checked paths, query strings, bodies and
 * responses without a cast at any call site:
 *
 *   const api = createApiClient<paths>({ vendor: "Hetzner", baseUrl, headers });
 *   const { servers } = await api.get(`/servers`, { query: { per_page: 50 } });
 *   await api.delete(`/servers/${pathEncode(id)}`);
 *
 *   const paged = withPagination(api, { pageParam: "page", sizeParam: "per_page", pageSize: 50 });
 *   const everyServer = await paged.getAll(`/servers`, "servers");
 *
 * Requests go through `jsonRestFetch`, so bastion routing, custom CAs and the
 * error format are what every other plugin call gets.
 *
 * This checks what the provider's document promises and nothing more: a response
 * is not validated at runtime, because these documents are often wrong in small
 * ways and a sync that dies on an undocumented enum value helps nobody.
 */
import { jsonRestFetch } from "./http.js";
import type { HttpHostServices } from "./manifest.js";

/** A path segment known to contain no slashes. Made by {@link pathEncode}. */
export type NoSlashString = string & { readonly __noSlash: unique symbol };

/** Encode a value for use as one path segment. */
export function pathEncode(value: string | number): NoSlashString {
  // Branding is the one thing a cast is for: nothing structural says "encoded".
  return encodeURIComponent(String(value)) as NoSlashString;
}

type HttpMethod = "get" | "put" | "post" | "delete" | "patch";

/** `/servers/{id}/actions` becomes `/servers/${NoSlashString}/actions`. */
type TemplatePath<S extends string> = S extends `${infer Before}{${string}}${infer After}`
  ? `${Before}${NoSlashString}${TemplatePath<After>}`
  : S;

/** The paths of `P` that support `M`, keyed by what a caller writes. */
type PathsFor<P, M extends HttpMethod> = {
  [K in keyof P & string as P[K] extends { [_ in M]: object } ? TemplatePath<K> : never]: P[K][M &
    keyof P[K]];
};

type Json<Content> = Content extends { "application/json": infer Body } ? Body : never;

type Operation = {
  parameters?: { query?: object };
  requestBody?: { content: object };
  responses?: object;
};

type QueryOf<Op> = Op extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

type BodyOf<Op> = Op extends { requestBody?: { content: infer C } } ? Json<C> : never;

/**
 * A request body as a call site may write it. `JSON.stringify` drops `undefined`,
 * so a top-level field may be `undefined` and is then simply not sent: form values
 * are `string | undefined` and the provider's own validation error is the better
 * message. A required key still has to be written, and its type still has to match.
 */
type Writable<Body> = { [K in keyof Body]: Body[K] | undefined };

/** The body an operation takes, as a call site writes it. */
export type ApiBody<Op> = Writable<BodyOf<Op>>;

/** The JSON body of an operation's 2xx responses; `undefined` when there is none. */
export type ApiResponse<Op> = Op extends { responses: infer R }
  ? {
      [Code in keyof R]: Code extends 200 | 201 | 202 | 203 | 204
        ? R[Code] extends { content: infer C }
          ? Json<C>
          : undefined
        : never;
    }[keyof R]
  : never;

/** `query` is only compulsory when the document requires a query parameter. */
type QueryOption<Op> = [QueryOf<Op>] extends [never]
  ? object
  : Op extends { parameters: { query: object } }
    ? { query: QueryOf<Op> }
    : { query?: QueryOf<Op> };

/** `body` is only compulsory when the document requires one. */
type BodyOption<Op> = [BodyOf<Op>] extends [never]
  ? object
  : Op extends { requestBody: object }
    ? { body: ApiBody<Op> }
    : { body?: ApiBody<Op> };

type Options<Op> = QueryOption<Op> & BodyOption<Op> & { signal?: AbortSignal };

type Args<Op> = object extends Options<Op> ? [options?: Options<Op>] : [options: Options<Op>];

type Caller<P, M extends HttpMethod> = <const Path extends keyof PathsFor<P, M> & string>(
  path: Path,
  ...args: Args<PathsFor<P, M>[Path]>
) => Promise<ApiResponse<PathsFor<P, M>[Path]>>;

export type ApiClient<P> = { [M in HttpMethod]: Caller<P, M> };

export interface ApiClientOptions {
  /** Vendor name for error messages, e.g. `"Hetzner"`. */
  vendor: string;
  baseUrl: string;
  headers:
    Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  http?: HttpHostServices | undefined;
  caCert?: string | undefined;
}

const COMMA_SEPARATED = Symbol("commaSeparated");

/**
 * Send an array as `key=a,b,c` rather than the default `key=a&key=b`, with the
 * commas left unencoded: OpenAPI's `style: form, explode: false`. It is still an
 * array to the type checker, so the provider's item type keeps applying.
 */
export function commaSeparated<T>(items: readonly T[]): T[] {
  return Object.assign([...items], { [COMMA_SEPARATED]: true });
}

function isCommaSeparated(value: unknown[]): boolean {
  return COMMA_SEPARATED in value;
}

/** Form-encode one value the way `URLSearchParams` would, without its separators. */
const encodeForm = (value: unknown) =>
  new URLSearchParams({ "": String(value) }).toString().slice(1);

function queryString(query: object | undefined): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const name = encodeForm(key);
    if (!Array.isArray(value)) parts.push(`${name}=${encodeForm(value)}`);
    else if (isCommaSeparated(value)) parts.push(`${name}=${value.map(encodeForm).join(",")}`);
    else for (const item of value) parts.push(`${name}=${encodeForm(item)}`);
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

interface RequestOptions {
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
}

/** Build a client for one provider's document. */
export function createApiClient<P>(options: ApiClientOptions): ApiClient<P> {
  const send =
    (method: HttpMethod) =>
    async (path: string, request: RequestOptions = {}): Promise<unknown> => {
      const headers =
        typeof options.headers === "function" ? await options.headers() : options.headers;
      const target = `${path}${queryString(request.query)}`;
      return jsonRestFetch<unknown>({
        vendor: options.vendor,
        url: `${options.baseUrl}${target}`,
        // With the query: `/images` fails differently for `?type=system` and `?type=backup`.
        errorPath: target,
        headers,
        init: {
          method: method.toUpperCase(),
          ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        },
        ...(options.http ? { http: options.http } : {}),
        ...(options.caCert ? { caCert: options.caCert } : {}),
      });
    };
  // The generic surface above is the point of this file; the implementation is
  // one function per verb and cannot express it.
  return {
    get: send("get"),
    put: send("put"),
    post: send("post"),
    delete: send("delete"),
    patch: send("patch"),
  } as unknown as ApiClient<P>;
}

/** The keys of a response that hold an array: what a list can be collected by. */
type ListKey<Response> = {
  [K in keyof Response & string]-?: NonNullable<Response[K]> extends readonly unknown[] ? K : never;
}[keyof Response & string];

type ListOptions<Op, Paging extends string> = ([QueryOf<Op>] extends [never]
  ? object
  : { query?: Omit<QueryOf<Op>, Paging> }) & { signal?: AbortSignal };

type GetAll<P, Paging extends string> = <
  const Path extends keyof PathsFor<P, "get"> & string,
  Key extends ListKey<ApiResponse<PathsFor<P, "get">[Path]>>,
>(
  path: Path,
  key: Key,
  options?: ListOptions<PathsFor<P, "get">[Path], Paging>,
) => Promise<NonNullable<ApiResponse<PathsFor<P, "get">[Path]>[Key]>>;

/** A client that can also walk a page-numbered list to its end. */
export type PaginatedApiClient<P, Paging extends string> = ApiClient<P> & {
  /** Every item of a list: `getAll("/servers", "servers")`, typed from the response. */
  getAll: GetAll<P, Paging>;
};

export interface PageNumberPagination<PageParam extends string, SizeParam extends string, Page> {
  /** The query parameter holding the 1-based page number. */
  pageParam: PageParam;
  /** The query parameter holding the page size. */
  sizeParam: SizeParam;
  pageSize: number;
  /** The total a page reports, where the provider sends one; saves the last request. */
  total?: (page: Page) => number | null | undefined;
}

/**
 * Add `getAll` for a provider that pages by number. A list ends on an empty or
 * missing batch, a batch shorter than `pageSize`, or on reaching `total`. Cursor
 * and link-header providers need their own strategy; none has been migrated yet.
 */
export function withPagination<
  P,
  PageParam extends string,
  SizeParam extends string,
  Page = object,
>(
  client: ApiClient<P>,
  pagination: PageNumberPagination<PageParam, SizeParam, Page>,
): PaginatedApiClient<P, PageParam | SizeParam> {
  const { pageParam, sizeParam, pageSize, total } = pagination;
  // As in `createApiClient`: `getAll` is what the generic surface promises, and its
  // implementation walks pages of any path, which that surface cannot express.
  const get = client.get as unknown as (
    path: string,
    request: RequestOptions,
  ) => Promise<(Page & Record<string, unknown>) | undefined>;
  const getAll = async (path: string, key: string, request: RequestOptions = {}) => {
    const items: unknown[] = [];
    for (let page = 1; ; page++) {
      const query = { ...request.query, [pageParam]: page, [sizeParam]: pageSize };
      const body = await get(path, { ...request, query });
      const batch = body?.[key];
      if (!Array.isArray(batch) || batch.length === 0) return items;
      items.push(...batch);
      const reported = body && total?.(body);
      if (reported != null && items.length >= reported) return items;
      if (batch.length < pageSize) return items;
    }
  };
  return { ...client, getAll } as unknown as PaginatedApiClient<P, PageParam | SizeParam>;
}
