import {
  createApiClient,
  withCursorPagination,
  type ApiBody,
  type ApiListItem,
  type ApiResponse,
  type CursorApiClient,
  type HttpHostServices,
  type PageAnswer,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

export const BASE_URL = "https://openrouter.ai/api/v1";

export type OrModel = ApiListItem<operations["getModels"], "data">;
/** `GET /models/{author}/{slug}/endpoints`: a model's identity and all of its endpoints. */
export type OrModelDetail = ApiResponse<operations["listEndpoints"]>["data"];
/**
 * What the model mapper reads. A catalogue row has all of it, and the detail
 * answer above only `id`, `name`, `created`, `description` and `architecture`.
 */
export type OrModelFields = Pick<OrModel, "id"> & Partial<Omit<OrModel, "id" | "endpoints">>;
export type OrEndpoint = OrModelDetail["endpoints"][number];
export type OrProvider = ApiListItem<operations["listProviders"], "data">;
export type OrKey = ApiListItem<operations["list"], "data">;
export type OrActivityItem = ApiListItem<operations["getUserActivity"], "data">;
export type OrGuardrail = ApiListItem<operations["listGuardrails"], "data">;
export type OrGuardrailKeyAssignment = ApiListItem<
  operations["listGuardrailKeyAssignments"],
  "data"
>;
export type OrWorkspace = ApiListItem<operations["listWorkspaces"], "data">;
export type OrWorkspaceBudgets = ApiResponse<operations["listWorkspaceBudgets"]>;
export type OrByokCredential = ApiListItem<operations["listBYOKKeys"], "data">;
export type OrCredits = ApiResponse<operations["getCredits"]>;
/** `{}` stands in for a performance query that failed or was not run. */
export type OrAnalyticsAnswer = Partial<ApiResponse<operations["queryAnalytics"]>>;
export type OrAnalyticsFilter = components["schemas"]["Filter"];
export type OrTranscription = ApiResponse<operations["createAudioTranscriptions"]>;

export type OrKeyCreate = ApiBody<operations["createKeys"]>;
export type OrKeyUpdate = ApiBody<operations["updateKeys"]>;
export type OrGuardrailUpdate = ApiBody<operations["updateGuardrail"]>;
export type OrWorkspaceUpdate = ApiBody<operations["updateWorkspace"]>;
export type OrByokUpdate = ApiBody<operations["updateBYOKKey"]>;
export type OrSpeechRequest = ApiBody<operations["createAudioSpeech"]>;
export type OrTranscriptionRequest = ApiBody<operations["createAudioTranscriptions"]>;

/** The most `limit` takes on guardrail, workspace, BYOK and assignment lists. */
const MANAGEMENT_PAGE_SIZE = 100;
/** 10,000 rows. */
const MANAGEMENT_MAX_PAGES = 100;
/**
 * GET /keys takes `offset` alone and its document gives no page size, so this is
 * 10,000 rows at 20 a page and 50,000 at 100.
 */
const KEY_MAX_PAGES = 500;

/** The next `offset`: where this page's rows end, whatever size the server made it. */
function nextOffset({ cursor, items }: PageAnswer): number {
  return Number(cursor) + items.length;
}

type OffsetLists<SizeParam extends string> = CursorApiClient<
  paths,
  { cursorParam: "offset"; sizeParam: SizeParam; next: typeof nextOffset; hasMore: never }
>;

export type OpenRouterApi = OffsetLists<"limit"> & { keys: OffsetLists<never> };

/**
 * One client per key, because OpenRouter takes different keys on different
 * routes: see `OpenRouterClient`.
 */
export function createOpenRouterApi(options: {
  key: string;
  caCert: string | undefined;
  http: HttpHostServices | undefined;
}): OpenRouterApi {
  const api = createApiClient<paths>({
    vendor: "OpenRouter",
    baseUrl: BASE_URL,
    headers: { Authorization: `Bearer ${options.key}`, Accept: "application/json" },
    caCert: options.caCert,
    http: options.http,
  });
  const lists = withCursorPagination(api, {
    cursorParam: "offset",
    firstCursor: 0,
    sizeParam: "limit",
    pageSize: MANAGEMENT_PAGE_SIZE,
    maxPages: MANAGEMENT_MAX_PAGES,
    next: nextOffset,
    total: "total_count",
  });
  return Object.assign(lists, {
    /** GET /keys: no `limit`, no total, so only an empty page ends it. */
    keys: withCursorPagination(api, {
      cursorParam: "offset",
      firstCursor: 0,
      maxPages: KEY_MAX_PAGES,
      next: nextOffset,
    }),
  });
}
