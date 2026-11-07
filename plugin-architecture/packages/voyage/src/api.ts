import {
  createApiClient,
  ListTruncatedError,
  withCursorPagination,
  type ApiResponse,
  type CursorApiClient,
  type HttpHostServices,
  type NextPage,
  type PageAnswer,
} from "@infrawrench/plugin-base";
import type { operations, paths } from "./api-types.gen.js";

/** Voyage API v1. */
export const API_BASE = "https://api.voyageai.com/v1";

const VENDOR = "Voyage AI";

/** `/batches` documents a `limit` of up to 100. 50,000 rows, the most an inventory list goes up to. */
const PAGE_SIZE = 100;
const MAX_PAGES = 500;

/** `/files` documents a `limit` of up to 10,000, so the same 50,000 rows take far fewer requests. */
export const FILE_PAGES = { pageSize: 10_000, maxPages: 5 };

/** A create form's file picker: `/files` documents newest first, so one page is what it wants. */
export const FILE_PICKER_PAGES = { pageSize: 10_000, maxPages: 1, partial: true };

export type VoyageApi = CursorApiClient<
  paths,
  { cursorParam: "after"; sizeParam: "limit"; next: NextPage; hasMore: "has_more" }
>;

/** An operation's response, by its `operationId`. */
export type VoyageResponse<Op extends keyof operations> = ApiResponse<operations[Op]>;

export type Batch = VoyageResponse<"retrieve-batch">;
export type VoyageFile = VoyageResponse<"retrieve-file">;

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `last_id`, or the last row's id where it is missing. `has_more` said there is more,
 * so having neither is thrown: ending here would read the rest as deleted.
 */
function nextAfter({ body, items }: PageAnswer): string {
  const next = text(fieldOf(body, "last_id")) ?? text(fieldOf(items[items.length - 1], "id"));
  if (next) return next;
  throw new ListTruncatedError({ vendor: VENDOR, path: "this list", items: items.length });
}

export function createVoyageApi(options: {
  apiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}): VoyageApi {
  const { apiKey, caCert, http } = options;
  const api = createApiClient<paths>({
    vendor: VENDOR,
    baseUrl: API_BASE,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    encodeQuery: encodeURIComponent,
    // Errors have always named the path without its query.
    httpError: ({ status, path, body }) =>
      new Error(`Voyage AI API error ${status} for ${path}: ${body}`),
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  });
  return withCursorPagination(api, {
    cursorParam: "after",
    sizeParam: "limit",
    pageSize: PAGE_SIZE,
    maxPages: MAX_PAGES,
    next: nextAfter,
    hasMore: "has_more",
    // Both lists document `has_more` as what says more is available, so an empty page
    // that still sets it has not ended the list.
    continueOnEmptyPage: true,
  });
}
