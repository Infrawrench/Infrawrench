/**
 * Typed clients over Mistral's OpenAPI document (https://docs.mistral.ai/openapi.yaml).
 *
 * Two credentials, two planes, one document: the workspace key drives everything
 * except `/admin/*`, which takes the Enterprise admin key. Mistral's docs disagree
 * on whether the admin plane wants `x-api-key` (the Admin API overview) or a bearer
 * token (the endpoint reference), so the admin client sends both and lets the
 * server pick. https://docs.mistral.ai/admin/admin-api/overview
 *
 * The host's HTTP service is used whenever there is one, since only that path picks
 * up bastion routing and a custom CA.
 */
import {
  createApiClient,
  type ApiBody,
  type ApiClient,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
  type PageAnswer,
  withCursorPagination,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.v1.gen.js";
import type { operations as V2Operations, paths as V2Paths } from "./api-types.v2.gen.js";

/** Data plane, and the admin plane under `/admin`. */
export const BASE = "https://api.mistral.ai/v1";
/** Only the cursor-paged voice listing lives here so far. */
const BASE_V2 = "https://api.mistral.ai/v2";

export type MistralApi = ApiClient<paths>;
type MistralV2Api = ApiClient<V2Paths>;

/** Base models carry neither field in the document, and the plugin reads both off any model. */
export type MistralModel = ApiListItem<operations["list_models_v1_models_get"], "data"> & {
  archived?: boolean;
  job?: string | null;
};
export type ModelList = ApiResponse<operations["list_models_v1_models_get"]>;
export type MistralVoice = ApiListItem<V2Operations["audio_v2_voices_list"], "data">;
export type VoiceUpdate = ApiBody<operations["update_voice_v1_audio_voices__voice_id__patch"]>;
export type MistralFile = ApiListItem<operations["files_api_routes_list_files"], "data">;
export type MistralFineTuningJob = ApiListItem<
  operations["jobs_api_routes_fine_tuning_get_fine_tuning_jobs"],
  "data"
>;
export type MistralBatchJob = ApiListItem<
  operations["jobs_api_routes_batch_get_batch_jobs"],
  "data"
>;
export type BatchJobCreate = ApiBody<operations["jobs_api_routes_batch_create_batch_job"]>;

export type ApiKeyPage = ApiResponse<operations["users_api_admin_api_keys_get_api_keys"]>;
export type MistralApiKey = ApiListItem<
  operations["users_api_admin_api_keys_get_api_keys"],
  "keys"
>;

export type MistralAgent = ApiListItem<operations["agents_api_v1_agents_list_pages"], "data">;
export type AgentCreate = ApiBody<operations["agents_api_v1_agents_create"]>;
export type AgentUpdate = ApiBody<operations["agents_api_v1_agents_update"]>;
/** The document has no `name` on a connector tool; the label falls back to one if it comes. */
export type MistralAgentTool = NonNullable<MistralAgent["tools"]>[number] & { name?: string };
export type CompletionArgs = components["schemas"]["CompletionArgs"];

export type MistralLibrary = ApiListItem<operations["libraries_list_v1"], "data">;
export type LibraryCreate = ApiBody<operations["libraries_create_v1"]>;
export type LibraryUpdate = ApiBody<operations["libraries_patch_v1"]>;

export type UsageReport = ApiResponse<operations["users_api_admin_usage_get_usage"]>;
export type UsagePrice = components["schemas"]["PriceData"];

type Transcription = ApiResponse<operations["audio_api_v1_transcriptions_post"]>;
/**
 * The document's answer, plus what the reader still accepts if it comes: `words`, a
 * segment's `speaker` and `audio_seconds` are not in the document, which has
 * `speaker_id` and `prompt_audio_seconds`.
 */
export type MistralTranscription = Omit<Transcription, "segments" | "usage"> & {
  usage?: Transcription["usage"] & { audio_seconds?: number };
  segments?: Array<
    NonNullable<Transcription["segments"]>[number] & { speaker?: string | number | null }
  >;
  words?: Array<{ word?: string; text?: string; start?: number; end?: number; speaker?: string }>;
};

export type AggregationBody = ApiBody<
  operations["aggregate_spans_v1_observability_spans_aggregate_post"]
>;
export type AggregationAnswer = ApiResponse<
  operations["aggregate_spans_v1_observability_spans_aggregate_post"]
>;
export type TraceRow = NonNullable<components["schemas"]["FeedResultGetTrace"]["results"]>[number];
export type SpanRow = NonNullable<components["schemas"]["FeedResultGetSpan"]["results"]>[number];

/** The next `page`, which Mistral counts from 0. */
function nextPageNumber({ cursor }: PageAnswer): number {
  return Number(cursor) + 1;
}

/** The next `offset`: where this page's rows end. */
function nextOffset({ cursor, items }: PageAnswer): number {
  return Number(cursor) + items.length;
}

/**
 * Mistral's three list dialects, each only accepting the routes it fits. The document
 * gives no largest `page_size` for numbered lists and defaults to 100, so that is kept,
 * and caps voices and `page_size` on libraries at 100.
 */
function listClients(data: MistralApi, v2: MistralV2Api) {
  const numbered = {
    cursorParam: "page",
    sizeParam: "page_size",
    firstCursor: 0,
    pageSize: 100,
    maxPages: 100,
    next: nextPageNumber,
    stopOnShortPage: true,
  } as const;
  const tokens = {
    cursorParam: "page_token",
    sizeParam: "page_size",
    next: "next_page_token",
    pageSize: 100,
    maxPages: 100,
    // The document ends these lists on a null token, not an empty page, and agents
    // are filtered by per-agent sharing, so a page can hold none and still have more.
    continueOnEmptyPage: true,
  } as const;
  return {
    numbered: withCursorPagination(data, numbered),
    // `ListBatchJobsResponse` alone does not require `data`, and defaults it to `[]`.
    batches: withCursorPagination(data, { ...numbered, missingListIsEmpty: true }),
    offsets: withCursorPagination(data, {
      cursorParam: "offset",
      sizeParam: "limit",
      firstCursor: 0,
      pageSize: 100,
      maxPages: 100,
      next: nextOffset,
      stopOnShortPage: true,
      total: "total",
      pagingFirst: true,
    }),
    tokens: withCursorPagination(data, tokens),
    voices: withCursorPagination(v2, tokens),
  };
}

export type MistralLists = ReturnType<typeof listClients>;

export function createMistralApis(options: {
  apiKey: string;
  adminApiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}): { data: MistralApi; admin: MistralApi; lists: MistralLists } {
  const shared = {
    vendor: "Mistral",
    baseUrl: BASE,
    caCert: options.caCert,
    http: options.http,
  };
  const dataHeaders = { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" };
  const data = createApiClient<paths>({ ...shared, headers: dataHeaders });
  const v2 = createApiClient<V2Paths>({ ...shared, baseUrl: BASE_V2, headers: dataHeaders });
  return {
    data,
    lists: listClients(data, v2),
    admin: createApiClient<paths>({
      ...shared,
      headers: {
        "x-api-key": options.adminApiKey,
        Authorization: `Bearer ${options.adminApiKey}`,
        Accept: "application/json",
      },
    }),
  };
}
