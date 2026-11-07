import {
  createApiClient,
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

/**
 * Walk a Google-standard `pageSize` / `pageToken` → `nextPageToken` list.
 * Page-size defaults and caps vary per collection, so callers pass their own.
 *
 * This is a loop over `get` rather than `withCursorPagination`, because `getAll`
 * reads a list that is not an array as empty. Here it throws, which keeps the
 * host from pruning everything a sync stopped seeing.
 */
export async function listPages<Page extends { nextPageToken?: string }, Item>(
  pageSize: number,
  getPage: (query: PageQuery) => Promise<Page>,
  pick: (page: Page) => readonly Item[] | undefined,
): Promise<Item[]> {
  const items: Item[] = [];
  let pageToken: string | undefined;
  // Bounded so a pathological cursor cannot spin forever.
  for (let page = 0; page < 25; page += 1) {
    const data = await getPage({ pageSize, ...(pageToken !== undefined ? { pageToken } : {}) });
    items.push(...(pick(data) ?? []));
    if (!data.nextPageToken) break;
    // Responses are not validated, and a token goes back in its string form.
    pageToken = String(data.nextPageToken);
  }
  return items;
}

export type GeminiModel = ApiListItem<operations["ListModels"], "models">;
export type TunedModel = ApiListItem<operations["ListTunedModels"], "tunedModels">;
export type GeminiFile = ApiListItem<operations["ListFiles"], "files">;
export type CachedContent = ApiListItem<operations["ListCachedContents"], "cachedContents">;
export type BatchOperation = ApiListItem<operations["ListOperationsBy"], "operations">;
export type FileSearchStore = ApiListItem<operations["ListFileSearchStores"], "fileSearchStores">;
export type FileSearchDocument = ApiListItem<operations["ListDocuments"], "documents">;
