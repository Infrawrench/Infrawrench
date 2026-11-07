import {
  createApiClient,
  ListTruncatedError,
  requireListPage,
  unencodedSegment,
  type ApiClient,
  type ApiListItem,
  type HttpHostServices,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

export const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The legacy `?key=` query parameter also works, but the header keeps the key
 * out of URLs, proxy logs and error messages.
 */
export function geminiHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey, Accept: "application/json" };
}

export type GeminiApi = ApiClient<paths>;

export function createGeminiApi(
  apiKey: string,
  http: HttpHostServices | undefined,
  caCert: string | undefined,
): GeminiApi {
  return createApiClient<paths>({
    vendor: "Gemini",
    baseUrl: BASE_URL,
    headers: geminiHeaders(apiKey),
    http,
    caCert,
  });
}

/** The name that follows `models/` in a picker value (`models/x` or `x`), sent as given. */
export function modelSegment(model: string): NoSlashString {
  return unencodedSegment(model.startsWith("models/") ? model.slice("models/".length) : model);
}

/** One page's paging parameters, in the order they go on the wire. */
export interface PageQuery {
  pageSize: number;
  pageToken?: string;
}

/** A list where part of it is fine, and how far to read it. */
export interface ListBound {
  maxPages: number;
  partial: true;
}

/** For pickers and create-form options, which offer what they read. Nothing is pruned from them. */
export const PICKER_LIST: ListBound = { maxPages: 25, partial: true };

/**
 * Rows a list may hold before it throws, as pages at its own page size. The lists at
 * 1000 per page have always read this many, and a cap costs nothing until a list is that long.
 */
const MAX_LIST_ROWS = 25_000;

interface ListRead extends Partial<ListBound> {
  path: string;
  key: string;
  pageSize: number;
}

async function walkPages<Page, Item>(
  read: ListRead,
  tokenKey: string,
  getPage: (pageToken: string | undefined) => Promise<Page>,
  pick: (page: Page) => readonly Item[] | null | undefined,
  nextToken: (page: Page) => string | undefined,
): Promise<Item[]> {
  const { path, key, pageSize, partial } = read;
  const maxPages = read.maxPages ?? Math.ceil(MAX_LIST_ROWS / pageSize);
  const items: Item[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await getPage(pageToken);
    const answered = typeof data === "object" && data !== null && !Array.isArray(data);
    const list = answered ? pick(data) : undefined;
    // proto3 JSON leaves an empty repeated field out, so `{}` is how an empty account
    // answers. Anything else in its place is a renamed key or an error wrapped in a 200.
    const omitted =
      answered && list === undefined && Object.keys(data).every((field) => field === tokenKey);
    const where = { vendor: "Gemini", path, key, page: data };
    items.push(...requireListPage(omitted ? [] : list, where));
    const next = nextToken(data);
    if (!next) return items;
    // Responses are not validated, and a token goes back in its string form.
    pageToken = String(next);
  }
  if (partial) return items;
  throw new ListTruncatedError({ vendor: "Gemini", path, items: items.length, maxPages });
}

/**
 * Walk a Google-standard `pageSize` / `pageToken` → `nextPageToken` list.
 * Page-size defaults and caps vary per collection, so callers pass their own.
 *
 * This is a loop over `get` rather than `withCursorPagination`, because some of these
 * lists are not on a typed path, and `missingListIsEmpty` would read a renamed key as
 * an empty account. A page may also be empty with a token, which does not end the list.
 */
export function listPages<Page extends { nextPageToken?: string }, Item>(
  read: ListRead,
  getPage: (query: PageQuery) => Promise<Page>,
  pick: (page: Page) => readonly Item[] | null | undefined,
): Promise<Item[]> {
  return walkPages(
    read,
    "nextPageToken",
    (pageToken) =>
      getPage({ pageSize: read.pageSize, ...(pageToken !== undefined ? { pageToken } : {}) }),
    pick,
    (page) => page.nextPageToken,
  );
}

/**
 * The same walk for the newer snake_case surfaces (webhooks, voices), which take
 * `page_size` / `page_token` and answer with `next_page_token`.
 */
export function listSnakePages<Page extends { next_page_token?: string }, Item>(
  read: ListRead,
  getPage: (pageToken: string | undefined) => Promise<Page>,
  pick: (page: Page) => readonly Item[] | null | undefined,
): Promise<Item[]> {
  return walkPages(read, "next_page_token", getPage, pick, (page) => page.next_page_token);
}

export type GeminiModel = ApiListItem<operations["ListModels"], "models">;
export type TunedModel = ApiListItem<operations["ListTunedModels"], "tunedModels">;
export type GeminiFile = ApiListItem<operations["ListFiles"], "files">;
export type CachedContent = ApiListItem<operations["ListCachedContents"], "cachedContents">;
export type BatchOperation = ApiListItem<operations["ListOperationsBy"], "operations">;
export type FileSearchStore = ApiListItem<operations["ListFileSearchStores"], "fileSearchStores">;
export type FileSearchDocument = ApiListItem<operations["ListDocuments"], "documents">;
