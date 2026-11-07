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
  ListTruncatedError,
  requireListPage,
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

export const VENDOR = "ElevenLabs";

/**
 * Pages for an inventory list: every list route but history caps `page_size` at 100,
 * so this is 10,000 rows.
 */
export const LIST_MAX_PAGES = 100;

/** One of ElevenLabs' cursor-paged lists, whichever names it gives its cursor. */
export interface PagedList<Page, Item> {
  /** The route as the call writes it, for the error's message. */
  path: string;
  /** The field holding the rows. */
  key: string;
  maxPages: number;
  /** Part of the list is fine, so reaching the cap is not an error. */
  partial?: boolean;
  read: (cursor: string | null) => Promise<Page>;
  rows: (page: Page) => readonly Item[] | null | undefined;
  next: (page: Page) => string | null | undefined;
}

/**
 * Walk a list on `has_more`, which the document says to rely on: an empty page is not
 * the end while it is set, and neither is one with no cursor to follow, which throws
 * rather than read what it cannot reach as deleted. Not `getAll`, which ends on both.
 */
export async function readPagedList<Page extends { has_more: boolean }, Item>(
  list: PagedList<Page, Item>,
): Promise<Item[]> {
  const place = { vendor: VENDOR, path: list.path };
  const items: Item[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < list.maxPages; page += 1) {
    const answer: Page = await list.read(cursor);
    items.push(...requireListPage(list.rows(answer), { ...place, key: list.key }));
    if (!answer.has_more) return items;
    cursor = list.next(answer) ?? null;
    if (!cursor) {
      if (list.partial) return items;
      throw new ListTruncatedError({ ...place, items: items.length });
    }
  }
  if (list.partial) return items;
  throw new ListTruncatedError({ ...place, items: items.length, maxPages: list.maxPages });
}
