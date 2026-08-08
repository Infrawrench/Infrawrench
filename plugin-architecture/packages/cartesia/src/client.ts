import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  DashboardStat,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
  CostFetchRange,
  CostRow,
} from "@infrawrench/plugin-base";
import { base64ToBytes, bytesToBase64, jsonRestFetch } from "@infrawrench/plugin-base";
import { cartesiaCostSetupError, fetchCartesiaCostData } from "./cost-data.js";

const BASE_URL = "https://api.cartesia.ai";

/**
 * Cartesia pins its API to a date and rejects any request without it — this
 * header is mandatory on *every* call, including GETs.
 * https://docs.cartesia.ai/api-reference/tts/bytes
 */
const CARTESIA_VERSION = "2026-03-01";

/** Cartesia has no GET /models endpoint — the TTS model list is a fixed enum. */
const SONIC_MODELS: SpeechPanelOption[] = [
  {
    id: "sonic-3.5",
    label: "Sonic 3.5",
    description: "Current flagship — fastest and most natural, sub-90 ms latency",
  },
  { id: "sonic-3", label: "Sonic 3", description: "Previous generation, pinned snapshot" },
  {
    id: "sonic-latest",
    label: "Sonic (latest)",
    description: "Rolling beta — can change without notice, not for production",
  },
];

const DEFAULT_MODEL = "sonic-3.5";

/** Cartesia's batch transcription API exposes exactly one model. */
const STT_MODEL = "ink-whisper";

/**
 * Formats the batch STT endpoint documents as accepted uploads.
 * https://docs.cartesia.ai/api-reference/stt/transcribe
 */
const ACCEPTED_AUDIO_TYPES = [
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
  "audio/*",
];

/**
 * A trimmed picker list for the transcription half. Ink Whisper accepts 99+
 * ISO-639-1 codes; these are the ones the Sonic voice library actually covers,
 * so the two halves of the panel agree.
 * https://docs.cartesia.ai/build-with-cartesia/models/tts
 */
const LANGUAGES: SpeechPanelOption[] = [
  { id: "en", label: "English" },
  { id: "ar", label: "Arabic" },
  { id: "bn", label: "Bengali" },
  { id: "bg", label: "Bulgarian" },
  { id: "zh", label: "Chinese" },
  { id: "hr", label: "Croatian" },
  { id: "cs", label: "Czech" },
  { id: "da", label: "Danish" },
  { id: "nl", label: "Dutch" },
  { id: "fi", label: "Finnish" },
  { id: "fr", label: "French" },
  { id: "ka", label: "Georgian" },
  { id: "de", label: "German" },
  { id: "el", label: "Greek" },
  { id: "gu", label: "Gujarati" },
  { id: "he", label: "Hebrew" },
  { id: "hi", label: "Hindi" },
  { id: "hu", label: "Hungarian" },
  { id: "id", label: "Indonesian" },
  { id: "it", label: "Italian" },
  { id: "ja", label: "Japanese" },
  { id: "kn", label: "Kannada" },
  { id: "ko", label: "Korean" },
  { id: "ms", label: "Malay" },
  { id: "ml", label: "Malayalam" },
  { id: "mr", label: "Marathi" },
  { id: "no", label: "Norwegian" },
  { id: "pl", label: "Polish" },
  { id: "pt", label: "Portuguese" },
  { id: "pa", label: "Punjabi" },
  { id: "ro", label: "Romanian" },
  { id: "ru", label: "Russian" },
  { id: "sk", label: "Slovak" },
  { id: "es", label: "Spanish" },
  { id: "sv", label: "Swedish" },
  { id: "tl", label: "Tagalog" },
  { id: "ta", label: "Tamil" },
  { id: "te", label: "Telugu" },
  { id: "th", label: "Thai" },
  { id: "tr", label: "Turkish" },
  { id: "uk", label: "Ukrainian" },
  { id: "vi", label: "Vietnamese" },
];

/**
 * Voice/dictionary/key listings all share one cursor envelope: `limit` +
 * `starting_after`, answered with `{ data, has_more, next_page }`.
 */
interface CartesiaPage<T> {
  data?: T[];
  has_more?: boolean;
  next_page?: string | null;
}

interface CartesiaAccess {
  type?: string;
  visibility?: string;
}

interface CartesiaVoice {
  id: string;
  name?: string;
  tagline?: string;
  description?: string;
  gender?: string | null;
  language?: string;
  locales?: Array<{ locale?: string } | string>;
  country?: string | null;
  created_at?: string;
  is_owner?: boolean;
  is_pro?: boolean;
  access?: CartesiaAccess;
  /** Null unless the request asked for `expand[]=preview_file_url`. */
  preview_file_url?: string | null;
}

interface CartesiaPronunciationItem {
  text?: string;
  pronunciation?: string;
  alias?: string;
}

interface CartesiaPronunciationDict {
  id: string;
  name?: string;
  description?: string;
  is_owner?: boolean;
  access?: CartesiaAccess;
  pinned?: boolean;
  items?: CartesiaPronunciationItem[];
  created_at?: string;
}

interface CartesiaApiKey {
  id: string;
  description?: string;
  created_at?: string;
  creator_email?: string | null;
  creator_still_in_org?: boolean | null;
}

interface CartesiaCreditBucket {
  start_ts?: string;
  end_ts?: string;
  credits?: number;
}

interface CartesiaCreditsResponse {
  group_by?: string;
  data?: CartesiaCreditBucket[];
}

interface CartesiaTranscript {
  type?: string;
  request_id?: string;
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

/** Guard rail on the shared voice library, which is far larger than one org. */
const MAX_LIST_PAGES = 5;
const PAGE_SIZE = 100;
/** How many voices the Speech tab's picker carries in the detail payload. */
const MAX_PICKER_VOICES = 200;

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function localeLabels(voice: CartesiaVoice): string {
  return (voice.locales ?? [])
    .map((entry) => (typeof entry === "string" ? entry : (entry.locale ?? "")))
    .filter(Boolean)
    .join(", ");
}

function voiceSubtitle(voice: {
  language?: string;
  gender?: string | null;
  tagline?: string;
}): string {
  const parts = [voice.tagline, voice.language, voice.gender].map(str).filter(Boolean);
  return parts.join(" · ");
}

/**
 * Cartesia plugin client.
 *
 * Created per account. Every request carries `Authorization: Bearer sk_car_…`
 * plus the mandatory `Cartesia-Version` header. `/usage/credits` and
 * `/api-keys` are the two surfaces Cartesia gates behind a *separate* admin
 * key; when the account has none we degrade those to empty rather than
 * failing the whole account.
 */
export class CartesiaClient implements PluginClient {
  private readonly apiKey: string;
  private readonly adminApiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Cartesia plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.adminApiKey = credentials["adminApiKey"] ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** True when the account carries the admin key the usage/keys APIs require. */
  private get hasAdminKey(): boolean {
    return this.adminApiKey.length > 0;
  }

  private headers(admin = false): Record<string, string> {
    const token = admin ? this.adminApiKey : this.apiKey;
    return {
      Authorization: `Bearer ${token}`,
      "Cartesia-Version": CARTESIA_VERSION,
      Accept: "application/json",
    };
  }

  private async fetch<T>(path: string, options?: RequestInit, admin = false): Promise<T> {
    if (admin && !this.hasAdminKey) {
      throw new Error(
        `Cartesia plugin: ${path} requires an admin API key (sk_car_admin_…); add one to this account to enable it`,
      );
    }
    return jsonRestFetch<T>({
      vendor: "Cartesia",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: this.headers(admin),
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  /** Walk the shared `limit` / `starting_after` cursor until it runs out. */
  private async listPaginated<T>(
    path: string,
    params: Record<string, string | string[]>,
    admin = false,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams();
      query.set("limit", String(PAGE_SIZE));
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) for (const v of value) query.append(key, v);
        else query.set(key, value);
      }
      if (cursor) query.set("starting_after", cursor);

      const body = await this.fetch<CartesiaPage<T>>(
        `${path}?${query.toString()}`,
        undefined,
        admin,
      );
      out.push(...(body.data ?? []));
      if (!body.has_more || !body.next_page) break;
      cursor = body.next_page;
    }

    return out;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "voice":
        return (await this.fetchVoices()).map((voice) => this.mapVoice(accountId, voice));
      case "pronunciation-dict":
        return (await this.fetchPronunciationDicts()).map((dict) =>
          this.mapPronunciationDict(accountId, dict),
        );
      case "api-key":
        return (await this.fetchApiKeys()).map((key) => this.mapApiKey(accountId, key));
      default:
        throw new Error(`Cartesia plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "voice") {
      // GET /voices/{id} — verified 2026-07-28 against
      // https://docs.cartesia.ai/api-reference/voices/get
      // `preview_file_url` stays null unless expand[] asks for it.
      const query = new URLSearchParams();
      query.append("expand[]", "preview_file_url");
      const voice = await this.fetch<CartesiaVoice>(
        `/voices/${encodeURIComponent(externalId)}?${query.toString()}`,
      );
      const instance = this.mapVoice(accountId, voice);

      // renderDetail is synchronous, so the Speech tab's voice picker has to be
      // fetched here and stashed as JSON for renderDetail to parse back out.
      const picker = await this.fetchVoicePickerOptions();
      instance.resolvedOutputs = {
        ...instance.resolvedOutputs,
        __voices__: JSON.stringify(picker),
      };
      return instance;
    }

    const all = await this.listResources(typeId, accountId);
    const found = all.find((resource) => resource.id === resourceId);
    if (!found) throw new Error(`Cartesia plugin: resource ${typeId}/${externalId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const f = resource.fields;

    if (typeId === "voice") {
      if (outputKey === "voiceId") return str(f["voiceId"]);
      if (outputKey === "voiceName") return str(f["name"]);
      if (outputKey === "language") return str(f["language"]);
      if (outputKey === "previewUrl") return str(f["previewUrl"]);
    }

    if (typeId === "pronunciation-dict") {
      if (outputKey === "dictId") return str(f["dictId"]);
      if (outputKey === "dictName") return str(f["name"]);
    }

    if (typeId === "api-key" && outputKey === "keyId") return str(f["keyId"]);

    throw new Error(`Cartesia plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    if (resourceTypeId === "voice") {
      return [
        { label: "Language", value: str(f["language"]) || "—" },
        { label: "Gender", value: str(f["gender"]) || "—" },
        { label: "Access", value: str(f["accessType"]) || "—" },
      ];
    }

    if (resourceTypeId === "pronunciation-dict") {
      return [
        { label: "Entries", value: str(f["entryCount"] ?? 0) },
        { label: "Access", value: str(f["accessType"]) || "—" },
        { label: "Owner", value: f["isOwner"] === true ? "You" : "Shared" },
      ];
    }

    if (resourceTypeId === "api-key") {
      // Cartesia reports consumption only — there is no plan ceiling on this
      // endpoint, so this is a spend figure and deliberately not a gauge.
      const keyId = str(f["keyId"]);
      const [keyCredits, orgCredits] = await Promise.all([
        this.fetchCredits(keyId),
        this.fetchCredits(),
      ]);
      return [
        {
          label: "Credits (30 d)",
          value: keyCredits === null ? "admin key required" : keyCredits.toLocaleString(),
        },
        {
          label: "Org credits (30 d)",
          value: orgCredits === null ? "admin key required" : orgCredits.toLocaleString(),
        },
        { label: "Created by", value: str(f["creatorEmail"]) || "—" },
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "voice":
        return this.renderVoiceDetail(resource);
      case "pronunciation-dict":
        return this.renderPronunciationDictDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
          sections: [],
          headerActions: [],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status: resource.fields["isOwner"] === true ? "healthy" : "info",
      },
    };
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "voice") {
      // DELETE /voices/{id} — verified 2026-07-28 against
      // https://docs.cartesia.ai/api-reference/voices/delete (204 No Content).
      await this.fetch(`/voices/${encodeURIComponent(externalId)}`, { method: "DELETE" });
      return;
    }

    if (typeId === "pronunciation-dict") {
      // DELETE /pronunciation-dicts/{id} — verified 2026-07-28 against
      // https://docs.cartesia.ai/api-reference/pronunciation-dicts/delete
      // (no trailing slash here, unlike the list endpoint).
      await this.fetch(`/pronunciation-dicts/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }

    throw new Error(`Cartesia plugin: cannot delete type "${typeId}"`);
  }

  // ---- Speech tab ----------------------------------------------------------

  async synthesizeSpeech(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    if (typeId !== "voice") {
      throw new Error(`Cartesia plugin: cannot synthesize speech for type "${typeId}"`);
    }

    const voiceId = payload.voiceId || externalIdOf(resourceId);
    if (!voiceId) throw new Error("Cartesia plugin: no voice selected for synthesis");
    const modelId = payload.modelId || DEFAULT_MODEL;

    const started = Date.now();
    const { bytes, requestId } = await this.ttsBytes({
      model_id: modelId,
      transcript: payload.text,
      // The voice is part of the body, not the path, and always arrives as an
      // object rather than a bare id.
      voice: { mode: "id", id: voiceId },
      // Required — Cartesia has no server-side default. For mp3 the object is
      // container/sample_rate/bit_rate only; adding an `encoding` key here is
      // rejected with a 400.
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    });
    const elapsedMs = Date.now() - started;

    const characters = payload.text.length;
    return {
      audioBase64: bytesToBase64(bytes),
      mimeType: "audio/mpeg",
      fileName: `cartesia-${voiceId}.mp3`,
      summary: `${modelId} · ${characters.toLocaleString()} characters · mp3 44.1 kHz 128 kbps · ${elapsedMs} ms`,
      characters,
      ...(requestId ? { requestId } : {}),
    };
  }

  async transcribeAudio(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    if (typeId !== "voice") {
      throw new Error(`Cartesia plugin: cannot transcribe audio for type "${typeId}"`);
    }

    const result = await this.sttTranscribe(payload);

    const words: TranscriptWord[] = (result.words ?? [])
      .filter((word) => typeof word.word === "string")
      .map((word) => ({
        text: str(word.word),
        ...(typeof word.start === "number" ? { start: word.start } : {}),
        ...(typeof word.end === "number" ? { end: word.end } : {}),
      }));

    const duration = typeof result.duration === "number" ? result.duration : undefined;
    const summaryParts = [STT_MODEL];
    if (duration !== undefined) summaryParts.push(`${duration.toFixed(1)} s of audio`);
    if (words.length > 0) summaryParts.push(`${words.length} words`);

    return {
      text: str(result.text),
      summary: summaryParts.join(" · "),
      ...(result.language ? { language: result.language } : {}),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      ...(words.length > 0 ? { words } : {}),
      ...(result.request_id ? { requestId: result.request_id } : {}),
    };
  }

  /**
   * POST /tts/bytes — verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/tts/bytes
   *
   * Deliberately not routed through `jsonRestFetch`: that helper JSON-parses
   * every response, and this one is raw mp3. Using the global `fetch` here
   * means this single call bypasses bastion egress routing and the custom CA
   * credential; all the JSON control-plane calls still go through the host.
   */
  private async ttsBytes(
    body: Record<string, unknown>,
  ): Promise<{ bytes: Uint8Array; requestId?: string }> {
    const res = await fetch(`${BASE_URL}/tts/bytes`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    });

    // A failed call answers with JSON where we expected audio, so branch on the
    // status *before* touching the body.
    if (!res.ok) {
      throw new Error(`Cartesia API error ${res.status} for /tts/bytes: ${await safeText(res)}`);
    }

    const requestId = headerValue(res, "x-request-id");
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      ...(requestId ? { requestId } : {}),
    };
  }

  /**
   * POST /stt — verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/stt/transcribe
   *
   * multipart/form-data, so this also goes through the global `fetch`:
   * `jsonRestFetch`'s host-HTTP path stringifies FormData rather than
   * encoding it. The clip's Content-Type is whatever MediaRecorder or the
   * file picker produced — forwarded verbatim, never transcoded.
   */
  private async sttTranscribe(payload: TranscribeAudioPayload): Promise<CartesiaTranscript> {
    const bytes = base64ToBytes(payload.audioBase64);
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: payload.mimeType }),
      payload.fileName ?? fileNameFor(payload.mimeType),
    );
    // Ink Whisper is the only transcription model Cartesia exposes; the Speech
    // tab's model picker drives synthesis, not this call.
    form.append("model", STT_MODEL);
    if (payload.language) form.append("language", payload.language);
    form.append("timestamp_granularities[]", "word");

    // No Content-Type header — fetch has to set it so the multipart boundary
    // matches the body it generated.
    const res = await fetch(`${BASE_URL}/stt`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Cartesia API error ${res.status} for /stt: ${await safeText(res)}`);
    }
    return (await res.json()) as CartesiaTranscript;
  }

  // ---- Listing -------------------------------------------------------------

  /**
   * GET /voices — verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/voices/list
   *
   * `expand[]=preview_file_url` is required: without it every voice comes back
   * with `preview_file_url: null`.
   */
  private async fetchVoices(): Promise<CartesiaVoice[]> {
    return this.listPaginated<CartesiaVoice>("/voices", {
      "expand[]": ["preview_file_url"],
    });
  }

  private async fetchVoicePickerOptions(): Promise<SpeechPanelOption[]> {
    const voices = await this.fetchVoices();
    return voices.slice(0, MAX_PICKER_VOICES).map((voice) => {
      const description = voiceSubtitle(voice);
      return {
        id: voice.id,
        label: str(voice.name) || voice.id,
        ...(description ? { description } : {}),
      };
    });
  }

  /**
   * GET /pronunciation-dicts/ — verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/pronunciation-dicts/list
   * The trailing slash is part of the documented path.
   */
  private async fetchPronunciationDicts(): Promise<CartesiaPronunciationDict[]> {
    return this.listPaginated<CartesiaPronunciationDict>("/pronunciation-dicts/", {});
  }

  /**
   * GET /api-keys — verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/api-keys/list
   * Admin-key only; without one we list nothing rather than break the account.
   */
  private async fetchApiKeys(): Promise<CartesiaApiKey[]> {
    if (!this.hasAdminKey) return [];
    return this.listPaginated<CartesiaApiKey>("/api-keys", {}, true);
  }

  /**
   * GET /usage/credits — verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/usage/credits
   *
   * Admin-key only, and consumption-only: there is no plan limit in the
   * response, so this is never rendered as a used-vs-limit gauge. Returns
   * `null` when the account has no admin key.
   */
  private async fetchCredits(apiKeyId?: string): Promise<number | null> {
    if (!this.hasAdminKey) return null;

    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const query = new URLSearchParams();
    query.set("start_ts", start.toISOString());
    query.set("end_ts", end.toISOString());
    if (apiKeyId) query.set("api_key_id", apiKeyId);

    const body = await this.fetch<CartesiaCreditsResponse>(
      `/usage/credits?${query.toString()}`,
      undefined,
      true,
    );
    return (body.data ?? []).reduce((sum, bucket) => sum + (bucket.credits ?? 0), 0);
  }

  // ---- Cost ----------------------------------------------------------------

  /**
   * Daily spend from `GET /usage/credits`, grouped by capability. The work
   * lives in `cost-data.ts` so it can be tested without a client; this hands it
   * the admin key and the host's HTTP/CA settings.
   *
   * The admin-key guard is repeated here so the failure is visible at the
   * host-facing entry point, not buried a call away: without an admin key the
   * endpoint is unreachable and the account would otherwise report no spend
   * forever rather than telling the user what to do.
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (!this.hasAdminKey) throw cartesiaCostSetupError();

    return fetchCartesiaCostData(
      {
        adminApiKey: this.adminApiKey,
        apiVersion: CARTESIA_VERSION,
        baseUrl: BASE_URL,
        ...(this.services?.http ? { http: this.services.http } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      },
      range,
    );
  }

  // ---- Mapping -------------------------------------------------------------

  private mapVoice(accountId: string, voice: CartesiaVoice): ResourceInstance {
    const now = new Date().toISOString();
    const createdAt = voice.created_at ?? now;
    return {
      id: `${accountId}:voice:${voice.id}`,
      pluginId: "cartesia",
      resourceTypeId: "voice",
      accountId,
      displayName: str(voice.name) || voice.id,
      externalId: voice.id,
      fields: {
        name: str(voice.name),
        voiceId: voice.id,
        tagline: str(voice.tagline),
        description: str(voice.description),
        language: str(voice.language),
        locales: localeLabels(voice),
        gender: str(voice.gender),
        country: str(voice.country),
        accessType: str(voice.access?.type),
        visibility: str(voice.access?.visibility),
        isOwner: voice.is_owner === true,
        isPro: voice.is_pro === true,
        previewUrl: str(voice.preview_file_url),
        createdAt,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt,
      updatedAt: now,
    };
  }

  private mapPronunciationDict(
    accountId: string,
    dict: CartesiaPronunciationDict,
  ): ResourceInstance {
    const now = new Date().toISOString();
    const createdAt = dict.created_at ?? now;
    const items = dict.items ?? [];
    return {
      id: `${accountId}:pronunciation-dict:${dict.id}`,
      pluginId: "cartesia",
      resourceTypeId: "pronunciation-dict",
      accountId,
      displayName: str(dict.name) || dict.id,
      externalId: dict.id,
      fields: {
        name: str(dict.name),
        dictId: dict.id,
        description: str(dict.description),
        entryCount: items.length,
        accessType: str(dict.access?.type),
        visibility: str(dict.access?.visibility),
        isOwner: dict.is_owner === true,
        pinned: dict.pinned === true,
        createdAt,
      },
      // renderDetail can't call the API, so the entries ride along as JSON.
      resolvedOutputs: { __items__: JSON.stringify(items) },
      secretStates: [],
      createdAt,
      updatedAt: now,
    };
  }

  private mapApiKey(accountId: string, key: CartesiaApiKey): ResourceInstance {
    const now = new Date().toISOString();
    const createdAt = key.created_at ?? now;
    return {
      id: `${accountId}:api-key:${key.id}`,
      pluginId: "cartesia",
      resourceTypeId: "api-key",
      accountId,
      displayName: str(key.description) || key.id,
      externalId: key.id,
      fields: {
        keyId: key.id,
        description: str(key.description),
        creatorEmail: str(key.creator_email),
        creatorStillInOrg: key.creator_still_in_org === true,
        createdAt,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt,
      updatedAt: now,
    };
  }

  // ---- Detail views --------------------------------------------------------

  private renderVoiceDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const voiceId = str(f["voiceId"]) || resource.externalId || "";
    const name = str(f["name"]) || resource.displayName;

    const voices = parseVoiceOptions(resource.resolvedOutputs?.["__voices__"]);
    if (!voices.some((option) => option.id === voiceId) && voiceId) {
      const description = voiceSubtitle({
        language: str(f["language"]),
        gender: str(f["gender"]),
        tagline: str(f["tagline"]),
      });
      voices.unshift({ id: voiceId, label: name, ...(description ? { description } : {}) });
    }

    const previewUrl = str(f["previewUrl"]);

    return {
      title: name,
      subtitle: `Cartesia Voice · ${str(f["language"]) || "unknown language"}`,
      status: { kind: "status-dot", status: f["isOwner"] === true ? "healthy" : "info" },
      sections: [
        {
          kind: "section",
          title: "Voice",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Voice ID", value: voiceId || "—" },
                { key: "Tagline", value: str(f["tagline"]) || "—" },
                { key: "Description", value: str(f["description"]) || "—" },
                { key: "Language", value: str(f["language"]) || "—" },
                { key: "Locales", value: str(f["locales"]) || "—" },
                { key: "Gender", value: str(f["gender"]) || "—" },
                { key: "Country", value: str(f["country"]) || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Access",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Access", value: str(f["accessType"]) || "—" },
                { key: "Visibility", value: str(f["visibility"]) || "—" },
                { key: "Owned by You", value: f["isOwner"] === true ? "Yes" : "No" },
                { key: "Pro Voice Clone", value: f["isPro"] === true ? "Yes" : "No" },
                { key: "Created", value: str(f["createdAt"]) || "—" },
                {
                  key: "Preview Audio",
                  value:
                    previewUrl || "— (Cartesia only returns this with expand[]=preview_file_url)",
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      speechPanel: {
        modes: ["tts", "stt"],
        subtitle: `Sonic text-to-speech and Ink Whisper transcription · ${name}`,
        helpText:
          "The model picker applies to synthesis. Transcription always runs on ink-whisper — Cartesia's only transcription model — and the language picker applies to it. Audio comes back as 44.1 kHz 128 kbps mp3.",
        voices,
        ...(voiceId ? { defaultVoice: voiceId } : {}),
        voiceLabel: "Voice",
        models: SONIC_MODELS,
        defaultModel: DEFAULT_MODEL,
        modelLabel: "Synthesis model",
        languages: LANGUAGES,
        defaultLanguage: "en",
        languageLabel: "Transcription language",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        // No maxCharacters: Cartesia documents no per-request transcript limit,
        // so we let the provider's own error surface rather than guessing one.
      },
    };
  }

  private renderPronunciationDictDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const items = parsePronunciationItems(resource.resolvedOutputs?.["__items__"]);

    return {
      title: str(f["name"]) || resource.displayName,
      subtitle: `Cartesia Pronunciation Dictionary · ${items.length} ${
        items.length === 1 ? "entry" : "entries"
      }`,
      status: { kind: "status-dot", status: f["isOwner"] === true ? "healthy" : "info" },
      sections: [
        {
          kind: "section",
          title: "Dictionary",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Dictionary ID", value: str(f["dictId"]) || "—" },
                { key: "Description", value: str(f["description"]) || "—" },
                { key: "Access", value: str(f["accessType"]) || "—" },
                { key: "Visibility", value: str(f["visibility"]) || "—" },
                { key: "Owned by You", value: f["isOwner"] === true ? "Yes" : "No" },
                { key: "Pinned", value: f["pinned"] === true ? "Yes" : "No" },
                { key: "Created", value: str(f["createdAt"]) || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Entries",
          children: [
            {
              kind: "key-value-list",
              items:
                items.length > 0
                  ? items.map((item) => ({
                      key: str(item.text) || "—",
                      value: str(item.pronunciation ?? item.alias) || "—",
                    }))
                  : [{ key: "Entries", value: "None" }],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: str(f["description"]) || resource.displayName,
      subtitle: "Cartesia API Key",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key ID", value: str(f["keyId"]) || "—" },
                { key: "Description", value: str(f["description"]) || "—" },
                { key: "Created By", value: str(f["creatorEmail"]) || "—" },
                {
                  key: "Creator Still in Org",
                  value: f["creatorStillInOrg"] === true ? "Yes" : "No",
                },
                { key: "Created", value: str(f["createdAt"]) || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

/** `{accountId}:{typeId}:{externalId}` → `{externalId}`. */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function parseVoiceOptions(raw: string | undefined): SpeechPanelOption[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SpeechPanelOption =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SpeechPanelOption).id === "string",
    );
  } catch {
    return [];
  }
}

function parsePronunciationItems(raw: string | undefined): CartesiaPronunciationItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartesiaPronunciationItem[]) : [];
  } catch {
    return [];
  }
}

/** Best-effort extension so the upload keeps a name the provider recognises. */
function fileNameFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim() ?? "";
  const map: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "video/webm": "webm",
    "video/mp4": "mp4",
  };
  return `recording.${map[base] ?? "webm"}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

function headerValue(res: Response, name: string): string | undefined {
  return res.headers?.get?.(name) ?? undefined;
}
