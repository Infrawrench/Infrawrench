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
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

/** Data plane, and the admin plane under `/admin`. */
export const BASE = "https://api.mistral.ai/v1";

export type MistralApi = ApiClient<paths>;

/** Base models carry neither field in the document, and the plugin reads both off any model. */
export type MistralModel = ApiListItem<operations["list_models_v1_models_get"], "data"> & {
  archived?: boolean;
  job?: string | null;
};
export type ModelList = ApiResponse<operations["list_models_v1_models_get"]>;
export type MistralVoice = ApiListItem<operations["list_voices_v1_audio_voices_get"], "items">;
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

// Named because each list loop feeds a page's cursor into the next call, and
// inference cannot follow that through a variable it is still working out.
export type AgentPage = ApiResponse<operations["agents_api_v1_agents_list_pages"]>;
export type LibraryPage = ApiResponse<operations["libraries_list_v1"]>;

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

type Transcription = ApiResponse<operations["audio_api_v1_transcriptions_post"]>;
/**
 * What the transcription reader looks for. `words`, a segment's `speaker` and
 * `audio_seconds` are not in the document, which has `speaker_id` and
 * `prompt_audio_seconds`.
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

export function createMistralApis(options: {
  apiKey: string;
  adminApiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}): { data: MistralApi; admin: MistralApi } {
  const shared = {
    vendor: "Mistral",
    baseUrl: BASE,
    caCert: options.caCert,
    http: options.http,
  };
  return {
    data: createApiClient<paths>({
      ...shared,
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
    }),
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
