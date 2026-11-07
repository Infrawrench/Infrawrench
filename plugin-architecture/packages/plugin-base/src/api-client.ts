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
 *   const cursors = withCursorPagination(api, {
 *     cursorParam: "after", sizeParam: "limit", pageSize: 100, maxPages: 50, next: "meta.next_cursor",
 *   });
 *   const everyUser = await cursors.getAll(`/users`, "users");
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

/**
 * A path segment sent exactly as given. Only for keeping a migrated plugin's
 * requests byte-identical where it never encoded the segment, which is a bug to
 * fix on its own: a value holding `/` or `?` changes which route gets called.
 */
export function unencodedSegment(value: string): NoSlashString {
  return value as NoSlashString;
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
  /**
   * Query parameters every request carries, such as the team an account is scoped
   * to. They go after the call's own and stay out of error messages, so an id in
   * them does not end up in a log line. A null or undefined value is not sent.
   */
  scopeQuery?: Record<string, string | null | undefined> | undefined;
  /**
   * How query names and values are encoded. The default is form encoding, as
   * `URLSearchParams` does it (a space becomes `+`); pass `encodeURIComponent` for
   * a provider that wants `%20`, or to keep an old client's requests identical.
   */
  encodeQuery?: ((value: string) => string) | undefined;
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
const encodeForm = (value: string) => new URLSearchParams({ "": value }).toString().slice(1);

function queryParts(query: object | undefined, encodeText: (value: string) => string): string[] {
  if (!query) return [];
  const encode = (value: unknown) => encodeText(String(value));
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const name = encode(key);
    if (!Array.isArray(value)) parts.push(`${name}=${encode(value)}`);
    else if (isCommaSeparated(value)) parts.push(`${name}=${value.map(encode).join(",")}`);
    else for (const item of value) parts.push(`${name}=${encode(item)}`);
  }
  return parts;
}

// An unencoded segment can already hold a `?`, hence looking rather than assuming.
const withQuery = (target: string, parts: string[]) =>
  parts.length === 0 ? target : `${target}${target.includes("?") ? "&" : "?"}${parts.join("&")}`;

interface RequestOptions {
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
}

/** Build a client for one provider's document. */
export function createApiClient<P>(options: ApiClientOptions): ApiClient<P> {
  const encode = options.encodeQuery ?? encodeForm;
  const scope = queryParts(options.scopeQuery, encode);
  const send =
    (method: HttpMethod) =>
    async (path: string, request: RequestOptions = {}): Promise<unknown> => {
      const headers =
        typeof options.headers === "function" ? await options.headers() : options.headers;
      const target = withQuery(path, queryParts(request.query, encode));
      return jsonRestFetch<unknown>({
        vendor: options.vendor,
        url: `${options.baseUrl}${withQuery(target, scope)}`,
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

/**
 * What a list can be collected by: a key holding an array on any member of the
 * response union, or `null` where the response is itself the array.
 */
type ListKey<Response> = Response extends readonly unknown[]
  ? null
  : Response extends object
    ? {
        [K in keyof Response & string]-?: NonNullable<Response[K]> extends readonly unknown[]
          ? K
          : never;
      }[keyof Response & string]
    : never;

/** One item of the list at `Key`, across every union member that has it. */
type ListItem<Response, Key> = Response extends readonly (infer Item)[]
  ? Key extends null
    ? Item
    : never
  : Response extends object
    ? Key extends keyof Response
      ? NonNullable<Response[Key]> extends readonly (infer Item)[]
        ? Item
        : never
      : never
    : never;

/** One item of an operation's list, for naming what a mapper takes. */
export type ApiListItem<Op, Key extends ListKey<ApiResponse<Op>>> = ListItem<ApiResponse<Op>, Key>;

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
) => Promise<ListItem<ApiResponse<PathsFor<P, "get">[Path]>, Key>[]>;

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
 * missing batch, a batch shorter than `pageSize`, or on reaching `total`. Cursors
 * are {@link withCursorPagination}; link-header providers need their own strategy,
 * and none has been migrated yet.
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
  const getAll = async (path: string, key: string | null, request: RequestOptions = {}) => {
    const items: unknown[] = [];
    for (let page = 1; ; page++) {
      const query = { ...request.query, [pageParam]: page, [sizeParam]: pageSize };
      const body = await get(path, { ...request, query });
      const batch = key === null ? body : body?.[key];
      if (!Array.isArray(batch) || batch.length === 0) return items;
      items.push(...batch);
      const reported = body && total?.(body);
      if (reported != null && items.length >= reported) return items;
      if (batch.length < pageSize) return items;
    }
  };
  return { ...client, getAll } as unknown as PaginatedApiClient<P, PageParam | SizeParam>;
}

/** The value at a dotted path, through whichever union members have it. */
type FieldAt<T, Path extends string> = T extends readonly unknown[]
  ? never
  : T extends object
    ? Path extends `${infer Head}.${infer Rest}`
      ? Head extends keyof T
        ? FieldAt<NonNullable<T[Head]>, Rest>
        : never
      : Path extends keyof T
        ? T[Path]
        : never
    : never;

/**
 * Where the next cursor is: a field of the response by dotted path, or a field of
 * the page's last item.
 */
type CursorSource = string | { lastItem: string };

export interface CursorPagination<
  CursorParam extends string = string,
  SizeParam extends string = string,
  Next extends CursorSource = CursorSource,
  HasMore extends string = string,
> {
  /** The query parameter the cursor is sent back in. */
  cursorParam: CursorParam;
  /** Where each page says what comes next. A falsy value ends the list. */
  next: Next;
  /**
   * The most pages one list may take. A list that reaches it returns what it has,
   * so this is also what stops a provider repeating a cursor from looping forever.
   */
  maxPages: number;
  /** The query parameter holding the page size, for a provider that takes one. */
  sizeParam?: SizeParam;
  pageSize?: number;
  /** A field that must be truthy for another page to be asked for. */
  hasMore?: HasMore;
  /** Pull the cursor out of what `next` found, such as a `page[after]` in a link. */
  readCursor?: (value: string) => string | null | undefined;
  /** End on a page shorter than `pageSize`, for a provider with no other signal. */
  stopOnShortPage?: boolean;
  /** End when a page hands back the cursor that fetched it. */
  stopOnRepeatedCursor?: boolean;
  /** Keep following the cursor past an empty page, as gRPC-backed lists require. */
  continueOnEmptyPage?: boolean;
  /**
   * Read a 2xx with no body as the end of the list. Off by default, so it throws:
   * the host prunes resources a sync stops seeing, and "no answer" is not "none".
   */
  emptyBodyEndsList?: boolean;
  /** Told when a list stops at `maxPages` with a cursor still in hand. */
  onTruncated?: (info: { path: string; items: number; maxPages: number }) => void;
}

/** The parts of a {@link CursorPagination} the types are worked out from. */
export interface CursorDialect {
  cursorParam: string;
  sizeParam: string;
  next: CursorSource;
  hasMore: string;
}

type CursorAt<Response, Key, Source> = Source extends { lastItem: infer Field extends string }
  ? FieldAt<ListItem<Response, Key>, Field>
  : Source extends string
    ? FieldAt<Response, Source>
    : never;

/** Is `T` a value that is present on some union member, and only ever `Allowed`? */
type Holds<T, Allowed> = [NonNullable<T>] extends [never]
  ? false
  : [NonNullable<T>] extends [Allowed]
    ? true
    : false;

/** The lists of a response this pagination can walk: their cursor reads as text or a number. */
type CursorListKey<Response, Source, Key = ListKey<Response>> = Key extends unknown
  ? Holds<CursorAt<Response, Key, Source>, string | number> extends true
    ? Key
    : never
  : never;

type QueryHas<Op, Name> = [QueryOf<Op>] extends [never]
  ? false
  : [Name] extends [keyof QueryOf<Op>]
    ? true
    : false;

/** The list keys of `Op` under `D`, or `never` where `D` does not describe `Op`. */
type CursorListsOf<Op, D extends CursorDialect> = [
  QueryHas<Op, D["cursorParam"]>,
  // An absent size parameter or `hasMore` is `never`, which asks nothing of `Op`.
  [D["sizeParam"]] extends [never] ? true : QueryHas<Op, D["sizeParam"]>,
  [D["hasMore"]] extends [never] ? true : Holds<FieldAt<ApiResponse<Op>, D["hasMore"]>, boolean>,
] extends [true, true, true]
  ? CursorListKey<ApiResponse<Op>, D["next"]>
  : never;

/** The GET operations `D` describes: everything else is a compile error at `getAll`. */
type CursorPaths<P, D extends CursorDialect> = {
  [
    K in keyof PathsFor<P, "get"> & string as [CursorListsOf<PathsFor<P, "get">[K], D>] extends [
      never,
    ]
      ? never
      : K
  ]: PathsFor<P, "get">[K];
};

/** Fails a configuration no operation in the document matches, such as a misspelt field. */
type DescribesSomething<P, D extends CursorDialect> = [keyof CursorPaths<P, D>] extends [never]
  ? { next: never }
  : unknown;

type CursorGetAll<P, D extends CursorDialect> = <
  const Path extends keyof CursorPaths<P, D> & string,
  Key extends CursorListsOf<PathsFor<P, "get">[Path], D>,
>(
  path: Path,
  key: Key,
  options?: ListOptions<PathsFor<P, "get">[Path], D["cursorParam"] | D["sizeParam"]> & {
    pageSize?: number;
    maxPages?: number;
  },
) => Promise<ListItem<ApiResponse<PathsFor<P, "get">[Path]>, Key>[]>;

/** A client that can also walk a cursor-paged list to its end. */
export type CursorApiClient<P, D extends CursorDialect> = ApiClient<P> & {
  /**
   * Every item of a list: `getAll("/users", "users")`, or `getAll("/users", null)`
   * where the response is the array. Typed from the response, and only operations
   * the pagination's `cursorParam`, `sizeParam`, `next` and `hasMore` fit are allowed.
   */
  getAll: CursorGetAll<P, D>;
};

interface CursorRequest extends RequestOptions {
  pageSize?: number;
  maxPages?: number;
}

/** Walk a dotted path through a body that has not been validated. */
function readField(from: unknown, path: string): unknown {
  let value = from;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = Reflect.get(value, segment);
  }
  return value;
}

/**
 * Add `getAll` for a provider that pages by cursor. One provider can have several
 * dialects, such as a `from` token on one route and an `until` timestamp on the
 * rest: make one client per dialect, and each only accepts the routes it fits.
 *
 *   next: "pagination.next"                                     // a field of the response
 *   next: { lastItem: "id" }, hasMore: "has_more"               // Stripe-style
 *   next: "links.next", readCursor: (link) => ...               // a cursor inside a URL
 *
 * A list ends on a missing or empty batch, a falsy cursor, a falsy `hasMore`, or at
 * `maxPages`. A cursor is sent back after the caller's query and the page size.
 */
export function withCursorPagination<
  P,
  CursorParam extends string,
  const Next extends CursorSource,
  SizeParam extends string = never,
  HasMore extends string = never,
>(
  client: ApiClient<P>,
  pagination: CursorPagination<CursorParam, SizeParam, Next, HasMore> &
    DescribesSomething<
      P,
      { cursorParam: CursorParam; sizeParam: SizeParam; next: Next; hasMore: HasMore }
    >,
): CursorApiClient<
  P,
  { cursorParam: CursorParam; sizeParam: SizeParam; next: Next; hasMore: HasMore }
> {
  const config: CursorPagination = pagination;
  const { cursorParam, sizeParam, next, hasMore, readCursor, onTruncated } = config;
  // As in `withPagination`: the implementation walks any path.
  const get = client.get as unknown as (
    path: string,
    request: RequestOptions,
  ) => Promise<Record<string, unknown>>;
  const getAll = async (path: string, key: string | null, request: CursorRequest = {}) => {
    const { pageSize = config.pageSize, maxPages = config.maxPages, query, signal } = request;
    const items: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const body = await get(path, {
        query: {
          ...query,
          ...(sizeParam !== undefined && pageSize !== undefined ? { [sizeParam]: pageSize } : {}),
          ...(cursor !== undefined ? { [cursorParam]: cursor } : {}),
        },
        ...(signal ? { signal } : {}),
      });
      if (config.emptyBodyEndsList && (body === null || body === undefined)) return items;
      // Not `body?.[key]`: see `emptyBodyEndsList`.
      const batch: unknown = key === null ? body : body[key];
      const list: unknown[] = Array.isArray(batch) ? batch : [];
      if (list.length === 0 && !config.continueOnEmptyPage) return items;
      items.push(...list);

      if (hasMore !== undefined && !readField(body, hasMore)) return items;
      if (config.stopOnShortPage && pageSize !== undefined && list.length < pageSize) return items;

      const found =
        typeof next === "string"
          ? readField(body, next)
          : readField(list[list.length - 1], next.lastItem);
      if (!found) return items;
      const following = readCursor ? readCursor(String(found)) : String(found);
      if (!following) return items;
      if (config.stopOnRepeatedCursor && following === cursor) return items;
      cursor = following;
    }
    onTruncated?.({ path, items: items.length, maxPages });
    return items;
  };
  return { ...client, getAll } as unknown as CursorApiClient<
    P,
    { cursorParam: CursorParam; sizeParam: SizeParam; next: Next; hasMore: HasMore }
  >;
}
