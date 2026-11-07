/**
 * A typed client over a provider's OpenAPI document. `paths` comes from plugingen
 * (the plugin's `plugingen.json`), and everything else is worked out from it in
 * this one file, so a plugin gets checked paths, query strings, bodies and
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
 *   const links = withLinkPagination(api, { next: nextLinkHeader(), maxPages: 25, foreignLinks: "follow" });
 *   const everyApp = await links.getAll(`/apps`, null);
 *
 *   await api.post(`/services`, { form: { FriendlyName: name, Sticky: true } });
 *
 *   const { headers } = await api.getResponse(`/servers`, { query: { per_page: 1 } });
 *   const { body: log } = await api.getText(`/jobs/${pathEncode(id)}/trace`);
 *
 * Requests go through `restRequest`, so bastion routing, custom CAs and the error
 * format are what every other plugin call gets.
 *
 * This checks what the provider's document promises and nothing more: a response
 * is not validated at runtime, because these documents are often wrong in small
 * ways and a sync that dies on an undocumented enum value helps nobody.
 */
import { restRequest, type RestResponse } from "./http.js";
import { ListPageError } from "./list-errors.js";
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

/** A media type that is JSON whatever it calls itself, such as `application/vnd.api+json`. */
type JsonMedia =
  | "text/json"
  | `application/json;${string}`
  | `application/${string}+json`
  | `application/${string}+json;${string}`;

/** The JSON form of a content map: `application/json` where there is one, or any other JSON type. */
type Json<Content> = Content extends { "application/json": infer Body }
  ? Body
  : { [K in keyof Content]: K extends JsonMedia ? Content[K] : never }[keyof Content];

type Form<Content> = Content extends { "application/x-www-form-urlencoded": infer Body }
  ? Body
  : never;

type QueryOf<Op> = Op extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

type BodyOf<Op> = Op extends { requestBody?: { content: infer C } } ? Json<C> : never;

type FormOf<Op> = Op extends { requestBody?: { content: infer C } } ? Form<C> : never;

/**
 * A request body as a call site may write it. `JSON.stringify` drops `undefined`,
 * so a top-level field may be `undefined` and is then simply not sent: form values
 * are `string | undefined` and the provider's own validation error is the better
 * message. A required key still has to be written, and its type still has to match.
 */
type Writable<Body> = { [K in keyof Body]: Body[K] | undefined };

/** The JSON body an operation takes, as a call site writes it. */
export type ApiBody<Op> = Writable<BodyOf<Op>>;

/** The form body an operation takes, as a call site writes it. */
export type ApiForm<Op> = Writable<FormOf<Op>>;

/** The JSON body of an operation's 2xx responses; `undefined` when there is none. */
export type ApiResponse<Op> = Op extends { responses: infer R }
  ? {
      [Code in keyof R]: `${Code & (string | number)}` extends `2${string}`
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

/**
 * The encoding comes from the document: `body` where it documents JSON, `form` where
 * it documents `application/x-www-form-urlencoded`, either where it documents both.
 * Each is only compulsory when the document requires a body. A required body in
 * anything else (multipart, octet-stream, YAML) cannot be written, so the call does
 * not compile rather than send nothing; those go through `restRequest`.
 */
type BodyOption<Op> = [BodyOf<Op>] extends [never]
  ? [FormOf<Op>] extends [never]
    ? Op extends { requestBody: object }
      ? { body: never }
      : object
    : Op extends { requestBody: object }
      ? { form: ApiForm<Op> }
      : { form?: ApiForm<Op> }
  : [FormOf<Op>] extends [never]
    ? Op extends { requestBody: object }
      ? { body: ApiBody<Op> }
      : { body?: ApiBody<Op> }
    : Op extends { requestBody: object }
      ? { body: ApiBody<Op>; form?: never } | { form: ApiForm<Op>; body?: never }
      : { body?: ApiBody<Op>; form?: never } | { form?: ApiForm<Op>; body?: never };

/** What any call can add: a version in `Accept`, an `If-Match`, a way to stop waiting. */
interface CallOptions {
  signal?: AbortSignal;
  /** Merged over the client's, and can replace them. */
  headers?: Record<string, string>;
}

type Options<Op> = QueryOption<Op> & BodyOption<Op> & CallOptions;

type Args<Op> = object extends Options<Op> ? [options?: Options<Op>] : [options: Options<Op>];

type Caller<P, M extends HttpMethod> = <const Path extends keyof PathsFor<P, M> & string>(
  path: Path,
  ...args: Args<PathsFor<P, M>[Path]>
) => Promise<ApiResponse<PathsFor<P, M>[Path]>>;

/** An operation's answer with its status and lower-cased headers, and the URL that was asked. */
export interface ApiAnswer<Body> extends RestResponse<Body> {
  url: string;
}

export type ApiClient<P> = { [M in HttpMethod]: Caller<P, M> } & {
  /** The provider's name, which a list walk's errors start with. */
  readonly vendor: string;
  /** `get`, answering with the status and headers too: `X-Total`, a rate limit. */
  getResponse: <const Path extends keyof PathsFor<P, "get"> & string>(
    path: Path,
    ...args: Args<PathsFor<P, "get">[Path]>
  ) => Promise<ApiAnswer<ApiResponse<PathsFor<P, "get">[Path]>>>;
  /**
   * `get`, leaving the body as it came: a log, or a call only made for its headers,
   * which then cannot fail on a body that is not JSON.
   */
  getText: <const Path extends keyof PathsFor<P, "get"> & string>(
    path: Path,
    ...args: Args<PathsFor<P, "get">[Path]>
  ) => Promise<ApiAnswer<string>>;
};

/** A non-2xx answer, for {@link ApiClientOptions.httpError}. */
export interface ApiFailure {
  status: number;
  /** Upper case, as sent. */
  method: string;
  /** The path as the call wrote it, with no query. A followed link gives its pathname. */
  path: string;
  /** `path` with the call's own query: what the default message names. */
  target: string;
  url: string;
  body: string;
  /** The next link as the provider wrote it, when following one is what failed. */
  link?: string;
}

/** A query or form value: nested objects go as `a[b]=c`, arrays as `a=x&a=y`. */
export type ParamValue =
  string | number | boolean | null | undefined | ParamValue[] | { [key: string]: ParamValue };

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
  /**
   * Write the call's query yourself, without the leading `?`, for a dialect the
   * default does not speak, such as indexed arrays (`a[0]=x`). `scopeQuery` still
   * follows it. `encodeQuery` is enough where only the escaping differs.
   */
  serializeQuery?: ((query: Record<string, ParamValue>) => string) | undefined;
  /**
   * Write a `form` body yourself, for a dialect the default does not speak. The
   * default is what {@link ParamValue} says, always form-encoded, whatever
   * `encodeQuery` does to the query.
   */
  serializeForm?: ((form: Record<string, ParamValue>) => string) | undefined;
  /**
   * Build what a non-2xx answer throws, for a plugin whose callers branch on the
   * status. The default is `Error("<vendor> API error <status> for <target>: <body>")`.
   */
  httpError?: ((failure: ApiFailure) => Error) | undefined;
  /** `"with-body"` sends `Content-Type` only on a request that has a body. See `restRequest`. */
  contentType?: "always" | "with-body" | undefined;
  /** A 2xx with no body is `undefined` in both transports. See `restRequest`. */
  emptyBodyIsUndefined?: boolean | undefined;
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
  const add = (name: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (isCommaSeparated(value)) parts.push(`${encode(name)}=${value.map(encode).join(",")}`);
      else for (const item of value) add(name, item);
    } else if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) add(`${name}[${key}]`, item);
    } else {
      parts.push(`${encode(name)}=${encode(value)}`);
    }
  };
  for (const [key, value] of Object.entries(query)) add(key, value);
  return parts;
}

// An unencoded segment can already hold a `?`, hence looking rather than assuming.
const withQuery = (target: string, parts: string[]) =>
  parts.length === 0 ? target : `${target}${target.includes("?") ? "&" : "?"}${parts.join("&")}`;

interface RequestOptions extends CallOptions {
  query?: Record<string, ParamValue>;
  body?: unknown;
  form?: Record<string, ParamValue>;
  /** `path` is a next link to send as it stands, and this is how the provider wrote it. */
  link?: string;
}

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

const isAbsoluteUrl = (value: string) => /^https?:\/\//i.test(value);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Build a client for one provider's document. */
export function createApiClient<P>(options: ApiClientOptions): ApiClient<P> {
  const encode = options.encodeQuery ?? encodeForm;
  const scope = queryParts(options.scopeQuery, encode);
  const { httpError, contentType, emptyBodyIsUndefined, http, caCert, vendor, baseUrl } = options;
  const { serializeQuery, serializeForm } = options;
  const ownQuery = (query: Record<string, ParamValue> | undefined): string[] => {
    if (!query || !serializeQuery) return queryParts(query, encode);
    const written = serializeQuery(query);
    return written ? [written] : [];
  };
  const send = async (
    method: HttpMethod,
    path: string,
    request: RequestOptions,
    responseAs?: "text",
  ): Promise<ApiAnswer<unknown>> => {
    const headers =
      typeof options.headers === "function" ? await options.headers() : options.headers;
    const followed = request.link !== undefined;
    const link = followed ? parseUrl(path) : undefined;
    const target = link
      ? `${link.pathname}${link.search}`
      : followed
        ? path
        : withQuery(path, ownQuery(request.query));
    const url = followed ? path : `${baseUrl}${withQuery(target, scope)}`;
    const verb = method.toUpperCase();
    const encodedForm = request.form
      ? (serializeForm?.(request.form) ?? queryParts(request.form, encodeForm).join("&"))
      : undefined;
    const answer = await restRequest<unknown>({
      vendor,
      url,
      // With the query: `/images` fails differently for `?type=system` and `?type=backup`.
      errorPath: target,
      headers,
      init: {
        method: verb,
        ...(encodedForm !== undefined
          ? { body: encodedForm }
          : request.body !== undefined
            ? { body: JSON.stringify(request.body) }
            : {}),
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.headers ? { headers: request.headers } : {}),
      },
      ...(http ? { http } : {}),
      ...(caCert ? { caCert } : {}),
      ...(contentType ? { contentType } : {}),
      ...(encodedForm !== undefined ? { bodyType: FORM_CONTENT_TYPE } : {}),
      ...(emptyBodyIsUndefined ? { emptyBodyIsUndefined } : {}),
      ...(responseAs ? { responseAs } : {}),
      ...(httpError
        ? {
            httpError: ({ status, body }: { status: number; body: string }) =>
              httpError({
                status,
                method: verb,
                path: link?.pathname ?? path,
                target,
                url,
                body,
                ...(request.link !== undefined ? { link: request.link } : {}),
              }),
          }
        : {}),
    });
    return { ...answer, url };
  };
  const call =
    (method: HttpMethod) =>
    async (path: string, request: RequestOptions = {}): Promise<unknown> =>
      (await send(method, path, request)).body;
  // The generic surface above is the point of this file; the implementation is
  // one function per verb and cannot express it.
  return {
    vendor,
    get: call("get"),
    put: call("put"),
    post: call("post"),
    delete: call("delete"),
    patch: call("patch"),
    getResponse: (path: string, request: RequestOptions = {}) => send("get", path, request),
    getText: (path: string, request: RequestOptions = {}) => send("get", path, request, "text"),
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

/**
 * What a list call may still put in `query` once the helper owns the paging
 * parameters. With none left there is no `query` at all: `Omit` would leave `{}`,
 * which accepts anything. A parameter the document requires stays compulsory.
 */
type ListQuery<Op, Paging extends string> = [QueryOf<Op>] extends [never]
  ? object
  : [keyof Omit<QueryOf<Op>, Paging>] extends [never]
    ? { query?: never }
    : object extends Omit<QueryOf<Op>, Paging>
      ? { query?: Omit<QueryOf<Op>, Paging> }
      : { query: Omit<QueryOf<Op>, Paging> };

type ListOptions<Op, Paging extends string> = ListQuery<Op, Paging> & CallOptions;

type ListArgs<Options> = object extends Options ? [options?: Options] : [options: Options];

/** What one `getAll` call can change about a walk. */
interface WalkOptions<Item> {
  pageSize?: number;
  maxPages?: number;
  /** End after a page this says is enough, such as one reaching past a time window. */
  stopWhen?: (batch: Item[]) => boolean;
}

type GetAll<P, Paging extends string> = <
  const Path extends keyof PathsFor<P, "get"> & string,
  Key extends ListKey<ApiResponse<PathsFor<P, "get">[Path]>>,
>(
  path: Path,
  key: Key,
  ...args: ListArgs<
    ListOptions<PathsFor<P, "get">[Path], Paging> &
      WalkOptions<ListItem<ApiResponse<PathsFor<P, "get">[Path]>, Key>>
  >
) => Promise<ListItem<ApiResponse<PathsFor<P, "get">[Path]>, Key>[]>;

/** A client that can also walk a page-numbered list to its end. */
export type PaginatedApiClient<P, Paging extends string> = ApiClient<P> & {
  /** Every item of a list: `getAll("/servers", "servers")`, typed from the response. */
  getAll: GetAll<P, Paging>;
};

/** What every dialect can say about a page that holds no list. Off means it throws. */
interface ListPageTolerance {
  /**
   * Read a 2xx with no body as the end of the list, for a provider documented to
   * answer an empty list that way. Off by default, so it throws a `ListPageError`:
   * the host prunes resources a sync stops seeing, and "no answer" is not "none".
   */
  emptyBodyEndsList?: boolean;
  /**
   * Read a body whose list key is absent or null as an empty page, for a provider
   * documented to leave the key out of an empty answer, as proto3 JSON does. Say so
   * in a comment. Off by default, so it throws a `ListPageError`: that is also what a
   * renamed key or an error wrapped in a 200 looks like. A value that is there but
   * is not an array throws either way.
   */
  missingListIsEmpty?: boolean;
}

export interface PageNumberPagination<
  PageParam extends string,
  SizeParam extends string,
  Page,
> extends ListPageTolerance {
  /** The query parameter holding the 1-based page number. */
  pageParam: PageParam;
  /** The query parameter holding the page size. */
  sizeParam: SizeParam;
  pageSize: number;
  /** The total a page reports, where the provider sends one; saves the last request. */
  total?: (page: Page) => number | null | undefined;
  /** Send the paging parameters before the caller's query, rather than after it. */
  pagingFirst?: boolean;
  /** Send the page size before the page number, rather than after it. */
  sizeFirst?: boolean;
  /** The most pages one list may take, so a provider ignoring the page number cannot loop forever. 1,000 by default. */
  maxPages?: number;
}

const DEFAULT_PAGE_NUMBER_MAX_PAGES = 1000;

/**
 * Add `getAll` for a provider that pages by number. A list ends on an empty batch,
 * a batch shorter than `pageSize`, or on reaching `total`, and a page with no list
 * throws. Cursors are {@link withCursorPagination}, next links {@link withLinkPagination}.
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
  const {
    pageParam,
    total,
    sizeFirst,
    maxPages = DEFAULT_PAGE_NUMBER_MAX_PAGES,
    ...rest
  } = pagination;
  const config: WalkConfig = {
    ...rest,
    cursorParam: pageParam,
    firstCursor: 1,
    cursorFirst: !sizeFirst,
    maxPages,
    stopOnShortPage: true,
    next: ({ cursor }) => Number(cursor) + 1,
    // Only called with a page the provider answered, which is what `Page` describes.
    ...(total ? { total: ({ body }) => total(body as Page) } : {}),
  };
  // The generic surface is what `getAll` promises; the walk takes any path.
  return { ...client, getAll: walkPages(client, config) } as unknown as PaginatedApiClient<
    P,
    PageParam | SizeParam
  >;
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

/** One page as it arrived, for a {@link NextPage} to read. */
export interface PageAnswer {
  /** Lower-cased names. */
  headers: Record<string, string>;
  body: unknown;
  /** The page's list. */
  items: readonly unknown[];
  /** The cursor that fetched this page, as a string, or the link it came from. */
  cursor: string | undefined;
  pageSize: number | undefined;
}

/** Work out what follows a page from all of it, where no one field says. Falsy ends the list. */
export type NextPage = (page: PageAnswer) => string | number | null | undefined;

/**
 * Where the next cursor is: a field of the response by dotted path, a field of the
 * page's last item, or anything a function can read from the page. A function is
 * not checked against the document, so reach for it only when a field will not do.
 */
type CursorSource = string | { lastItem: string } | NextPage;

export interface CursorPagination<
  CursorParam extends string = string,
  SizeParam extends string = string,
  Next extends CursorSource = CursorSource,
  HasMore extends string = string,
> extends ListPageTolerance {
  /** The query parameter the cursor is sent back in. */
  cursorParam: CursorParam;
  /** Sent on the first request, for a provider that numbers pages and expects `page=1`. */
  firstCursor?: string | number;
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
  /** Send the paging parameters before the caller's query, rather than after it. */
  pagingFirst?: boolean;
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
   * End once this many rows have been read, for a provider that reports its total:
   * a field of the response by dotted path, or a function over the page. Saves the
   * last request on an offset list, and is not checked against the document.
   */
  total?: string | ((page: PageAnswer) => number | string | null | undefined);
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
    : Source extends NextPage
      ? string
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

type QueryHas<Op, Name> = [Name] extends [never]
  ? true
  : [QueryOf<Op>] extends [never]
    ? false
    : [Name] extends [keyof QueryOf<Op>]
      ? true
      : false;

/** The list keys of `Op` under `D`, or `never` where `D` does not describe `Op`. */
type CursorListsOf<Op, D extends CursorDialect> = [
  // An absent parameter or `hasMore` is `never`, which asks nothing of `Op`.
  QueryHas<Op, D["cursorParam"]>,
  QueryHas<Op, D["sizeParam"]>,
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
  ...args: ListArgs<
    ListOptions<PathsFor<P, "get">[Path], D["cursorParam"] | D["sizeParam"]> &
      WalkOptions<ListItem<ApiResponse<PathsFor<P, "get">[Path]>, Key>>
  >
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

type CursorRequest = RequestOptions & WalkOptions<unknown>;

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
 *   next: ({ headers }) => headers["x-next-page"]               // anything else on the page
 *
 * A list ends on an empty batch, a falsy cursor, a falsy `hasMore`, on reaching
 * `total`, or at `maxPages`, and a page with no list throws. A cursor is sent back
 * after the caller's query and the page size.
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
  // The generic surface is what `getAll` promises; the walk takes any path.
  return { ...client, getAll: walkPages(client, config) } as unknown as CursorApiClient<
    P,
    { cursorParam: CursorParam; sizeParam: SizeParam; next: Next; hasMore: HasMore }
  >;
}

/** What a list walk reads from its configuration, whichever way it follows a page. */
type WalkConfig = Omit<CursorPagination, "cursorParam"> & {
  cursorParam?: string;
  /** Send the cursor before the page size, as a page number conventionally goes. */
  cursorFirst?: boolean;
  foreignLinks?: ForeignLinks;
  resolveLink?: ResolveLink;
};

/** What a page holds under `key`, reading nothing out of a body that is not an object. */
function listAt(body: unknown, key: string | null): unknown {
  if (key === null) return body;
  return typeof body === "object" && body !== null ? Reflect.get(body, key) : undefined;
}

function reportedTotal(total: WalkConfig["total"], page: PageAnswer): number | undefined {
  const value = typeof total === "function" ? total(page) : total && readField(page.body, total);
  if (value === null || value === undefined || value === "") return undefined;
  const count = Number(value);
  return Number.isFinite(count) ? count : undefined;
}

function walkPages<P>(client: ApiClient<P>, config: WalkConfig) {
  const { cursorParam, sizeParam, next, hasMore, readCursor, onTruncated, foreignLinks } = config;
  const { resolveLink, pagingFirst, total, cursorFirst } = config;
  // As in `createApiClient`: the implementation walks any path.
  const getResponse = client.getResponse as unknown as (
    path: string,
    request: RequestOptions,
  ) => Promise<ApiAnswer<unknown>>;
  return async (path: string, key: string | null, request: CursorRequest = {}) => {
    const { pageSize = config.pageSize, maxPages = config.maxPages, query } = request;
    const { signal, headers: callHeaders } = request;
    const items: unknown[] = [];
    let cursor = config.firstCursor === undefined ? undefined : String(config.firstCursor);
    let written: string | undefined;
    let origin: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      // A link already holds every parameter the list needs.
      const link = cursorParam === undefined ? cursor : undefined;
      const sizing =
        sizeParam !== undefined && pageSize !== undefined ? { [sizeParam]: pageSize } : {};
      const paging = {
        ...(cursorFirst ? {} : sizing),
        ...(cursorParam !== undefined && cursor !== undefined ? { [cursorParam]: cursor } : {}),
        ...(cursorFirst ? sizing : {}),
      };
      const { body, headers, url } = await getResponse(link ?? path, {
        ...(link === undefined
          ? { query: pagingFirst ? { ...paging, ...query } : { ...query, ...paging } }
          : { link: written ?? link }),
        ...(signal ? { signal } : {}),
        ...(callHeaders ? { headers: callHeaders } : {}),
      });
      origin ??= new URL(url).origin;
      const noBody = body === null || body === undefined;
      if (noBody && config.emptyBodyEndsList) return items;
      const batch = listAt(body, key);
      const absent = !noBody && (batch === null || batch === undefined);
      if (!Array.isArray(batch) && !(absent && config.missingListIsEmpty)) {
        throw new ListPageError({ vendor: client.vendor, path, key, found: batch, page: body });
      }
      const list: unknown[] = Array.isArray(batch) ? batch : [];
      if (list.length === 0 && !config.continueOnEmptyPage) return items;
      items.push(...list);

      if (request.stopWhen?.(list)) return items;
      if (hasMore !== undefined && !readField(body, hasMore)) return items;
      if (config.stopOnShortPage && pageSize !== undefined && list.length < pageSize) return items;
      const answer: PageAnswer = { headers, body, items: list, cursor, pageSize };
      const reported = reportedTotal(total, answer);
      if (reported !== undefined && items.length >= reported) return items;

      const found =
        typeof next === "function"
          ? next(answer)
          : typeof next === "string"
            ? readField(body, next)
            : readField(list[list.length - 1], next.lastItem);
      if (!found) return items;
      const value = String(found);
      const following =
        cursorParam !== undefined
          ? readCursor
            ? readCursor(value)
            : value
          : resolveLink
            ? // What the document calls a string, unvalidated like everything else here.
              resolveLink(found as string)
            : isAbsoluteUrl(value)
              ? value
              : new URL(value, url).href;
      if (!following) return items;
      if (config.stopOnRepeatedCursor && following === cursor) return items;
      if (cursorParam === undefined && foreignLinks === "refuse") {
        const target = new URL(following).origin;
        if (target !== origin) {
          throw new Error(
            `Refusing to follow the next page of ${path} from ${origin} to ${target}`,
          );
        }
      }
      written = value;
      cursor = following;
    }
    onTruncated?.({ path, items: items.length, maxPages });
    return items;
  };
}

/** What to do about a next link to another host, which would carry the credentials there. */
export type ForeignLinks = "follow" | "refuse";

/** Turn a link as the provider wrote it into the URL to ask for. Empty or null ends the list. */
export type ResolveLink = (link: string) => string | null | undefined;

export interface LinkPagination<
  SizeParam extends string = string,
  Next = string | NextPage,
> extends Omit<
  CursorPagination<never, SizeParam>,
  "cursorParam" | "firstCursor" | "next" | "readCursor" | "hasMore"
> {
  /**
   * Where each page names the next one: {@link nextLinkHeader}, or a field of the
   * response by dotted path, such as `next_page_uri`. A falsy value ends the list.
   */
  next: Next;
  /**
   * Whether to follow a link to another origin, with the client's headers on it.
   * No default: `"follow"` is what the plugins' own loops did, `"refuse"` throws
   * rather than return part of a list, and a migrator has to say which it wants.
   */
  foreignLinks: ForeignLinks;
  /**
   * Replace how a link is read. By default an absolute link is sent as written and
   * any other resolves against the page it came from, as a browser would, so `//x/y`
   * is another host. An old loop that wrote `${host}${link}` keeps its URLs with this.
   */
  resolveLink?: ResolveLink;
}

/**
 * Add `getAll` for a provider that names the next page by URL. The first request
 * is the path with its query and page size, and each one after it is the link
 * exactly as the provider wrote it, so the client's `scopeQuery` is not added to
 * it. A relative link resolves against the page it came from. Termination and the
 * per-call options are {@link withCursorPagination}'s.
 *
 *   next: nextLinkHeader()                                      // RFC 8288 `rel="next"`
 *   next: nextLinkHeader({ when: (l) => l["results"] === "true" }) // a link that may be empty
 *   next: "meta.next_page_url"                                  // a field of the response
 *
 * A link whose cursor should go back as a parameter, rather than be followed, is
 * `withCursorPagination` with `next: nextLinkHeader()` and `readCursor`.
 */
export function withLinkPagination<
  P,
  const Next extends string | NextPage,
  SizeParam extends string = never,
>(
  client: ApiClient<P>,
  pagination: LinkPagination<SizeParam, Next> &
    DescribesSomething<P, { cursorParam: never; sizeParam: SizeParam; next: Next; hasMore: never }>,
): CursorApiClient<P, { cursorParam: never; sizeParam: SizeParam; next: Next; hasMore: never }> {
  const config: WalkConfig = pagination;
  // As in `withCursorPagination`.
  return { ...client, getAll: walkPages(client, config) } as unknown as CursorApiClient<
    P,
    { cursorParam: never; sizeParam: SizeParam; next: Next; hasMore: never }
  >;
}

/** One link of an RFC 8288 `Link` header, with its parameters by lower-cased name. */
export interface WebLink {
  url: string;
  params: Record<string, string>;
}

/**
 * Parse a `Link` header. Commas and semicolons can sit inside a URL or a quoted
 * parameter (a cursor like `0:100:0` is usually quoted), so it cannot be split.
 */
export function parseLinkHeader(header: string | undefined): WebLink[] {
  if (!header) return [];
  const links: WebLink[] = [];
  const link = /<([^>]*)>((?:\s*;\s*[^\s;,=]+(?:\s*=\s*(?:"[^"]*"|[^\s;,]*))?)*)/g;
  for (const [, url, rest] of header.matchAll(link)) {
    const params: Record<string, string> = {};
    for (const [, name, quoted, plain] of (rest ?? "").matchAll(
      /;\s*([^\s;,=]+)(?:\s*=\s*(?:"([^"]*)"|([^\s;,]*)))?/g,
    )) {
      // RFC 8288: the first occurrence of a parameter wins.
      params[name!.toLowerCase()] ??= quoted ?? plain ?? "";
    }
    links.push({ url: url ?? "", params });
  }
  return links;
}

/**
 * Read the next page from a `Link` header: the first link whose `rel` holds `rel`
 * (`next` by default, any case, among several). `when` looks at its parameters, for
 * a provider that always sends the link and says elsewhere whether it leads anywhere.
 */
export function nextLinkHeader(
  options: { rel?: string; when?: (params: Record<string, string>) => boolean } = {},
): NextPage {
  const rel = (options.rel ?? "next").toLowerCase();
  return ({ headers }) => {
    const link = parseLinkHeader(headers["link"]).find(({ params }) =>
      (params["rel"] ?? "").toLowerCase().split(/\s+/).includes(rel),
    );
    return link && (!options.when || options.when(link.params)) ? link.url : undefined;
  };
}
