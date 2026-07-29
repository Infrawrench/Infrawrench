import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  SpeechPanelCapability,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

const API_BASE = "https://api.elevenlabs.io";

/** Requested explicitly so the browser `<audio>` element can play the result. */
const MP3_OUTPUT_FORMAT = "mp3_44100_128";

/**
 * Text-to-speech model the API itself defaults to, and our picker default when
 * the workspace exposes it. https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */
const DEFAULT_TTS_MODEL = "eleven_multilingual_v2";

/**
 * Scribe speech-to-text models. `model_id` is required on
 * `POST /v1/speech-to-text` and the documented enum is exactly these two —
 * `scribe_v1` is flagged deprecated ("outclassed by v2 models").
 * https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * https://elevenlabs.io/docs/overview/models
 */
const SCRIBE_MODELS: SpeechPanelOption[] = [
  { id: "scribe_v2", label: "Scribe v2", description: "Speech-to-text · current" },
  { id: "scribe_v1", label: "Scribe v1", description: "Speech-to-text · deprecated" },
];

const DEFAULT_SCRIBE_MODEL = "scribe_v2";

/**
 * Conservative fallback when the model list is unavailable —
 * `eleven_multilingual_v2`'s real `maximum_text_length_per_request`.
 */
const FALLBACK_MAX_CHARACTERS = 10_000;

/** The documented per-file ceiling for `POST /v1/speech-to-text` is 5 GB, but the
 * Speech tab base64-encodes the clip through ordinary JSON, so we advertise a
 * sane 25 MB so the host rejects oversized uploads before encoding them. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface ElevenLabsVoice {
  voice_id: string;
  name?: string | null;
  category?: string | null;
  description?: string | null;
  preview_url?: string | null;
  labels?: Record<string, string> | null;
  high_quality_base_model_ids?: string[] | null;
  is_owner?: boolean | null;
  created_at_unix?: number | null;
}

interface VoicesPage {
  voices?: ElevenLabsVoice[];
  has_more?: boolean;
  next_page_token?: string | null;
  total_count?: number;
}

interface ElevenLabsModel {
  model_id: string;
  name?: string | null;
  description?: string | null;
  can_do_text_to_speech?: boolean;
  can_do_voice_conversion?: boolean;
  can_use_style?: boolean;
  can_use_speaker_boost?: boolean;
  requires_alpha_access?: boolean;
  token_cost_factor?: number;
  maximum_text_length_per_request?: number | null;
  languages?: Array<{ language_id: string; name?: string | null }> | null;
}

interface ElevenLabsHistoryItem {
  history_item_id: string;
  request_id?: string | null;
  voice_id?: string | null;
  voice_name?: string | null;
  model_id?: string | null;
  text?: string | null;
  date_unix?: number | null;
  character_count_change_from?: number | null;
  character_count_change_to?: number | null;
  content_type?: string | null;
  state?: string | null;
  source?: string | null;
}

interface HistoryPage {
  history?: ElevenLabsHistoryItem[];
  last_history_item_id?: string | null;
  has_more?: boolean;
}

interface ElevenLabsPronunciationDictionary {
  id: string;
  latest_version_id?: string | null;
  latest_version_rules_num?: number | null;
  name?: string | null;
  created_by?: string | null;
  creation_time_unix?: number | null;
  description?: string | null;
}

interface PronunciationDictionaryPage {
  pronunciation_dictionaries?: ElevenLabsPronunciationDictionary[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface ElevenLabsSubscription {
  tier?: string | null;
  status?: string | null;
  currency?: string | null;
  billing_period?: string | null;
  character_count?: number | null;
  character_limit?: number | null;
  next_character_count_reset_unix?: number | null;
  can_extend_character_limit?: boolean | null;
  voice_limit?: number | null;
  voice_slots_used?: number | null;
}

interface ScribeWord {
  text?: string | null;
  start?: number | null;
  end?: number | null;
  type?: string | null;
  speaker_id?: string | null;
  /**
   * "The log of the probability with which this word was predicted." Range is
   * (-∞, 0], so `Math.exp` turns it back into a 0..1 probability. This is the
   * only per-transcript confidence Scribe exposes — `language_probability` is
   * a language-ID score and says nothing about transcript quality.
   */
  logprob?: number | null;
}

interface ScribeResponse {
  language_code?: string | null;
  language_probability?: number | null;
  text?: string | null;
  words?: ScribeWord[] | null;
  audio_duration_secs?: number | null;
  transcription_id?: string | null;
}

/** Shape stashed under the `__models__` resolved output. */
interface StashedModel {
  id: string;
  label: string;
  description: string;
  maxCharacters: number;
}

/** Shape stashed under the `__voices__` resolved output. */
interface StashedVoice {
  id: string;
  label: string;
  description: string;
}

/** Shape stashed under the `__subscription__` resolved output. */
interface StashedQuota {
  used: number;
  limit: number;
  resetUnix: number;
  tier: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `{accountId}:{typeId}:{externalId}` → `{externalId}` */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function unixToIso(unix: number | null | undefined): string {
  if (!unix) return "";
  return new Date(unix * 1000).toISOString();
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Flatten the `labels` map ElevenLabs attaches to a voice into one readable line. */
function formatLabels(labels: Record<string, string> | null | undefined): string {
  if (!labels) return "";
  return Object.entries(labels)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${titleCase(key)}: ${value}`)
    .join(" · ");
}

/** A 20-cell text meter, since the detail schema has no progress-bar node. */
function meterBar(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * 20);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
}

function parseJsonStash<T>(raw: string | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseQuotaStash(raw: string | undefined): StashedQuota | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "limit" in parsed) return parsed as StashedQuota;
    return null;
  } catch {
    return null;
  }
}

/**
 * ElevenLabs plugin client. One instance per account (per API key).
 * Every JSON call authenticates with the raw `xi-api-key` header — ElevenLabs
 * does not use `Authorization: Bearer`.
 * https://elevenlabs.io/docs/api-reference/authentication
 */
export class ElevenLabsClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("ElevenLabs plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "ElevenLabs",
      url: `${API_BASE}${path}`,
      errorPath: path,
      headers: { "xi-api-key": this.apiKey, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "voice": {
        const voices = await this.fetchVoices();
        return voices.map((voice) => this.mapVoice(voice, accountId));
      }
      case "model": {
        const models = await this.fetchModels();
        return models.map((model) => this.mapModel(model, accountId));
      }
      case "pronunciation-dictionary": {
        const dictionaries = await this.fetchPronunciationDictionaries();
        return dictionaries.map((dictionary) => this.mapDictionary(dictionary, accountId));
      }
      case "history-item": {
        const items = await this.fetchHistory();
        return items.map((item) => this.mapHistoryItem(item, accountId));
      }
      default:
        throw new Error(`ElevenLabs plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * `GET /v2/voices` — v1 is legacy and breaks past 500 voices. Cursor is
   * `next_page_token`; `page_size` caps at 100.
   * https://elevenlabs.io/docs/api-reference/voices/search
   */
  private async fetchVoices(): Promise<ElevenLabsVoice[]> {
    const voices: ElevenLabsVoice[] = [];
    let pageToken: string | undefined;
    // Bounded so a pathological workspace can't spin forever.
    for (let page = 0; page < 50; page += 1) {
      const cursor = pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : "";
      const data = await this.fetch<VoicesPage>(`/v2/voices?page_size=100${cursor}`);
      voices.push(...(data.voices ?? []));
      if (!data.has_more || !data.next_page_token) break;
      pageToken = data.next_page_token;
    }
    return voices;
  }

  /**
   * `GET /v1/models` — returns a bare JSON array, no envelope.
   * https://elevenlabs.io/docs/api-reference/models/list
   */
  private async fetchModels(): Promise<ElevenLabsModel[]> {
    const data = await this.fetch<ElevenLabsModel[]>("/v1/models");
    return Array.isArray(data) ? data : [];
  }

  /**
   * `GET /v1/pronunciation-dictionaries` — cursor param is `cursor`, the
   * response cursor is `next_cursor`; `page_size` caps at 100.
   * https://elevenlabs.io/docs/api-reference/pronunciation-dictionaries/list
   */
  private async fetchPronunciationDictionaries(): Promise<ElevenLabsPronunciationDictionary[]> {
    const dictionaries: ElevenLabsPronunciationDictionary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const data = await this.fetch<PronunciationDictionaryPage>(
        `/v1/pronunciation-dictionaries?page_size=100${suffix}`,
      );
      dictionaries.push(...(data.pronunciation_dictionaries ?? []));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return dictionaries;
  }

  /**
   * `GET /v1/history` — list field is `history`; the forward cursor is
   * `start_after_history_item_id`, fed from the response's
   * `last_history_item_id`. `page_size` caps at 1000.
   * https://elevenlabs.io/docs/api-reference/history/list
   */
  private async fetchHistory(): Promise<ElevenLabsHistoryItem[]> {
    const items: ElevenLabsHistoryItem[] = [];
    let after: string | undefined;
    // History is unbounded over an account's lifetime — cap at 5 pages (500
    // clips), newest first, which is what the sidebar can usefully show.
    for (let page = 0; page < 5; page += 1) {
      const suffix = after ? `&start_after_history_item_id=${encodeURIComponent(after)}` : "";
      const data = await this.fetch<HistoryPage>(`/v1/history?page_size=100${suffix}`);
      items.push(...(data.history ?? []));
      if (!data.has_more || !data.last_history_item_id) break;
      after = data.last_history_item_id;
    }
    return items;
  }

  /**
   * `GET /v1/user/subscription` — the quota gauge. Also the right endpoint for
   * validating a key: an unauthenticated `/v1/models` answers 404
   * `workspace_not_found` rather than 401.
   * https://elevenlabs.io/docs/api-reference/user/subscription/get
   */
  private async fetchSubscription(): Promise<ElevenLabsSubscription> {
    return this.fetch<ElevenLabsSubscription>("/v1/user/subscription");
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapVoice(voice: ElevenLabsVoice, accountId: string): ResourceInstance {
    const labels = voice.labels ?? {};
    const name = voice.name ?? voice.voice_id;
    const createdAt = unixToIso(voice.created_at_unix) || new Date().toISOString();
    return {
      id: `${accountId}:voice:${voice.voice_id}`,
      pluginId: "elevenlabs",
      resourceTypeId: "voice",
      accountId,
      displayName: name,
      fields: {
        name,
        voiceId: voice.voice_id,
        ...(voice.category ? { category: voice.category } : {}),
        ...(voice.description ? { description: voice.description } : {}),
        ...(formatLabels(voice.labels) ? { labels: formatLabels(voice.labels) } : {}),
        ...(labels["accent"] ? { accent: labels["accent"] } : {}),
        ...(labels["gender"] ? { gender: labels["gender"] } : {}),
        ...(labels["age"] ? { age: labels["age"] } : {}),
        ...(labels["use_case"] ? { useCase: labels["use_case"] } : {}),
        ...(voice.preview_url ? { previewUrl: voice.preview_url } : {}),
        ...(voice.high_quality_base_model_ids?.length
          ? { highQualityModels: voice.high_quality_base_model_ids.join(", ") }
          : {}),
      },
      resolvedOutputs: {
        voiceId: voice.voice_id,
        voiceName: name,
        previewUrl: voice.preview_url ?? "",
      },
      secretStates: [],
      externalId: voice.voice_id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapModel(model: ElevenLabsModel, accountId: string): ResourceInstance {
    const name = model.name ?? model.model_id;
    const now = new Date().toISOString();
    const languages = model.languages ?? [];
    return {
      id: `${accountId}:model:${model.model_id}`,
      pluginId: "elevenlabs",
      resourceTypeId: "model",
      accountId,
      displayName: name,
      fields: {
        name,
        modelId: model.model_id,
        ...(model.description ? { description: model.description } : {}),
        ...(model.maximum_text_length_per_request != null
          ? { maxCharacters: model.maximum_text_length_per_request }
          : {}),
        canDoTextToSpeech: model.can_do_text_to_speech ?? false,
        canDoVoiceConversion: model.can_do_voice_conversion ?? false,
        canUseStyle: model.can_use_style ?? false,
        canUseSpeakerBoost: model.can_use_speaker_boost ?? false,
        requiresAlphaAccess: model.requires_alpha_access ?? false,
        languageCount: languages.length,
        ...(languages.length
          ? { languages: languages.map((language) => language.language_id).join(", ") }
          : {}),
      },
      resolvedOutputs: {
        modelId: model.model_id,
        maxCharacters: String(model.maximum_text_length_per_request ?? ""),
      },
      secretStates: [],
      externalId: model.model_id,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapDictionary(
    dictionary: ElevenLabsPronunciationDictionary,
    accountId: string,
  ): ResourceInstance {
    const name = dictionary.name ?? dictionary.id;
    const createdAt = unixToIso(dictionary.creation_time_unix) || new Date().toISOString();
    return {
      id: `${accountId}:pronunciation-dictionary:${dictionary.id}`,
      pluginId: "elevenlabs",
      resourceTypeId: "pronunciation-dictionary",
      accountId,
      displayName: name,
      fields: {
        name,
        dictionaryId: dictionary.id,
        ...(dictionary.latest_version_id ? { latestVersionId: dictionary.latest_version_id } : {}),
        ...(dictionary.description ? { description: dictionary.description } : {}),
        ...(dictionary.created_by ? { createdBy: dictionary.created_by } : {}),
        ...(createdAt ? { createdAt } : {}),
        ...(dictionary.latest_version_rules_num != null
          ? { ruleCount: dictionary.latest_version_rules_num }
          : {}),
      },
      resolvedOutputs: {
        dictionaryId: dictionary.id,
        latestVersionId: dictionary.latest_version_id ?? "",
      },
      secretStates: [],
      externalId: dictionary.id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapHistoryItem(item: ElevenLabsHistoryItem, accountId: string): ResourceInstance {
    const text = item.text ?? "";
    const preview = text.length > 60 ? `${text.slice(0, 57)}…` : text || item.history_item_id;
    const createdAt = unixToIso(item.date_unix) || new Date().toISOString();
    const from = item.character_count_change_from ?? 0;
    const to = item.character_count_change_to ?? 0;
    return {
      id: `${accountId}:history-item:${item.history_item_id}`,
      pluginId: "elevenlabs",
      resourceTypeId: "history-item",
      accountId,
      displayName: preview,
      fields: {
        text,
        historyItemId: item.history_item_id,
        ...(item.voice_name ? { voiceName: item.voice_name } : {}),
        ...(item.voice_id ? { voiceId: item.voice_id } : {}),
        ...(item.model_id ? { modelId: item.model_id } : {}),
        characterCount: Math.max(0, to - from),
        ...(item.content_type ? { contentType: item.content_type } : {}),
        ...(item.state ? { state: item.state } : {}),
        ...(item.source ? { source: item.source } : {}),
        ...(createdAt ? { date: createdAt } : {}),
      },
      resolvedOutputs: {
        historyItemId: item.history_item_id,
        voiceId: item.voice_id ?? "",
        audioUrl: `/v1/history/${item.history_item_id}/audio`,
      },
      secretStates: [],
      externalId: item.history_item_id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Single resource
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "voice") {
      // `renderDetail` is synchronous, so everything the Speech tab needs — the
      // voice picker, the model picker (with each model's real
      // `maximum_text_length_per_request`) and the quota gauge — is fetched
      // here and stashed as JSON under `__`-prefixed resolved outputs.
      const [voices, models, subscription] = await Promise.all([
        this.fetchVoices(),
        this.fetchModels().catch((): ElevenLabsModel[] => []),
        this.fetchSubscription().catch((): ElevenLabsSubscription | null => null),
      ]);
      const raw = voices.find((voice) => voice.voice_id === externalId);
      if (!raw) throw new Error(`ElevenLabs plugin: voice ${externalId} not found`);
      const instance = this.mapVoice(raw, accountId);

      const stashedVoices: StashedVoice[] = voices.map((voice) => ({
        id: voice.voice_id,
        label: voice.name ?? voice.voice_id,
        description: formatLabels(voice.labels) || (voice.category ?? ""),
      }));
      const stashedModels: StashedModel[] = models
        .filter((model) => model.can_do_text_to_speech !== false)
        .map((model) => ({
          id: model.model_id,
          label: model.name ?? model.model_id,
          description: model.description ?? "",
          maxCharacters: model.maximum_text_length_per_request ?? FALLBACK_MAX_CHARACTERS,
        }));

      instance.resolvedOutputs["__voices__"] = JSON.stringify(stashedVoices);
      instance.resolvedOutputs["__models__"] = JSON.stringify(stashedModels);
      if (subscription && subscription.character_limit != null) {
        const quota: StashedQuota = {
          used: subscription.character_count ?? 0,
          limit: subscription.character_limit,
          resetUnix: subscription.next_character_count_reset_unix ?? 0,
          tier: subscription.tier ?? "",
        };
        instance.resolvedOutputs["__subscription__"] = JSON.stringify(quota);
      }
      return instance;
    }

    const all = await this.listResources(typeId, accountId);
    const found = all.find((resource) => resource.id === resourceId);
    if (!found) throw new Error(`ElevenLabs plugin: resource ${typeId}/${externalId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`ElevenLabs plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /**
   * `DELETE /v1/voices/{voice_id}` and `DELETE /v1/history/{history_item_id}`
   * are the only two destructive endpoints ElevenLabs exposes for these types;
   * models and pronunciation dictionaries have no delete route (dictionaries
   * are archived from the dashboard instead).
   * https://elevenlabs.io/docs/api-reference/voices/delete
   * https://elevenlabs.io/docs/api-reference/history/delete
   */
  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (!externalId) throw new Error(`ElevenLabs plugin: cannot parse resource id "${resourceId}"`);
    if (typeId === "voice") {
      await this.fetch<unknown>(`/v1/voices/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "history-item") {
      await this.fetch<unknown>(`/v1/history/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    throw new Error(`ElevenLabs plugin: deleteResource not supported for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Subscription quota is account-level, so every resource type's dashboard
   * card leads with the used-vs-limit gauge and then adds type-specific stats.
   */
  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const [subscription, resource] = await Promise.all([
      this.fetchSubscription().catch((): ElevenLabsSubscription | null => null),
      this.getResource(resourceTypeId, resourceId, accountId).catch(
        (): ResourceInstance | null => null,
      ),
    ]);

    const stats: DashboardStat[] = [];
    if (subscription && subscription.character_limit != null) {
      const used = subscription.character_count ?? 0;
      const limit = subscription.character_limit;
      const fraction = limit > 0 ? used / limit : 0;
      stats.push({
        label: "Characters Used",
        value: `${formatNumber(used)} / ${formatNumber(limit)}`,
        variant:
          fraction >= 0.95
            ? "status-error"
            : fraction >= 0.8
              ? "status-degraded"
              : "status-healthy",
      });
      stats.push({ label: "Quota Used", value: `${Math.round(fraction * 100)}%` });
      if (subscription.next_character_count_reset_unix) {
        stats.push({
          label: "Resets",
          value: new Date(subscription.next_character_count_reset_unix * 1000).toLocaleDateString(
            "en-US",
            { month: "short", day: "numeric", year: "numeric" },
          ),
        });
      }
      if (subscription.tier) stats.push({ label: "Tier", value: titleCase(subscription.tier) });
    }

    const fields = resource?.fields ?? {};
    switch (resourceTypeId) {
      case "voice":
        if (fields["category"])
          stats.push({ label: "Category", value: String(fields["category"]) });
        if (subscription?.voice_limit != null) {
          stats.push({
            label: "Voice Slots",
            value: `${formatNumber(subscription.voice_slots_used ?? 0)} / ${formatNumber(subscription.voice_limit)}`,
          });
        }
        break;
      case "model":
        if (fields["maxCharacters"] != null) {
          stats.push({
            label: "Max Characters",
            value: formatNumber(Number(fields["maxCharacters"])),
          });
        }
        if (fields["languageCount"] != null) {
          stats.push({ label: "Languages", value: String(fields["languageCount"]) });
        }
        break;
      case "pronunciation-dictionary":
        if (fields["ruleCount"] != null) {
          stats.push({ label: "Rules", value: String(fields["ruleCount"]) });
        }
        break;
      case "history-item":
        if (fields["characterCount"] != null) {
          stats.push({
            label: "Characters Billed",
            value: formatNumber(Number(fields["characterCount"])),
          });
        }
        if (fields["voiceName"]) stats.push({ label: "Voice", value: String(fields["voiceName"]) });
        break;
      default:
        break;
    }

    return stats;
  }

  // -------------------------------------------------------------------------
  // Speech tab
  // -------------------------------------------------------------------------

  /**
   * `POST /v1/text-to-speech/{voice_id}` — the voice is a PATH param, the
   * output format is a QUERY param, and the response is raw
   * `application/octet-stream` audio.
   * https://elevenlabs.io/docs/api-reference/text-to-speech/convert
   */
  async synthesizeSpeech(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    if (typeId !== "voice") {
      throw new Error(`ElevenLabs plugin: synthesizeSpeech not supported for type "${typeId}"`);
    }
    const voiceId = payload.voiceId || externalIdOf(resourceId);
    if (!voiceId) throw new Error("ElevenLabs plugin: no voice selected");

    // The Speech tab has one shared model picker for both halves, so a Scribe
    // selection can arrive here — fall back to the TTS default rather than
    // sending a transcription model to the synthesis endpoint.
    const requested = payload.modelId ?? "";
    const modelId = requested && !requested.startsWith("scribe") ? requested : DEFAULT_TTS_MODEL;

    const started = Date.now();
    const audio = await this.requestSynthesisAudio(voiceId, {
      text: payload.text,
      model_id: modelId,
    });
    const elapsedMs = Date.now() - started;

    const characters = audio.characterCost ?? payload.text.length;
    const summaryParts = [
      `${formatNumber(characters)} characters`,
      modelId,
      `${(elapsedMs / 1000).toFixed(1)}s`,
      `${(audio.bytes.byteLength / 1024).toFixed(0)} KB mp3`,
    ];

    return {
      audioBase64: Buffer.from(audio.bytes).toString("base64"),
      // ElevenLabs answers with application/octet-stream even though the bytes
      // are mp3, so we label it ourselves for the browser `<audio>` element.
      mimeType: "audio/mpeg",
      fileName: `elevenlabs-${voiceId}-${Date.now()}.mp3`,
      summary: summaryParts.join(" · "),
      characters,
      ...(audio.requestId ? { requestId: audio.requestId } : {}),
    };
  }

  /**
   * Binary path. `jsonRestFetch` JSON-parses its response and
   * `HttpHostServices.request` only ever hands back a string, so audio has to
   * go through the global `fetch` + `arrayBuffer`.
   *
   * NOTE: because this bypasses `services.http`, it also bypasses bastion
   * egress routing and the custom CA credential. Control-plane calls (listing,
   * quota, deletes) still go through the host and keep both.
   */
  private async requestSynthesisAudio(
    voiceId: string,
    body: Record<string, unknown>,
  ): Promise<{
    bytes: Uint8Array;
    characterCost: number | undefined;
    requestId: string | undefined;
  }> {
    const path = `/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
    const response = await fetch(`${API_BASE}${path}?output_format=${MP3_OUTPUT_FORMAT}`, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    });
    // Branch on status BEFORE touching the body — a failed call returns JSON
    // where the success path returns audio.
    if (!response.ok) {
      throw new Error(
        `ElevenLabs API error ${response.status} for ${path}: ${await response.text()}`,
      );
    }
    const buffer = await response.arrayBuffer();
    const characterCostHeader = response.headers.get("character-cost");
    const parsedCost = characterCostHeader ? Number(characterCostHeader) : Number.NaN;
    return {
      bytes: new Uint8Array(buffer),
      characterCost: Number.isFinite(parsedCost) ? parsedCost : undefined,
      requestId: response.headers.get("request-id") ?? undefined,
    };
  }

  /**
   * `POST /v1/speech-to-text` (Scribe) — `multipart/form-data` with the clip in
   * the `file` field and a required `model_id`.
   * https://elevenlabs.io/docs/api-reference/speech-to-text/convert
   *
   * Uses a real `FormData` against the global `fetch`: `jsonRestFetch` would
   * stringify it (`bodyForHostHttp` has no FormData branch). Same bastion/CA
   * caveat as the synthesis path above.
   */
  async transcribeAudio(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    if (typeId !== "voice") {
      throw new Error(`ElevenLabs plugin: transcribeAudio not supported for type "${typeId}"`);
    }

    const requested = payload.modelId ?? "";
    const modelId = requested.startsWith("scribe") ? requested : DEFAULT_SCRIBE_MODEL;

    // `payload.mimeType` is whatever MediaRecorder produced —
    // `audio/webm;codecs=opus` on Chromium, `audio/mp4` on Safari. Scribe
    // accepts both; forward it verbatim rather than assuming or transcoding.
    const bytes = Buffer.from(payload.audioBase64, "base64");
    const fileName = payload.fileName ?? `clip.${extensionForMime(payload.mimeType)}`;

    const form = new FormData();
    form.append("model_id", modelId);
    form.append("file", new Blob([bytes], { type: payload.mimeType }), fileName);
    form.append("timestamps_granularity", "word");
    form.append("diarize", "true");
    if (payload.language && payload.language !== "auto") {
      form.append("language_code", payload.language);
    }

    const started = Date.now();
    const response = await fetch(`${API_BASE}/v1/speech-to-text`, {
      method: "POST",
      // No Content-Type — `fetch` sets it with the multipart boundary.
      headers: { "xi-api-key": this.apiKey, Accept: "application/json" },
      body: form,
    });
    if (!response.ok) {
      throw new Error(
        `ElevenLabs API error ${response.status} for /v1/speech-to-text: ${await response.text()}`,
      );
    }
    const elapsedMs = Date.now() - started;
    const data = (await response.json()) as ScribeResponse;

    const spoken = (data.words ?? []).filter(
      (word) => (word.type ?? "word") === "word" && Boolean(word.text),
    );

    const words: TranscriptWord[] = spoken.map((word) => ({
      text: word.text ?? "",
      ...(word.start != null ? { start: word.start } : {}),
      ...(word.end != null ? { end: word.end } : {}),
      ...(word.speaker_id ? { speaker: word.speaker_id } : {}),
    }));

    // The only honest transcript confidence Scribe offers. `language_probability`
    // is deliberately not used here — it scores the *language guess*, sits near
    // 0.99 for any intelligible audio, and would render as "99% confidence" over
    // a badly mangled transcript. It is still reported in the summary, labelled.
    const confidence = averageWordConfidence(spoken);

    const summaryParts = [modelId];
    if (data.audio_duration_secs != null) {
      summaryParts.push(`${data.audio_duration_secs.toFixed(1)}s audio`);
    }
    if (data.language_code) {
      const probability = data.language_probability;
      summaryParts.push(
        probability != null
          ? `${data.language_code} (${Math.round(probability * 100)}%)`
          : data.language_code,
      );
    }
    summaryParts.push(`${(elapsedMs / 1000).toFixed(1)}s round-trip`);

    return {
      text: data.text ?? "",
      summary: summaryParts.join(" · "),
      ...(data.language_code ? { language: data.language_code } : {}),
      ...(data.audio_duration_secs != null ? { durationSeconds: data.audio_duration_secs } : {}),
      ...(confidence != null ? { confidence } : {}),
      ...(words.length ? { words } : {}),
      ...(data.transcription_id ? { requestId: data.transcription_id } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "voice":
        return this.renderVoiceDetail(resource);
      case "model":
        return this.renderModelDetail(resource);
      case "pronunciation-dictionary":
        return this.renderDictionaryDetail(resource);
      case "history-item":
        return this.renderHistoryItemDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    switch (resource.resourceTypeId) {
      case "voice": {
        const category = String(resource.fields["category"] ?? "");
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "healthy",
            ...(category ? { label: titleCase(category) } : {}),
          },
        };
      }
      case "model": {
        const tts = resource.fields["canDoTextToSpeech"] === true;
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: tts ? "healthy" : "info",
            label: tts ? "Text-to-speech" : "Conversion only",
          },
        };
      }
      case "pronunciation-dictionary": {
        const rules = Number(resource.fields["ruleCount"] ?? 0);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: rules > 0 ? "healthy" : "info",
            label: `${rules} rule${rules === 1 ? "" : "s"}`,
          },
        };
      }
      case "history-item": {
        const state = String(resource.fields["state"] ?? "");
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: state === "created" || state === "" ? "healthy" : "info",
            ...(state ? { label: titleCase(state) } : {}),
          },
        };
      }
      default:
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "info" },
        };
    }
  }

  private renderVoiceDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const previewUrl = String(fields["previewUrl"] ?? resource.resolvedOutputs["previewUrl"] ?? "");
    const voiceId = String(fields["voiceId"] ?? resource.externalId ?? "");

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Voice",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? resource.displayName) },
              { key: "Voice ID", value: voiceId, copyable: true },
              ...(fields["category"]
                ? [{ key: "Category", value: titleCase(String(fields["category"])) }]
                : []),
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
            ],
          },
        ],
      },
    ];

    const labelItems = (
      [
        ["Accent", "accent"],
        ["Gender", "gender"],
        ["Age", "age"],
        ["Use Case", "useCase"],
      ] as const
    )
      .filter(([, key]) => Boolean(fields[key]))
      .map(([label, key]) => ({ key: label, value: titleCase(String(fields[key])) }));

    if (labelItems.length || fields["labels"]) {
      sections.push({
        kind: "section",
        title: "Labels",
        children: [
          {
            kind: "key-value-list",
            items: labelItems.length
              ? labelItems
              : [{ key: "Labels", value: String(fields["labels"] ?? "") }],
          },
        ],
      });
    }

    const deliveryChildren: SchemaNode[] = [];
    if (previewUrl) {
      deliveryChildren.push({ kind: "link", label: "Play preview (MP3)", url: previewUrl });
    }
    if (fields["highQualityModels"]) {
      deliveryChildren.push({
        kind: "key-value-list",
        items: [{ key: "High-Quality Models", value: String(fields["highQualityModels"]) }],
      });
    }
    if (deliveryChildren.length) {
      sections.push({ kind: "section", title: "Preview", children: deliveryChildren });
    }

    const quota = parseQuotaStash(resource.resolvedOutputs["__subscription__"]);
    if (quota) sections.push(quotaSection(quota));

    const voices = parseJsonStash<StashedVoice>(resource.resolvedOutputs["__voices__"]);
    const models = parseJsonStash<StashedModel>(resource.resolvedOutputs["__models__"]);

    return {
      title: resource.displayName,
      subtitle: `ElevenLabs Voice · ${titleCase(String(fields["category"] ?? "voice"))}`,
      status: { kind: "status-dot", status: "healthy", label: "Available" },
      sections,
      speechPanel: this.buildSpeechPanel(voiceId, voices, models, quota),
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  /**
   * The Speech tab has a single shared model picker, so it carries the
   * workspace's real text-to-speech models followed by the Scribe
   * speech-to-text models. `maxCharacters` tracks the default TTS model's own
   * `maximum_text_length_per_request` rather than a hardcoded number.
   */
  private buildSpeechPanel(
    voiceId: string,
    voices: StashedVoice[],
    models: StashedModel[],
    quota: StashedQuota | null,
  ): SpeechPanelCapability {
    const voiceOptions: SpeechPanelOption[] = voices.map((voice) => ({
      id: voice.id,
      label: voice.label,
      ...(voice.description ? { description: voice.description } : {}),
    }));

    const ttsOptions: SpeechPanelOption[] = models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.description
        ? `${model.description} · up to ${formatNumber(model.maxCharacters)} chars`
        : `Up to ${formatNumber(model.maxCharacters)} characters`,
    }));

    const defaultModel =
      models.find((model) => model.id === DEFAULT_TTS_MODEL)?.id ??
      models[0]?.id ??
      DEFAULT_SCRIBE_MODEL;
    const maxCharacters =
      models.find((model) => model.id === defaultModel)?.maxCharacters ?? FALLBACK_MAX_CHARACTERS;

    const subtitleParts = ["Text-to-speech and Scribe transcription"];
    if (quota && quota.limit > 0) {
      subtitleParts.push(
        `${formatNumber(quota.used)} / ${formatNumber(quota.limit)} characters used this period`,
      );
    }

    return {
      modes: ["tts", "stt"],
      subtitle: subtitleParts.join(" · "),
      helpText:
        "Synthesis bills against your character quota. Transcription runs on ElevenLabs Scribe and bills per minute of audio.",
      ...(voiceOptions.length ? { voices: voiceOptions } : {}),
      ...(voiceId ? { defaultVoice: voiceId } : {}),
      voiceLabel: "Voice",
      defaultText: "The quick brown fox jumps over the lazy dog.",
      maxCharacters,
      synthesizeLabel: "Synthesize",
      models: [...ttsOptions, ...SCRIBE_MODELS],
      defaultModel,
      modelLabel: "Model",
      languages: [
        { id: "auto", label: "Auto-detect" },
        { id: "en", label: "English" },
        { id: "es", label: "Spanish" },
        { id: "fr", label: "French" },
        { id: "de", label: "German" },
        { id: "it", label: "Italian" },
        { id: "pt", label: "Portuguese" },
        { id: "pl", label: "Polish" },
        { id: "nl", label: "Dutch" },
        { id: "hi", label: "Hindi" },
        { id: "ja", label: "Japanese" },
        { id: "ko", label: "Korean" },
        { id: "zh", label: "Chinese" },
        { id: "ar", label: "Arabic" },
      ],
      defaultLanguage: "auto",
      languageLabel: "Transcription language",
      // Formats Scribe documents as accepted, plus what MediaRecorder emits.
      acceptedAudioTypes: [
        "audio/webm",
        "audio/mp4",
        "audio/mpeg",
        "audio/wav",
        "audio/ogg",
        "audio/flac",
        "audio/aac",
        "audio/x-m4a",
        ".mp3",
        ".wav",
        ".m4a",
        ".webm",
        ".flac",
        ".ogg",
      ],
      maxAudioBytes: MAX_AUDIO_BYTES,
      transcribeLabel: "Transcribe",
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const maxCharacters = Number(fields["maxCharacters"] ?? 0);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? resource.displayName) },
              { key: "Model ID", value: String(fields["modelId"] ?? ""), copyable: true },
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
              {
                key: "Max Characters Per Request",
                value: maxCharacters ? formatNumber(maxCharacters) : "Unknown",
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Capabilities",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Text-to-Speech", value: fields["canDoTextToSpeech"] ? "Yes" : "No" },
              { key: "Voice Conversion", value: fields["canDoVoiceConversion"] ? "Yes" : "No" },
              { key: "Style Control", value: fields["canUseStyle"] ? "Yes" : "No" },
              { key: "Speaker Boost", value: fields["canUseSpeakerBoost"] ? "Yes" : "No" },
              { key: "Requires Alpha Access", value: fields["requiresAlphaAccess"] ? "Yes" : "No" },
            ],
          },
        ],
      },
    ];

    if (fields["languages"]) {
      sections.push({
        kind: "section",
        title: "Languages",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Count", value: String(fields["languageCount"] ?? "") },
              { key: "Codes", value: String(fields["languages"]) },
            ],
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Speech model · ${String(fields["modelId"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: fields["canDoTextToSpeech"] ? "healthy" : "info",
        label: fields["canDoTextToSpeech"] ? "Text-to-speech" : "Conversion only",
      },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDictionaryDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const rules = Number(fields["ruleCount"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: "Pronunciation Dictionary",
      status: {
        kind: "status-dot",
        status: rules > 0 ? "healthy" : "info",
        label: `${rules} rule${rules === 1 ? "" : "s"}`,
      },
      sections: [
        {
          kind: "section",
          title: "Dictionary",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(fields["name"] ?? resource.displayName) },
                {
                  key: "Dictionary ID",
                  value: String(fields["dictionaryId"] ?? ""),
                  copyable: true,
                },
                ...(fields["latestVersionId"]
                  ? [
                      {
                        key: "Latest Version ID",
                        value: String(fields["latestVersionId"]),
                        copyable: true,
                      },
                    ]
                  : []),
                ...(fields["description"]
                  ? [{ key: "Description", value: String(fields["description"]) }]
                  : []),
                ...(fields["createdBy"]
                  ? [{ key: "Created By", value: String(fields["createdBy"]) }]
                  : []),
                ...(fields["createdAt"]
                  ? [{ key: "Created", value: String(fields["createdAt"]) }]
                  : []),
                { key: "Rules", value: String(rules) },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderHistoryItemDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const characters = Number(fields["characterCount"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: `Generation · ${String(fields["voiceName"] ?? "unknown voice")}`,
      status: {
        kind: "status-dot",
        status: "healthy",
        label: `${formatNumber(characters)} characters`,
      },
      sections: [
        {
          kind: "section",
          title: "Generation",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "History Item ID",
                  value: String(fields["historyItemId"] ?? ""),
                  copyable: true,
                },
                ...(fields["voiceName"]
                  ? [{ key: "Voice", value: String(fields["voiceName"]) }]
                  : []),
                ...(fields["voiceId"]
                  ? [{ key: "Voice ID", value: String(fields["voiceId"]), copyable: true }]
                  : []),
                ...(fields["modelId"] ? [{ key: "Model", value: String(fields["modelId"]) }] : []),
                { key: "Characters Billed", value: formatNumber(characters) },
                ...(fields["contentType"]
                  ? [{ key: "Content Type", value: String(fields["contentType"]) }]
                  : []),
                ...(fields["state"] ? [{ key: "State", value: String(fields["state"]) }] : []),
                ...(fields["source"] ? [{ key: "Source", value: String(fields["source"]) }] : []),
                ...(fields["date"] ? [{ key: "Generated", value: String(fields["date"]) }] : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Text",
          children: [{ kind: "text", content: String(fields["text"] ?? ""), variant: "mono" }],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: resource.resourceTypeId,
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(resource.fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

/** Character-quota gauge rendered on the voice detail page. */
function quotaSection(quota: StashedQuota): SectionNode {
  const fraction = quota.limit > 0 ? quota.used / quota.limit : 0;
  const percent = Math.round(fraction * 100);
  const remaining = Math.max(0, quota.limit - quota.used);
  return {
    kind: "section",
    title: "Character Quota",
    children: [
      { kind: "text", content: `${meterBar(fraction)}  ${percent}%`, variant: "mono" },
      {
        kind: "key-value-list",
        items: [
          {
            key: "Used",
            value: `${formatNumber(quota.used)} / ${formatNumber(quota.limit)} characters`,
          },
          { key: "Remaining", value: formatNumber(remaining) },
          ...(quota.resetUnix
            ? [{ key: "Resets", value: new Date(quota.resetUnix * 1000).toISOString() }]
            : []),
          ...(quota.tier ? [{ key: "Tier", value: titleCase(quota.tier) }] : []),
        ],
      },
    ],
  };
}

/**
 * Mean per-word confidence, or `undefined` when Scribe returned no logprobs.
 *
 * Scribe has no single transcript-level confidence field; what it gives is
 * `words[].logprob`, the log-probability of each predicted word. `Math.exp`
 * converts each back to a 0..1 probability and the arithmetic mean is the
 * "overall confidence" the `TranscribeAudioResult` contract asks for.
 * Clamped because a logprob of exactly 0 is legal and floating point can
 * nudge `exp(0)` a hair over 1.
 */
function averageWordConfidence(words: ScribeWord[]): number | undefined {
  let sum = 0;
  let count = 0;
  for (const word of words) {
    if (typeof word.logprob !== "number" || !Number.isFinite(word.logprob)) continue;
    sum += Math.min(1, Math.exp(word.logprob));
    count++;
  }
  if (count === 0) return undefined;
  return Number((sum / count).toFixed(4));
}

/** Best-effort extension for the multipart filename Scribe sees. */
function extensionForMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
    case "audio/opus":
      return "ogg";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/aac":
    case "audio/x-aac":
      return "aac";
    default:
      return "bin";
  }
}
