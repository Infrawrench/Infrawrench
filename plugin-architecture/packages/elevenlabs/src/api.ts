/**
 * Typed clients over ElevenLabs' OpenAPI document (https://api.elevenlabs.io/openapi.json).
 *
 * Every JSON call authenticates with the raw `xi-api-key` header: ElevenLabs does
 * not use `Authorization: Bearer`. The host's HTTP service is used whenever there
 * is one, since only that path picks up bastion routing and a custom CA.
 * https://elevenlabs.io/docs/api-reference/authentication
 */
import {
  createApiClient,
  type ApiBody,
  type ApiListItem,
  type ApiResponse,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { components, operations, paths } from "./api-types.gen.js";

export const API_BASE = "https://api.elevenlabs.io";

export type ElevenLabsVoice = ApiListItem<operations["get_user_voices_v2"], "voices">;
export type ElevenLabsModel = ApiListItem<operations["get_models"], null>;
export type ElevenLabsHistoryItem = ApiListItem<operations["get_speech_history"], "history">;
export type ElevenLabsPronunciationDictionary = ApiListItem<
  operations["get_pronunciation_dictionaries_metadata"],
  "pronunciation_dictionaries"
>;
export type ElevenLabsSubscription = ApiResponse<operations["get_user_subscription_info"]>;

// Named because each list loop feeds a page's cursor into the next call, and
// inference cannot follow that through a variable it is still working out.
export type VoicesPage = ApiResponse<operations["get_user_voices_v2"]>;
export type HistoryPage = ApiResponse<operations["get_speech_history"]>;
export type PronunciationDictionaryPage = ApiResponse<
  operations["get_pronunciation_dictionaries_metadata"]
>;
export type AgentsPage = ApiResponse<operations["get_agents_route"]>;
export type ConversationsPage = ApiResponse<operations["get_conversation_histories_route"]>;
export type KnowledgeBasePage = ApiResponse<operations["get_knowledge_base_list_route"]>;

export type AgentSummaryWire = ApiListItem<operations["get_agents_route"], "agents">;
export type AgentDetailWire = ApiResponse<operations["get_agent_route"]>;
export type ConversationWire = ApiListItem<
  operations["get_conversation_histories_route"],
  "conversations"
>;
export type PhoneNumberWire = ApiListItem<operations["list_phone_numbers_route"], null>;
export type KnowledgeBaseDocumentWire = ApiListItem<
  operations["get_knowledge_base_list_route"],
  "documents"
>;

/** What `add-from-rules` takes for one line of the create form. */
export type DictionaryRule =
  | components["schemas"]["PronunciationDictionaryAliasRuleRequestModel"]
  | components["schemas"]["PronunciationDictionaryPhonemeRuleRequestModel"];

export type AgentConfigInput = components["schemas"]["AgentConfigAPIModel-Input"];
export type AgentPromptInput = components["schemas"]["PromptAgentAPIModel-Input"];
export type AgentTtsInput = components["schemas"]["TTSConversationalConfig-Input"];
export type AgentPatchBody = ApiBody<operations["patch_agent_settings_route"]>;

export type SynthesisBody = ApiBody<operations["text_to_speech_full"]>;

/**
 * What Scribe answers when neither `use_multi_channel` nor `webhook` is set, and
 * this plugin sets neither.
 */
export type ScribeResponse = components["schemas"]["SpeechToTextChunkResponseModel"];
export type ScribeWord = components["schemas"]["SpeechToTextWordResponseModel"];

export type EditVoiceResponse = ApiResponse<operations["edit_voice"]>;

/** The workspace analytics query, which both `cost-data.ts` and `usage-metrics.ts` read. */
export type UsageQueryBody = ApiBody<operations["usage_by_product_over_time"]>;
export type UsageQueryResponse = ApiResponse<operations["usage_by_product_over_time"]>;
export type UsageCell = UsageQueryResponse["rows"][number][number];
export type Currency = components["schemas"]["Currency"];

export type CharacterStatsResponse = ApiResponse<operations["usage_characters"]>;

export function createElevenLabsApis(options: {
  apiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}) {
  const shared = {
    vendor: "ElevenLabs",
    baseUrl: API_BASE,
    headers: { "xi-api-key": options.apiKey, Accept: "application/json" },
    caCert: options.caCert,
    http: options.http,
  };
  return {
    /** Query values as `encodeURIComponent` writes them, so a space in a cursor is `%20`. */
    api: createApiClient<paths>({ ...shared, encodeQuery: encodeURIComponent }),
    /** Query values form-encoded, so a space is `+`. Conversation lists have always used it. */
    formQueryApi: createApiClient<paths>(shared),
  };
}

export type ElevenLabsApi = ReturnType<typeof createElevenLabsApis>["api"];
