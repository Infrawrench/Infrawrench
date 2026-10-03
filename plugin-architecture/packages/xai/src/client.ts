import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  KVItem,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  SpeechPanelCapability,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TableRow,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import {
  CostSetupError,
  CreditAccessError,
  base64ToBytes,
  jsonRestFetch,
} from "@infrawrench/plugin-base";
import {
  type XaiInvoice,
  type XaiInvoicePreview,
  type XaiSpendingLimits,
  formatUsd,
  invoiceStatusDot,
  mapInvoice,
  mapSpendingLimit,
  prepaidBalances,
  renderInvoiceDetail,
  renderSpendingLimitDetail,
} from "./billing.js";
import {
  type XaiCollection,
  type XaiCollectionDocument,
  documentStatusDot,
  mapCollection,
  mapCollectionDocument,
  renderCollectionDetail,
  renderCollectionDocumentDetail,
  splitDocumentId,
} from "./collections.js";

const INFERENCE_BASE = "https://api.x.ai";
const MANAGEMENT_BASE = "https://management-api.x.ai";

/** Docs: POST /v1/tts caps `text` at 15,000 characters. */
const TTS_MAX_CHARACTERS = 15_000;
/**
 * POST /v1/stt accepts up to 500 MB upstream, but a Speech-tab clip crosses the
 * host boundary base64-encoded inside ordinary JSON: cap it at the 25 MB the
 * panel defaults to rather than letting a half-gigabyte upload through.
 */
const STT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * The audit log is unbounded, so the walk needs a stop: 20 pages of 200 is the
 * 4,000 most recent events, in line with the 20-page cap the other list loops
 * use. Anything past that is reported as a truncation row rather than dropped.
 */
const AUDIT_PAGE_SIZE = 200;
const AUDIT_MAX_PAGES = 20;
const AUDIT_TRUNCATED_ID = "__truncated__";

/** Invoices are listed from this many months back. */
const INVOICE_HISTORY_MONTHS = 24;

/** First page of per-request state shown on a batch's detail view. */
const BATCH_REQUESTS_PREVIEW = 100;

const MANAGEMENT_KEY_HELP = {
  label: "Create a management key",
  url: "https://console.x.ai/team/default/settings",
};

/**
 * Every price the models endpoints report is an integer of USD cents per 100
 * million units: whatever the unit is. `grok-4.3` lists
 * `prompt_text_token_price: 12500` against its published $1.25 / 1M tokens, and
 * `grok-imagine-image` lists `image_price: 200000000` against its published
 * $0.02 an image, so the same 1e8 scale covers tokens, images and search
 * sources. Divide by 1e4 for dollars per million, by 1e10 for dollars apiece.
 *
 * Docs: https://docs.x.ai/openapi.json, https://docs.x.ai/docs/models
 */
const PRICE_PER_MILLION = 1e4;
const PRICE_PER_UNIT = 1e10;

/**
 * BCP-47 codes POST /v1/tts documents for its required `language` field.
 * `auto` is TTS-only, for STT the plugin simply omits `language`.
 */
const TTS_LANGUAGES: SpeechPanelOption[] = [
  { id: "auto", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "ar-EG", label: "Arabic (Egypt)" },
  { id: "ar-SA", label: "Arabic (Saudi Arabia)" },
  { id: "ar-AE", label: "Arabic (UAE)" },
  { id: "bn", label: "Bengali" },
  { id: "zh", label: "Chinese" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "hi", label: "Hindi" },
  { id: "id", label: "Indonesian" },
  { id: "it", label: "Italian" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "pt-BR", label: "Portuguese (Brazil)" },
  { id: "pt-PT", label: "Portuguese (Portugal)" },
  { id: "ru", label: "Russian" },
  { id: "es-MX", label: "Spanish (Mexico)" },
  { id: "es-ES", label: "Spanish (Spain)" },
  { id: "tr", label: "Turkish" },
  { id: "vi", label: "Vietnamese" },
];

/**
 * Fallback for the voice picker when GET /v1/tts/voices can't be reached.
 * These are the built-in voices xAI documents for POST /v1/tts.
 */
const FALLBACK_BUILTIN_VOICES: Array<{ voice_id: string; name: string }> = [
  { voice_id: "eve", name: "Eve" },
  { voice_id: "ara", name: "Ara" },
  { voice_id: "leo", name: "Leo" },
  { voice_id: "rex", name: "Rex" },
  { voice_id: "sal", name: "Sal" },
];

const DASH = "—";

// ---------------------------------------------------------------- API shapes

interface XaiLanguageModel {
  id: string;
  owned_by?: string;
  version?: string;
  fingerprint?: string;
  created?: number;
  aliases?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  long_context_threshold?: number;
  prompt_text_token_price?: number;
  completion_text_token_price?: number;
  cached_prompt_text_token_price?: number;
  prompt_text_token_price_long_context?: number;
  completion_text_token_price_long_context?: number;
  cached_prompt_text_token_price_long_context?: number;
  prompt_image_token_price?: number;
  search_price?: number;
  /** Optional request parameters the model accepts. */
  capabilities?: {
    reasoning_effort?: string[];
    default_reasoning_effort?: string | null;
  } | null;
}

interface XaiImageModel {
  id: string;
  owned_by?: string;
  version?: string;
  fingerprint?: string;
  created?: number;
  aliases?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  image_price?: number;
  max_prompt_length?: number;
  /** Per-image price by quality and resolution, on the same 1e8 scale. */
  pricing?: Array<{ quality?: string; resolution?: string; price_per_image?: number }>;
}

interface XaiVideoModel {
  id: string;
  owned_by?: string;
  version?: string;
  fingerprint?: string;
  created?: number;
  aliases?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
}

interface XaiSkill {
  id: string;
  name?: string;
  description?: string;
  default_version?: string;
  latest_version?: string;
  created_at?: number;
}

interface XaiBatchRequestMeta {
  batch_request_id?: string;
  create_time?: string;
  endpoint?: string;
  finish_time?: string | null;
  model?: string;
  state?: string;
}

interface XaiEmbeddingModel {
  id: string;
  owned_by?: string;
  version?: string;
  fingerprint?: string;
  created?: number;
  aliases?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  prompt_text_token_price?: number;
  prompt_image_token_price?: number;
}

interface XaiFile {
  id: string;
  filename: string;
  bytes?: number;
  created_at?: number;
  expires_at?: number | null;
  purpose?: string;
  public_url?: string | null;
  public_url_expires_at?: number | null;
}

interface XaiBatch {
  batch_id: string;
  name?: string;
  create_time?: string;
  expire_time?: string | null;
  cancel_time?: string | null;
  cancel_by_xai_message?: string | null;
  create_api_key_id?: string;
  state?: {
    num_requests?: number;
    num_pending?: number;
    num_success?: number;
    num_error?: number;
    num_cancelled?: number;
  };
}

interface XaiVoice {
  voice_id: string;
  name?: string | null;
  language?: string | null;
}

interface XaiCustomVoice extends XaiVoice {
  description?: string | null;
  gender?: string | null;
  accent?: string | null;
  age?: string | null;
  use_case?: string | null;
  tone?: string | null;
  created_at?: string;
}

interface XaiManagedApiKey {
  apiKeyId?: string;
  redactedApiKey?: string;
  apiKey?: string;
  userId?: string;
  name?: string;
  createTime?: string;
  modifyTime?: string;
  teamId?: string;
  disabled?: boolean | string;
  expireTime?: string;
  qps?: number;
  qpm?: number;
  tpm?: string;
  aclStrings?: string[];
  acl_strings?: string[];
}

interface XaiAuditEvent {
  eventTime?: string;
  eventId?: string;
  description?: string;
  user?: {
    userId?: string;
    email?: string;
    givenName?: string;
    familyName?: string;
  };
}

interface XaiUsageResponse {
  timeSeries?: Array<{
    group?: string[];
    groupLabels?: string[];
    dataPoints?: Array<{ timestamp?: string; values?: number[] }>;
  }>;
  limitReached?: boolean;
}

interface XaiTtsResponse {
  audio: string;
  content_type?: string;
  duration?: number;
}

interface XaiSttWord {
  text: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: number;
}

interface XaiSttResponse {
  text: string;
  language?: string;
  duration?: number;
  words?: XaiSttWord[];
}

interface MultipartPart {
  name: string;
  value: string | Uint8Array;
  filename?: string;
  contentType?: string;
}

/**
 * xAI plugin client.
 *
 * Two hosts, two credentials:
 *   - https://api.x.ai            with the inference API key: models, files,
 *     batches, voices, TTS and STT.
 *   - https://management-api.x.ai with the *separate* management key: team API
 *     keys, the audit log, and billing/usage.
 *
 * The management key is optional. Everything that needs it degrades to an empty
 * list (or a clear CostSetupError) rather than failing the whole account.
 */
/**
 * Drop repeated rows from a paged listing, keyed by whatever identifies them.
 *
 * The cursor guard in each loop stops a non-advancing server, but only *after*
 * the repeated page has been read, so the rows still need collapsing. The key
 * is explicit because these loops do not all yield the same shape: most build
 * `ResourceInstance`s keyed by `id`, while the custom-voice loop accumulates
 * raw API rows keyed by `voice_id`. Reading `.id` off those silently collapsed
 * every voice into one, since they all had `undefined` there.
 */
function dedupeBy<T>(rows: T[], key: (row: T) => string | undefined): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const k = key(row);
    if (k === undefined) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class XaiClient implements PluginClient {
  private readonly apiKey: string;
  private readonly managementKey: string | undefined;
  private readonly caCert: string | undefined;
  private readonly services: HostServices | undefined;
  private teamIdPromise: Promise<string> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("xAI plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.managementKey = credentials["managementKey"] || undefined;
    this.caCert = credentials["caCert"] || undefined;
    this.services = services;
  }

  // ------------------------------------------------------------------ HTTP

  /** JSON over the inference host. Docs: https://docs.x.ai/openapi.json */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "xAI",
      url: `${INFERENCE_BASE}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  /**
   * JSON over the management host.
   * Docs: https://docs.x.ai/developers/management-api-guide
   */
  private async mgmtFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const key = this.managementKey;
    if (!key) {
      throw new Error(
        "xAI plugin: this operation needs a management key. Add one under the account's credentials (console.x.ai → Settings → Management Keys).",
      );
    }
    return jsonRestFetch<T>({
      vendor: "xAI Management",
      url: `${MANAGEMENT_BASE}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  /**
   * Hand-rolled `multipart/form-data` POST. `jsonRestFetch` can't carry this:
   * its host-HTTP normaliser stringifies FormData. Building the body as a
   * `Uint8Array` instead means it still goes through `services.http`, so
   * bastion egress routing and a custom CA keep working for uploads.
   */
  private async postMultipart<T>(path: string, parts: MultipartPart[]): Promise<T> {
    const boundary = `----infrawrench${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const body = buildMultipartBody(boundary, parts);
    const url = `${INFERENCE_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    if (this.services?.http) {
      const result = await this.services.http.request({
        url,
        method: "POST",
        headers,
        body,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`xAI API error ${result.status} for ${path}: ${result.body}`);
      }
      return JSON.parse(result.body) as T;
    }

    const res = await fetch(url, { method: "POST", headers, body: body as BodyInit });
    if (!res.ok) throw new Error(`xAI API error ${res.status} for ${path}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  /**
   * Team id, discovered rather than asked for.
   * With a management key: GET /auth/management-keys/validation → `scopeId`.
   * Otherwise: GET /v1/api-key → `team_id`.
   */
  private async getTeamId(): Promise<string> {
    if (!this.teamIdPromise) {
      this.teamIdPromise = this.discoverTeamId().catch((err: unknown) => {
        this.teamIdPromise = undefined;
        throw err;
      });
    }
    return this.teamIdPromise;
  }

  private async discoverTeamId(): Promise<string> {
    if (this.managementKey) {
      const validation = await this.mgmtFetch<{
        scopeId?: string;
        teamId?: string;
        scope?: string;
      }>("/auth/management-keys/validation");
      const id = validation.scopeId || validation.teamId;
      if (id) return id;
    }
    const info = await this.fetch<{ team_id?: string }>("/v1/api-key");
    if (!info.team_id) throw new Error("xAI plugin: could not determine the team id for this key");
    return info.team_id;
  }

  // ------------------------------------------------------------------ list

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return this.listModels(accountId);
      case "file":
        return this.listFiles(accountId);
      case "batch":
        return this.listBatches(accountId);
      case "custom-voice":
        return this.listVoices(accountId);
      case "api-key":
        return this.managementKey ? this.listApiKeys(accountId) : [];
      case "audit-event":
        return this.managementKey ? this.listAuditEvents(accountId) : [];
      case "skill":
        return this.listSkills(accountId);
      case "collection":
        return this.managementKey ? this.listCollections(accountId) : [];
      case "collection-document":
        return this.managementKey ? this.listCollectionDocuments(accountId) : [];
      case "invoice":
        return this.managementKey ? this.listInvoices(accountId) : [];
      case "spending-limit":
        return this.managementKey ? this.listSpendingLimit(accountId) : [];
      default:
        throw new Error(`xAI plugin: unknown resource type "${typeId}"`);
    }
  }

  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const [language, image, video, embedding] = await Promise.all([
      this.fetch<{ models?: XaiLanguageModel[] }>("/v1/language-models"),
      this.fetch<{ models?: XaiImageModel[] }>("/v1/image-generation-models").catch(() => ({
        models: [] as XaiImageModel[],
      })),
      this.fetch<{ models?: XaiVideoModel[] }>("/v1/video-generation-models").catch(() => ({
        models: [] as XaiVideoModel[],
      })),
      this.fetch<{ models?: XaiEmbeddingModel[] }>("/v1/embedding-models").catch(() => ({
        models: [] as XaiEmbeddingModel[],
      })),
    ]);

    const now = new Date().toISOString();
    const rows: ResourceInstance[] = [];

    for (const m of language.models ?? []) {
      rows.push(
        this.makeModel(accountId, now, m.id, "language", {
          ownedBy: m.owned_by ?? "",
          version: m.version ?? "",
          fingerprint: m.fingerprint ?? "",
          aliases: (m.aliases ?? []).join(", "),
          inputModalities: (m.input_modalities ?? []).join(", "),
          outputModalities: (m.output_modalities ?? []).join(", "),
          created: formatEpochSeconds(m.created),
          longContextThreshold: m.long_context_threshold ?? 0,
          promptTextTokenPrice: m.prompt_text_token_price ?? 0,
          completionTextTokenPrice: m.completion_text_token_price ?? 0,
          cachedPromptTextTokenPrice: m.cached_prompt_text_token_price ?? 0,
          promptTextTokenPriceLongContext: m.prompt_text_token_price_long_context ?? 0,
          completionTextTokenPriceLongContext: m.completion_text_token_price_long_context ?? 0,
          cachedPromptTextTokenPriceLongContext: m.cached_prompt_text_token_price_long_context ?? 0,
          promptImageTokenPrice: m.prompt_image_token_price ?? 0,
          searchPrice: m.search_price ?? 0,
          reasoningEfforts: (m.capabilities?.reasoning_effort ?? []).join(", "),
          defaultReasoningEffort: m.capabilities?.default_reasoning_effort ?? "",
        }),
      );
    }

    for (const m of image.models ?? []) {
      rows.push(
        this.makeModel(accountId, now, m.id, "image-generation", {
          ownedBy: m.owned_by ?? "",
          version: m.version ?? "",
          fingerprint: m.fingerprint ?? "",
          aliases: (m.aliases ?? []).join(", "),
          inputModalities: (m.input_modalities ?? []).join(", "),
          outputModalities: (m.output_modalities ?? []).join(", "),
          created: formatEpochSeconds(m.created),
          imagePrice: m.image_price ?? 0,
          maxPromptLength: m.max_prompt_length ?? 0,
          imagePricingTiers: m.pricing?.length ? JSON.stringify(m.pricing) : "",
        }),
      );
    }

    for (const m of video.models ?? []) {
      rows.push(
        this.makeModel(accountId, now, m.id, "video-generation", {
          ownedBy: m.owned_by ?? "",
          version: m.version ?? "",
          fingerprint: m.fingerprint ?? "",
          aliases: (m.aliases ?? []).join(", "),
          inputModalities: (m.input_modalities ?? []).join(", "),
          outputModalities: (m.output_modalities ?? []).join(", "),
          created: formatEpochSeconds(m.created),
        }),
      );
    }

    for (const m of embedding.models ?? []) {
      rows.push(
        this.makeModel(accountId, now, m.id, "embedding", {
          ownedBy: m.owned_by ?? "",
          version: m.version ?? "",
          fingerprint: m.fingerprint ?? "",
          aliases: (m.aliases ?? []).join(", "),
          inputModalities: (m.input_modalities ?? []).join(", "),
          outputModalities: (m.output_modalities ?? []).join(", "),
          created: formatEpochSeconds(m.created),
          promptTextTokenPrice: m.prompt_text_token_price ?? 0,
          promptImageTokenPrice: m.prompt_image_token_price ?? 0,
        }),
      );
    }

    return rows;
  }

  private makeModel(
    accountId: string,
    now: string,
    id: string,
    kind: string,
    extra: Record<string, string | number | boolean>,
  ): ResourceInstance {
    return {
      id: `${accountId}:model:${id}`,
      pluginId: "xai",
      resourceTypeId: "model",
      accountId,
      displayName: id,
      externalId: id,
      fields: { modelId: id, kind, ...extra },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** GET /v1/files: `limit` maxes out at 100; page with `pagination_token`. */
  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    let token: string | undefined;
    let seenToken: string | undefined;

    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: "100", order: "desc", sort_by: "created_at" });
      if (token) qs.set("pagination_token", token);
      const data = await this.fetch<{ data?: XaiFile[]; pagination_token?: string | null }>(
        `/v1/files?${qs.toString()}`,
      );
      const batch = data.data ?? [];
      for (const file of batch) {
        out.push({
          id: `${accountId}:file:${file.id}`,
          pluginId: "xai",
          resourceTypeId: "file",
          accountId,
          displayName: file.filename || file.id,
          externalId: file.id,
          fields: {
            fileId: file.id,
            filename: file.filename ?? "",
            bytes: file.bytes ?? 0,
            purpose: file.purpose ?? "",
            createdAt: formatEpochSeconds(file.created_at),
            expiresAt: formatEpochSeconds(file.expires_at ?? undefined),
            publicUrl: file.public_url ?? "",
            publicUrlExpiresAt: formatEpochSeconds(file.public_url_expires_at ?? undefined),
          },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      token = data.pagination_token ?? undefined;
      // `pagination_token` is the only end-of-list signal. A short page is not
      // one: the server may return fewer than `limit` rows and still hand back a
      // token, and stopping there silently drops every file behind it; they
      // vanish from the listing and getResource/delete then 404 on them.
      // A repeated cursor means the server is not advancing. Without this the
      // loop re-fetches the same page until the iteration cap and emits
      // duplicate resource ids, which is worse than the truncation the old
      // short-page check caused.
      if (!token || token === seenToken) break;
      seenToken = token;
    }
    return dedupeBy(out, (r) => r.id);
  }

  /** GET /v1/batches */
  private async listBatches(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    let token: string | undefined;
    let seenToken: string | undefined;

    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: "100" });
      if (token) qs.set("pagination_token", token);
      const data = await this.fetch<{ batches?: XaiBatch[]; pagination_token?: string | null }>(
        `/v1/batches?${qs.toString()}`,
      );
      for (const b of data.batches ?? []) {
        out.push(this.mapBatch(accountId, now, b));
      }
      token = data.pagination_token ?? undefined;
      // A repeated cursor means the server is not advancing. Without this the
      // loop re-fetches the same page until the iteration cap and emits
      // duplicate resource ids, which is worse than the truncation the old
      // short-page check caused.
      if (!token || token === seenToken) break;
      seenToken = token;
    }
    return dedupeBy(out, (r) => r.id);
  }

  private mapBatch(accountId: string, now: string, b: XaiBatch): ResourceInstance {
    const state = b.state ?? {};
    return {
      id: `${accountId}:batch:${b.batch_id}`,
      pluginId: "xai",
      resourceTypeId: "batch",
      accountId,
      displayName: b.name || b.batch_id,
      externalId: b.batch_id,
      fields: {
        batchId: b.batch_id,
        name: b.name ?? "",
        createTime: b.create_time ?? "",
        expireTime: b.expire_time ?? "",
        cancelTime: b.cancel_time ?? "",
        cancelMessage: b.cancel_by_xai_message ?? "",
        createApiKeyId: b.create_api_key_id ?? "",
        numRequests: state.num_requests ?? 0,
        numPending: state.num_pending ?? 0,
        numSuccess: state.num_success ?? 0,
        numError: state.num_error ?? 0,
        numCancelled: state.num_cancelled ?? 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Built-in voices (GET /v1/tts/voices) plus cloned ones (GET /v1/custom-voices). */
  private async listVoices(accountId: string): Promise<ResourceInstance[]> {
    const [builtIn, custom] = await Promise.all([
      this.fetchBuiltInVoices(),
      this.fetchCustomVoices(),
    ]);
    const now = new Date().toISOString();

    const rows: ResourceInstance[] = builtIn.map((v) => ({
      id: `${accountId}:custom-voice:${v.voice_id}`,
      pluginId: "xai",
      resourceTypeId: "custom-voice",
      accountId,
      displayName: v.name || v.voice_id,
      externalId: v.voice_id,
      fields: {
        voiceId: v.voice_id,
        name: v.name ?? "",
        builtIn: true,
        description: "",
        gender: "",
        accent: "",
        age: "",
        language: v.language ?? "",
        useCase: "",
        tone: "",
        createdAt: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    }));

    for (const v of custom) {
      rows.push({
        id: `${accountId}:custom-voice:${v.voice_id}`,
        pluginId: "xai",
        resourceTypeId: "custom-voice",
        accountId,
        displayName: v.name || v.voice_id,
        externalId: v.voice_id,
        fields: {
          voiceId: v.voice_id,
          name: v.name ?? "",
          builtIn: false,
          description: v.description ?? "",
          gender: v.gender ?? "",
          accent: v.accent ?? "",
          age: v.age ?? "",
          language: v.language ?? "",
          useCase: v.use_case ?? "",
          tone: v.tone ?? "",
          createdAt: v.created_at ?? "",
        },
        resolvedOutputs: {},
        secretStates: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    return rows;
  }

  /** GET /v1/tts/voices */
  private async fetchBuiltInVoices(): Promise<XaiVoice[]> {
    try {
      const data = await this.fetch<{ voices?: XaiVoice[] }>("/v1/tts/voices");
      const voices = data.voices ?? [];
      return voices.length > 0 ? voices : FALLBACK_BUILTIN_VOICES;
    } catch {
      return FALLBACK_BUILTIN_VOICES;
    }
  }

  /** GET /v1/custom-voices: `limit` 1–1000, page with `pagination_token`. */
  private async fetchCustomVoices(): Promise<XaiCustomVoice[]> {
    const out: XaiCustomVoice[] = [];
    let token: string | undefined;
    let seenToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ limit: "1000" });
      if (token) qs.set("pagination_token", token);
      const data = await this.fetch<{
        voices?: XaiCustomVoice[];
        pagination_token?: string | null;
      }>(`/v1/custom-voices?${qs.toString()}`);
      out.push(...(data.voices ?? []));
      token = data.pagination_token ?? undefined;
      // A repeated cursor means the server is not advancing. Without this the
      // loop re-fetches the same page until the iteration cap and emits
      // duplicate resource ids, which is worse than the truncation the old
      // short-page check caused.
      if (!token || token === seenToken) break;
      seenToken = token;
    }
    return dedupeBy(out, (r) => r.voice_id);
  }

  /** GET /auth/teams/{teamId}/api-keys (management key) */
  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const teamId = await this.getTeamId();
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    let token: string | undefined;
    let seenToken: string | undefined;

    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ pageSize: "100" });
      if (token) qs.set("paginationToken", token);
      const data = await this.mgmtFetch<{
        apiKeys?: XaiManagedApiKey[];
        paginationToken?: string | null;
      }>(`/auth/teams/${encodeURIComponent(teamId)}/api-keys?${qs.toString()}`);
      for (const k of data.apiKeys ?? []) out.push(this.mapApiKey(accountId, now, k));
      token = data.paginationToken ?? undefined;
      // A repeated cursor means the server is not advancing. Without this the
      // loop re-fetches the same page until the iteration cap and emits
      // duplicate resource ids, which is worse than the truncation the old
      // short-page check caused.
      if (!token || token === seenToken) break;
      seenToken = token;
    }
    return dedupeBy(out, (r) => r.id);
  }

  private mapApiKey(accountId: string, now: string, k: XaiManagedApiKey): ResourceInstance {
    const id = k.apiKeyId ?? "";
    const acls = k.aclStrings ?? k.acl_strings ?? [];
    return {
      id: `${accountId}:api-key:${id}`,
      pluginId: "xai",
      resourceTypeId: "api-key",
      accountId,
      displayName: k.name || k.redactedApiKey || id,
      externalId: id,
      fields: {
        apiKeyId: id,
        name: k.name ?? "",
        redactedApiKey: k.redactedApiKey ?? "",
        disabled: k.disabled === true || k.disabled === "true",
        acls: acls.join(", "),
        qps: k.qps ?? 0,
        qpm: k.qpm ?? 0,
        tpm: k.tpm ?? "",
        expireTime: k.expireTime ?? "",
        createTime: k.createTime ?? "",
        modifyTime: k.modifyTime ?? "",
        userId: k.userId ?? "",
        teamId: k.teamId ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * GET /audit/teams/{teamId}/events (management key). Pages with `pageToken`
   * against the response's `nextPageToken`.
   * Docs: https://docs.x.ai/developers/management-api-guide
   */
  private async listAuditEvents(accountId: string): Promise<ResourceInstance[]> {
    const teamId = await this.getTeamId();
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    let token: string | undefined;
    let seenToken: string | undefined;

    for (let page = 0; page < AUDIT_MAX_PAGES; page++) {
      const qs = new URLSearchParams({
        pageSize: String(AUDIT_PAGE_SIZE),
        orderBy: "TIME_DESCENDING",
      });
      if (token) qs.set("pageToken", token);
      const data = await this.mgmtFetch<{ events?: XaiAuditEvent[]; nextPageToken?: string }>(
        `/audit/teams/${encodeURIComponent(teamId)}/events?${qs.toString()}`,
      );
      for (const e of data.events ?? []) out.push(this.mapAuditEvent(accountId, now, e));
      token = data.nextPageToken || undefined;
      // A repeated cursor means the server is not advancing. Without this the
      // loop re-fetches the same page until the iteration cap and emits
      // duplicate resource ids, which is worse than the truncation the old
      // short-page check caused.
      if (!token || token === seenToken) break;
      seenToken = token;
    }

    // A token left over means the cap stopped the walk. The log is newest-first,
    // so what is missing is the oldest history: say so in the list instead of
    // ending it as if that were all there ever was.
    if (token) out.push(this.auditTruncationMarker(accountId, now, out.length));
    return dedupeBy(out, (r) => r.id);
  }

  private mapAuditEvent(accountId: string, now: string, e: XaiAuditEvent): ResourceInstance {
    const id = e.eventId ?? "";
    const name = [e.user?.givenName, e.user?.familyName].filter(Boolean).join(" ");
    return {
      id: `${accountId}:audit-event:${id}`,
      pluginId: "xai",
      resourceTypeId: "audit-event",
      accountId,
      displayName: e.description || id,
      externalId: id,
      fields: {
        eventId: id,
        eventTime: e.eventTime ?? "",
        description: e.description ?? "",
        userId: e.user?.userId ?? "",
        userEmail: e.user?.email ?? "",
        userName: name,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Tail row telling the user the audit log is longer than what was synced. */
  private auditTruncationMarker(accountId: string, now: string, fetched: number): ResourceInstance {
    const note = `Older events not shown — this team's audit log has more than the ${fetched.toLocaleString()} most recent events synced here.`;
    return {
      id: `${accountId}:audit-event:${AUDIT_TRUNCATED_ID}`,
      pluginId: "xai",
      resourceTypeId: "audit-event",
      accountId,
      displayName: note,
      externalId: AUDIT_TRUNCATED_ID,
      fields: {
        eventId: "",
        eventTime: "",
        description: note,
        userId: "",
        userEmail: "",
        userName: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * GET /v1/skills: OpenAI-style cursor paging (`after` = previous page's
   * `last_id`, stop on `has_more: false`).
   * Docs: https://docs.x.ai/openapi.json
   */
  private async listSkills(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    let after: string | undefined;

    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: "100", order: "desc" });
      if (after) qs.set("after", after);
      const data = await this.fetch<{
        data?: XaiSkill[];
        has_more?: boolean;
        last_id?: string;
      }>(`/v1/skills?${qs.toString()}`);
      for (const skill of data.data ?? []) {
        out.push({
          id: `${accountId}:skill:${skill.id}`,
          pluginId: "xai",
          resourceTypeId: "skill",
          accountId,
          displayName: skill.name || skill.id,
          externalId: skill.id,
          fields: {
            skillId: skill.id,
            name: skill.name ?? "",
            description: skill.description ?? "",
            defaultVersion: skill.default_version ?? "",
            latestVersion: skill.latest_version ?? "",
            createdAt: formatEpochSeconds(skill.created_at),
          },
          resolvedOutputs: {},
          secretStates: [],
          createdAt: formatEpochSeconds(skill.created_at) || now,
          updatedAt: now,
        });
      }
      const next = data.last_id;
      if (!data.has_more || !next || next === after) break;
      after = next;
    }
    return dedupeBy(out, (r) => r.id);
  }

  /**
   * GET /v1/collections on the management host: `limit` maxes out at 100,
   * page with `pagination_token`. The team is derived from the management key.
   * Docs: https://docs.x.ai/developers/rest-api-reference/collections/collection
   */
  private async fetchCollections(): Promise<XaiCollection[]> {
    const out: XaiCollection[] = [];
    let token: string | undefined;
    let seenToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: "100" });
      if (token) qs.set("pagination_token", token);
      const data = await this.mgmtFetch<{
        collections?: XaiCollection[];
        pagination_token?: string | null;
      }>(`/v1/collections?${qs.toString()}`);
      out.push(...(data.collections ?? []).filter((c) => Boolean(c.collection_id)));
      token = data.pagination_token || undefined;
      if (!token || token === seenToken) break;
      seenToken = token;
    }
    return dedupeBy(out, (c) => c.collection_id);
  }

  private async listCollections(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    return (await this.fetchCollections()).map((c) => mapCollection(accountId, now, c));
  }

  /** GET /v1/collections/{collection_id}/documents, paged like the collection list. */
  private async fetchCollectionDocuments(collectionId: string): Promise<XaiCollectionDocument[]> {
    const out: XaiCollectionDocument[] = [];
    let token: string | undefined;
    let seenToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: "100" });
      if (token) qs.set("pagination_token", token);
      const data = await this.mgmtFetch<{
        documents?: XaiCollectionDocument[];
        pagination_token?: string | null;
      }>(`/v1/collections/${encodeURIComponent(collectionId)}/documents?${qs.toString()}`);
      out.push(...(data.documents ?? []));
      token = data.pagination_token || undefined;
      if (!token || token === seenToken) break;
      seenToken = token;
    }
    return out;
  }

  /**
   * Every document in every collection. There is no cross-collection listing,
   * so this walks the collections, skipping any whose `documents_count` says
   * it is empty.
   */
  private async listCollectionDocuments(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    for (const c of await this.fetchCollections()) {
      if (c.documents_count === 0) continue;
      const collection = { id: c.collection_id, name: c.collection_name ?? "" };
      for (const doc of await this.fetchCollectionDocuments(c.collection_id)) {
        const mapped = mapCollectionDocument(accountId, now, collection, doc);
        if (mapped) out.push(mapped);
      }
    }
    return dedupeBy(out, (r) => r.id);
  }

  /**
   * GET /v1/billing/teams/{team_id}/invoices, from {@link INVOICE_HISTORY_MONTHS}
   * back. The `since.*` filter is the documented way to bound the list; the
   * endpoint has no pagination.
   * Docs: https://docs.x.ai/developers/rest-api-reference/management/billing
   */
  private async listInvoices(accountId: string): Promise<ResourceInstance[]> {
    const teamId = await this.getTeamId();
    const since = new Date();
    since.setUTCDate(1);
    since.setUTCMonth(since.getUTCMonth() - INVOICE_HISTORY_MONTHS);
    const qs = new URLSearchParams({
      "since.year": String(since.getUTCFullYear()),
      "since.month": String(since.getUTCMonth() + 1),
    });
    const data = await this.mgmtFetch<{ invoices?: XaiInvoice[] }>(
      `/v1/billing/teams/${encodeURIComponent(teamId)}/invoices?${qs.toString()}`,
    );
    const now = new Date().toISOString();
    return (data.invoices ?? [])
      .filter((inv) => Boolean(inv.invoiceId))
      .map((inv) => mapInvoice(accountId, now, inv))
      .sort((a, b) => String(b.fields["createTime"]).localeCompare(String(a.fields["createTime"])));
  }

  /**
   * The spending limit plus this period's invoice preview, as one row.
   * GET .../postpaid/spending-limits and GET .../postpaid/invoice/preview.
   * The preview is context, so a failure there still yields the limit.
   */
  private async listSpendingLimit(accountId: string): Promise<ResourceInstance[]> {
    const teamId = encodeURIComponent(await this.getTeamId());
    const [limits, preview] = await Promise.all([
      this.mgmtFetch<{ spendingLimits?: XaiSpendingLimits }>(
        `/v1/billing/teams/${teamId}/postpaid/spending-limits`,
      ),
      this.mgmtFetch<XaiInvoicePreview>(
        `/v1/billing/teams/${teamId}/postpaid/invoice/preview`,
      ).catch(() => undefined),
    ]);
    return [
      mapSpendingLimit(accountId, new Date().toISOString(), limits.spendingLimits ?? {}, preview),
    ];
  }

  /**
   * Remaining prepaid credit, for the host's credit tracking. Read from the
   * current period's invoice preview; see `prepaidBalances` for why not the
   * prepaid ledger.
   */
  async fetchCreditBalance(): Promise<CreditBalance[]> {
    if (!this.managementKey) {
      throw new CreditAccessError(
        "xAI reports prepaid credit only through its Management API. Add a management key to this account to track the balance.",
        MANAGEMENT_KEY_HELP,
      );
    }
    const teamId = encodeURIComponent(await this.getTeamId());
    const preview = await this.mgmtFetch<XaiInvoicePreview>(
      `/v1/billing/teams/${teamId}/postpaid/invoice/preview`,
    );
    return prepaidBalances(preview);
  }

  /** GET /v1/batches/{batch_id}/requests: first page only, for the detail view. */
  private async fetchBatchRequests(batchId: string): Promise<XaiBatchRequestMeta[]> {
    const data = await this.fetch<{ batch_request_metadata?: XaiBatchRequestMeta[] }>(
      `/v1/batches/${encodeURIComponent(batchId)}/requests?limit=${BATCH_REQUESTS_PREVIEW}`,
    );
    return data.batch_request_metadata ?? [];
  }

  // ------------------------------------------------------------------- get

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`xAI plugin: resource ${typeId}/${resourceId} not found`);

    // `renderDetail` is synchronous, so the Speech tab's voice picker has to be
    // filled here and stashed on the instance. Follows the Cloudflare queue
    // plugin's `__consumers__` precedent.
    if (typeId === "custom-voice" || (typeId === "model" && isAudioModel(found))) {
      try {
        const voices = await this.speechVoiceOptions();
        found.resolvedOutputs = { ...found.resolvedOutputs, __voices__: JSON.stringify(voices) };
      } catch {
        // Leave the panel to fall back to the documented built-in voices.
      }
    }
    if (typeId === "batch") {
      try {
        const requests = await this.fetchBatchRequests(found.externalId ?? "");
        found.resolvedOutputs = {
          ...found.resolvedOutputs,
          __requests__: JSON.stringify(requests),
        };
      } catch {
        // The counters on the row still tell the story without the per-request list.
      }
    }
    return found;
  }

  private async speechVoiceOptions(): Promise<SpeechPanelOption[]> {
    const [builtIn, custom] = await Promise.all([
      this.fetchBuiltInVoices(),
      this.fetchCustomVoices().catch(() => [] as XaiCustomVoice[]),
    ]);
    const options: SpeechPanelOption[] = builtIn.map((v) => ({
      id: v.voice_id,
      label: v.name || v.voice_id,
      description: v.language ? `Built-in · ${v.language}` : "Built-in",
    }));
    for (const v of custom) {
      const bits = [v.gender, v.accent, v.tone, v.language].filter(Boolean).join(" · ");
      options.push({
        id: v.voice_id,
        label: v.name || v.voice_id,
        description: bits ? `Custom · ${bits}` : "Custom",
      });
    }
    return options;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const direct = resource.fields[outputKey];
    if (direct !== undefined) return String(direct);
    throw new Error(`xAI plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ------------------------------------------------------------- dashboard

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    if (resourceTypeId === "model") {
      return [
        { label: "Kind", value: String(f["kind"] ?? "") },
        { label: "Owner", value: String(f["ownedBy"] ?? "") },
        { label: "Input", value: String(f["prompt"] ?? f["inputModalities"] ?? "") },
      ];
    }
    if (resourceTypeId === "batch") {
      const errored = Number(f["numError"] ?? 0);
      return [
        { label: "Requests", value: String(f["numRequests"] ?? 0) },
        { label: "Succeeded", value: String(f["numSuccess"] ?? 0) },
        {
          label: "Errored",
          value: String(errored),
          variant: errored > 0 ? "status-error" : "default",
        },
      ];
    }
    if (resourceTypeId === "custom-voice") {
      return [
        { label: "Voice ID", value: String(f["voiceId"] ?? "") },
        { label: "Source", value: f["builtIn"] === true ? "Built-in" : "Custom" },
      ];
    }
    if (resourceTypeId === "collection") {
      return [
        { label: "Documents", value: Number(f["documentsCount"] ?? 0).toLocaleString("en-US") },
        { label: "Embedding", value: String(f["embeddingModel"] || "default") },
      ];
    }
    if (resourceTypeId === "collection-document") {
      const status = String(f["status"] ?? "");
      const dot = documentStatusDot(status);
      return [
        {
          label: "Status",
          value: status.replace(/^DOCUMENT_STATUS_/, "").toLowerCase() || "unknown",
          variant:
            dot === "healthy" ? "status-healthy" : dot === "error" ? "status-error" : "default",
        },
        { label: "Collection", value: String(f["collectionName"] || f["collectionId"] || "") },
      ];
    }
    if (resourceTypeId === "invoice") {
      const status = String(f["status"] ?? "");
      const dot = invoiceStatusDot(status);
      return [
        { label: "Total", value: formatUsd(Number(f["total"] ?? 0)) },
        {
          label: "Status",
          value: status || "unknown",
          variant:
            dot === "healthy"
              ? "status-healthy"
              : dot === "error"
                ? "status-error"
                : dot === "degraded"
                  ? "status-degraded"
                  : "default",
        },
      ];
    }
    if (resourceTypeId === "spending-limit") {
      const spend = Number(f["currentSpend"] ?? 0);
      const limit = Number(f["effectiveLimit"] ?? 0) || Number(f["softLimit"] ?? 0);
      return [
        { label: "This period", value: formatUsd(spend) },
        {
          label: "Limit",
          value: formatUsd(limit),
          variant: limit > 0 && spend >= limit * 0.9 ? "status-degraded" : "default",
        },
        {
          label: "Prepaid left",
          value: formatUsd(
            Math.max(0, Number(f["prepaidCredits"] ?? 0) - Number(f["prepaidCreditsUsed"] ?? 0)),
          ),
        },
      ];
    }
    if (resourceTypeId === "skill") {
      return [{ label: "Version", value: String(f["latestVersion"] || "1") }];
    }
    if (resourceTypeId === "api-key") {
      const disabled = f["disabled"] === true;
      return [
        { label: "Key", value: String(f["redactedApiKey"] ?? "") },
        {
          label: "Status",
          value: disabled ? "disabled" : "active",
          variant: disabled ? "status-degraded" : "status-healthy",
        },
      ];
    }
    return [];
  }

  // ----------------------------------------------------------- usage/costs

  /**
   * POST /v1/billing/teams/{team_id}/usage: a real analytics query, so the
   * plugin asks for a daily `usd` sum grouped by line-item description and
   * turns each series into per-day CostRows.
   *
   * Docs: https://docs.x.ai/developers/rest-api-reference/management/billing
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (!this.managementKey) {
      throw new CostSetupError(
        "xAI billing needs a management key. Add one to this account to collect usage and spend.",
        { label: "Create a management key", url: "https://console.x.ai/team/default/settings" },
      );
    }
    const series = await this.queryUsage(range.fromDate, range.toDate, "TIME_UNIT_DAY");
    const rows: CostRow[] = [];
    for (const s of series.timeSeries ?? []) {
      const service = s.groupLabels?.[0] ?? s.group?.[0] ?? "xAI API";
      for (const point of s.dataPoints ?? []) {
        const amount = point.values?.[0];
        if (!point.timestamp || amount === undefined) continue;
        const date = point.timestamp.slice(0, 10);
        if (date < range.fromDate || date > range.toDate) continue;
        rows.push({ date, service, currency: "USD", amount });
      }
    }
    return rows;
  }

  private async queryUsage(
    fromDate: string,
    toDate: string,
    timeUnit: string,
  ): Promise<XaiUsageResponse> {
    // `endTime` is exclusive, so push it to the start of the next day.
    return this.queryUsageBetween(`${fromDate} 00:00:00`, `${nextDay(toDate)} 00:00:00`, timeUnit);
  }

  private async queryUsageBetween(
    startTime: string,
    endTime: string,
    timeUnit: string,
  ): Promise<XaiUsageResponse> {
    const teamId = await this.getTeamId();
    return this.mgmtFetch<XaiUsageResponse>(
      `/v1/billing/teams/${encodeURIComponent(teamId)}/usage`,
      {
        method: "POST",
        body: JSON.stringify({
          analyticsRequest: {
            timeRange: { startTime, endTime, timezone: "Etc/GMT" },
            timeUnit,
            values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
            groupBy: ["description"],
            filters: [],
          },
        }),
      },
    );
  }

  /**
   * The billing analytics query over a chart window. Windows of up to two
   * days are bucketed by hour (`TIME_UNIT_HOUR`, documented alongside
   * `TIME_UNIT_DAY`), longer ones by day, with the bounds widened to whole
   * buckets so the first and last points are not partial.
   */
  private async queryUsageWindow(startMs: number, endMs: number): Promise<XaiUsageResponse> {
    const hourly = endMs - startMs <= 2 * DAY_MS;
    const bucket = hourly ? HOUR_MS : DAY_MS;
    const from = Math.floor(startMs / bucket) * bucket;
    const to = Math.max(Math.ceil(endMs / bucket) * bucket, from + bucket);
    return this.queryUsageBetween(
      usageTimestamp(from),
      usageTimestamp(to),
      hourly ? "TIME_UNIT_HOUR" : "TIME_UNIT_DAY",
    );
  }

  /**
   * Spend charts off the same billing analytics query (`usd` summed per
   * line-item `description`, the only value and group-by xAI documents):
   *
   *   - **model**: the model's own spend. The `description` group labels look
   *     like "Chat grok-4-0709", so the series are matched on the model id
   *     rather than by using an undocumented filter syntax.
   *   - **spending-limit**: the whole team's spend, plus the line items that
   *     cost the most over the window, so the trend sits next to the limit.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "model" && resourceTypeId !== "spending-limit") return [];
    if (!this.managementKey) return [];
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 30 * DAY_MS;
    const usage = await this.queryUsageWindow(startMs, endMs);

    if (resourceTypeId === "spending-limit") return teamSpendSeries(usage);

    const modelId = resourceId.split(":").slice(2).join(":");
    const points: Array<{ timestamp: number; value: number }> = [];
    for (const s of usage.timeSeries ?? []) {
      const label = s.groupLabels?.[0] ?? s.group?.[0] ?? "";
      if (modelId && !label.includes(modelId)) continue;
      for (const p of s.dataPoints ?? []) {
        if (!p.timestamp) continue;
        const ts = Date.parse(p.timestamp);
        if (Number.isNaN(ts)) continue;
        const existing = points.find((x) => x.timestamp === ts);
        const value = p.values?.[0] ?? 0;
        if (existing) existing.value += value;
        else points.push({ timestamp: ts, value });
      }
    }
    if (points.length === 0) return [];
    points.sort((a, b) => a.timestamp - b.timestamp);
    return [{ label: `${modelId} spend`, unit: "USD", points }];
  }

  // ------------------------------------------------------------ create/edit

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "api-key") {
      const models = await this.listModelAclOptions();
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "modelAcl",
            label: "Models",
            kind: "select",
            required: true,
            options: [{ id: "*", label: "All models" }, ...models],
            defaultValue: "*",
            description: "Which models this key may call.",
          },
          {
            key: "endpointAcl",
            label: "Endpoints",
            kind: "select",
            required: true,
            options: [
              { id: "*", label: "All endpoints" },
              { id: "chat", label: "Chat & vision" },
              { id: "image", label: "Image generation" },
            ],
            defaultValue: "*",
          },
          {
            key: "qps",
            label: "Queries per second",
            kind: "number",
            required: false,
            description: "Leave blank for no per-second limit.",
          },
          {
            key: "qpm",
            label: "Queries per minute",
            kind: "number",
            required: false,
            description: "Leave blank for no per-minute limit.",
          },
          {
            key: "tpm",
            label: "Tokens per minute",
            kind: "number",
            required: false,
            description: "Leave blank for no token limit.",
          },
        ],
      };
    }
    if (typeId === "batch") {
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description:
              "Creates an empty batch. Add requests to it from your code with POST /v1/batches/{batch_id}/requests.",
          },
        ],
      };
    }
    if (typeId === "collection") {
      const models = await this.listEmbeddingModelOptions();
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "embeddingModel",
            label: "Embedding model",
            kind: "select",
            required: false,
            options: [{ id: "", label: "xAI default" }, ...models],
            defaultValue: "",
            description: "Fixed once the collection exists.",
          },
          {
            key: "maxChunkTokens",
            label: "Max chunk size (tokens)",
            kind: "number",
            required: false,
            minValue: 1,
            description: "Leave blank for xAI's default chunking.",
          },
          {
            key: "chunkOverlapTokens",
            label: "Chunk overlap (tokens)",
            kind: "number",
            required: false,
            minValue: 0,
            description: "Only used when a max chunk size is set.",
          },
        ],
      };
    }
    if (typeId === "collection-document") {
      const [collections, files] = await Promise.all([
        this.fetchCollections().catch(() => [] as XaiCollection[]),
        this.listFiles("picker").catch(() => [] as ResourceInstance[]),
      ]);
      return {
        fields: [
          {
            key: "collectionId",
            label: "Collection",
            kind: "select",
            required: true,
            options: collections.map((c) => ({
              id: c.collection_id,
              label: c.collection_name || c.collection_id,
              description: `${(c.documents_count ?? 0).toLocaleString("en-US")} documents`,
            })),
          },
          {
            key: "fileId",
            label: "File",
            kind: "select",
            required: true,
            options: files.map((f) => ({
              id: String(f.fields["fileId"]),
              label: f.displayName,
              description: String(f.fields["createdAt"] || ""),
            })),
            description: "An uploaded xAI file. It is indexed into the collection, not copied.",
          },
        ],
      };
    }
    throw new Error(`xAI plugin: no create config for type "${typeId}"`);
  }

  private async listEmbeddingModelOptions(): Promise<Array<{ id: string; label: string }>> {
    try {
      const data = await this.fetch<{ models?: XaiEmbeddingModel[] }>("/v1/embedding-models");
      return (data.models ?? []).map((m) => ({ id: m.id, label: m.id }));
    } catch {
      return [];
    }
  }

  private async listModelAclOptions(): Promise<Array<{ id: string; label: string }>> {
    try {
      const data = await this.fetch<{ models?: XaiLanguageModel[] }>("/v1/language-models");
      return (data.models ?? []).map((m) => ({ id: m.id, label: m.id }));
    } catch {
      return [];
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "api-key":
        return this.createApiKey(accountId, fields);
      case "batch":
        return this.createBatch(accountId, fields);
      case "collection":
        return this.createCollection(accountId, fields);
      case "collection-document":
        return this.createCollectionDocument(accountId, fields);
      default:
        throw new Error(`xAI plugin: cannot create type "${typeId}"`);
    }
  }

  /** POST /v1/batches: the API takes only a name. */
  private async createBatch(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]?.trim();
    if (!name) throw new Error("xAI plugin: missing batch name");
    const created = await this.fetch<XaiBatch>("/v1/batches", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    return this.mapBatch(accountId, new Date().toISOString(), created);
  }

  /** POST /v1/collections on the management host. */
  private async createCollection(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = fields["name"]?.trim();
    if (!name) throw new Error("xAI plugin: missing collection name");
    const body: Record<string, unknown> = { collection_name: name };
    if (fields["description"]) body["collection_description"] = fields["description"];
    if (fields["embeddingModel"]) {
      body["index_configuration"] = { model_name: fields["embeddingModel"] };
    }
    const maxTokens = Number(fields["maxChunkTokens"]);
    if (Number.isFinite(maxTokens) && maxTokens > 0) {
      const overlap = Number(fields["chunkOverlapTokens"]);
      body["chunk_configuration"] = {
        tokens_configuration: {
          max_chunk_size_tokens: maxTokens,
          ...(Number.isFinite(overlap) && overlap > 0 ? { chunk_overlap_tokens: overlap } : {}),
        },
      };
    }
    const created = await this.mgmtFetch<XaiCollection>("/v1/collections", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return mapCollection(accountId, new Date().toISOString(), created);
  }

  /** POST /v1/collections/{collection_id}/documents/{file_id}: returns `{}`. */
  private async createCollectionDocument(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const collectionId = fields["collectionId"];
    const fileId = fields["fileId"];
    if (!collectionId || !fileId) {
      throw new Error("xAI plugin: pick both a collection and a file");
    }
    const path = `/v1/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(fileId)}`;
    await this.mgmtFetch<unknown>(path, { method: "POST", body: JSON.stringify({}) });
    const doc = await this.mgmtFetch<XaiCollectionDocument>(path);
    const collection = await this.mgmtFetch<XaiCollection>(
      `/v1/collections/${encodeURIComponent(collectionId)}`,
    ).catch(() => undefined);
    const mapped = mapCollectionDocument(
      accountId,
      new Date().toISOString(),
      { id: collectionId, name: collection?.collection_name ?? "" },
      {
        ...doc,
        file_metadata: { ...doc.file_metadata, file_id: doc.file_metadata?.file_id || fileId },
      },
    );
    if (!mapped) throw new Error("xAI plugin: the attached document could not be read back");
    return mapped;
  }

  /** POST /auth/teams/{teamId}/api-keys */
  private async createApiKey(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const teamId = await this.getTeamId();
    const name = fields["name"];
    if (!name) throw new Error("xAI plugin: missing API key name");

    const body: Record<string, unknown> = {
      name,
      acls: [
        `api-key:model:${fields["modelAcl"] || "*"}`,
        `api-key:endpoint:${fields["endpointAcl"] || "*"}`,
      ],
    };
    if (fields["qps"]) body["qps"] = Number(fields["qps"]);
    if (fields["qpm"]) body["qpm"] = Number(fields["qpm"]);
    if (fields["tpm"]) body["tpm"] = String(fields["tpm"]);

    const created = await this.mgmtFetch<XaiManagedApiKey>(
      `/auth/teams/${encodeURIComponent(teamId)}/api-keys`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const resource = this.mapApiKey(accountId, new Date().toISOString(), created);
    // The plaintext key only ever appears in this one response.
    if (created.apiKey) resource.resolvedOutputs = { apiKey: created.apiKey };
    return resource;
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");

    if (typeId === "api-key") {
      // PUT /auth/api-keys/{api_key_id} takes { apiKey: {...}, fieldMask }.
      const apiKey: Record<string, unknown> = {};
      const mask: string[] = [];
      if (fields["name"] !== undefined) {
        apiKey["name"] = fields["name"];
        mask.push("name");
      }
      if (fields["disabled"] !== undefined) {
        apiKey["disabled"] = fields["disabled"] === "true";
        mask.push("disabled");
      }
      if (fields["qps"] !== undefined) {
        apiKey["qps"] = Number(fields["qps"]);
        mask.push("qps");
      }
      if (fields["qpm"] !== undefined) {
        apiKey["qpm"] = Number(fields["qpm"]);
        mask.push("qpm");
      }
      if (fields["tpm"] !== undefined) {
        apiKey["tpm"] = String(fields["tpm"]);
        mask.push("tpm");
      }
      if (fields["acls"] !== undefined) {
        apiKey["aclStrings"] = fields["acls"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        mask.push("acl_strings");
      }
      if (mask.length === 0) return this.getResource(typeId, resourceId, accountId);

      const updated = await this.mgmtFetch<XaiManagedApiKey>(
        `/auth/api-keys/${encodeURIComponent(externalId)}`,
        { method: "PUT", body: JSON.stringify({ apiKey, fieldMask: mask.join(",") }) },
      );
      return this.mapApiKey(accountId, new Date().toISOString(), updated);
    }

    if (typeId === "custom-voice") {
      // PATCH /v1/custom-voices/{voice_id}: built-in voices have no metadata.
      const body: Record<string, unknown> = {};
      for (const key of ["name", "description", "gender", "accent", "age", "language", "tone"]) {
        if (fields[key] !== undefined) body[key] = fields[key];
      }
      if (fields["useCase"] !== undefined) body["use_case"] = fields["useCase"];
      if (Object.keys(body).length === 0) return this.getResource(typeId, resourceId, accountId);
      await this.fetch<XaiCustomVoice>(`/v1/custom-voices/${encodeURIComponent(externalId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "collection") {
      // PUT /v1/collections/{collection_id}: only name and description are
      // changed here; chunking is fixed once documents are embedded.
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined && fields["name"].trim()) {
        body["collection_name"] = fields["name"].trim();
      }
      if (fields["description"] !== undefined)
        body["collection_description"] = fields["description"];
      if (Object.keys(body).length === 0) return this.getResource(typeId, resourceId, accountId);
      const updated = await this.mgmtFetch<XaiCollection>(
        `/v1/collections/${encodeURIComponent(externalId)}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return mapCollection(accountId, new Date().toISOString(), updated);
    }

    if (typeId === "spending-limit") {
      // POST .../postpaid/spending-limits takes the soft limit in USD cents.
      const raw = fields["softLimit"];
      if (raw === undefined) return this.getResource(typeId, resourceId, accountId);
      const dollars = Number(raw);
      if (!Number.isFinite(dollars) || dollars < 0) {
        throw new Error("xAI plugin: the spending limit must be a non-negative dollar amount");
      }
      const teamId = encodeURIComponent(await this.getTeamId());
      await this.mgmtFetch<unknown>(`/v1/billing/teams/${teamId}/postpaid/spending-limits`, {
        method: "POST",
        body: JSON.stringify({
          desiredSoftSpendingLimit: { val: String(Math.round(dollars * 100)) },
        }),
      });
      return this.getResource(typeId, resourceId, accountId);
    }

    throw new Error(`xAI plugin: cannot update type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "api-key") {
      await this.mgmtFetch(`/auth/api-keys/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "file") {
      await this.fetch(`/v1/files/${encodeURIComponent(externalId)}`, { method: "DELETE" });
      return;
    }
    if (typeId === "custom-voice") {
      await this.fetch(`/v1/custom-voices/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "skill") {
      const result = await this.fetch<{ deleted?: boolean }>(
        `/v1/skills/${encodeURIComponent(externalId)}`,
        { method: "DELETE" },
      );
      if (result.deleted === false)
        throw new Error(`xAI plugin: skill ${externalId} was not deleted`);
      return;
    }
    if (typeId === "collection") {
      await this.mgmtFetch(`/v1/collections/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "collection-document") {
      // Removes the document from the collection; the underlying file stays.
      const { collectionId, fileId } = splitDocumentId(externalId);
      await this.mgmtFetch(
        `/v1/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(fileId)}`,
        { method: "DELETE" },
      );
      return;
    }
    throw new Error(`xAI plugin: cannot delete type "${typeId}"`);
  }

  /**
   * Plugin actions:
   *   - api-key `rotate`: POST /auth/api-keys/{apiKeyId}/rotate mints a new
   *     secret and starts the clock on the old one (24 h by default).
   *   - batch `cancel`: POST /v1/batches/{batch_id}:cancel (colon verb).
   *   - file `create-public-url` / `revoke-public-url`: POST
   *     /v1/files/{file_id}/public-url[/revoke]. Creation inherits the file's
   *     own expiry, or none; revoke is idempotent.
   *   - collection-document `reindex`: PATCH .../documents/{file_id}.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "api-key" && actionId === "rotate") {
      await this.mgmtFetch(`/auth/api-keys/${encodeURIComponent(externalId)}/rotate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return;
    }
    if (typeId === "batch" && actionId === "cancel") {
      await this.fetch(`/v1/batches/${encodeURIComponent(externalId)}:cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return;
    }
    if (typeId === "file" && actionId === "create-public-url") {
      await this.fetch(`/v1/files/${encodeURIComponent(externalId)}/public-url`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return;
    }
    if (typeId === "file" && actionId === "revoke-public-url") {
      await this.fetch(`/v1/files/${encodeURIComponent(externalId)}/public-url/revoke`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return;
    }
    if (typeId === "collection-document" && actionId === "reindex") {
      const { collectionId, fileId } = splitDocumentId(externalId);
      await this.mgmtFetch(
        `/v1/collections/${encodeURIComponent(collectionId)}/documents/${encodeURIComponent(fileId)}`,
        { method: "PATCH", body: JSON.stringify({}) },
      );
      return;
    }
    throw new Error(`xAI plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  // ---------------------------------------------------------------- speech

  /**
   * POST /v1/tts. Unlike OpenAI and Groq this returns **JSON with base64 audio**
   * (`audio`, `content_type`, `duration`) rather than raw bytes, so it can go
   * straight through `jsonRestFetch` and keeps bastion routing.
   *
   * Docs: https://docs.x.ai/developers/rest-api-reference/inference/voice
   */
  async synthesizeSpeech(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    const text = payload.text.slice(0, TTS_MAX_CHARACTERS);
    const voiceId = payload.voiceId || "eve";
    const language = payload.modelId || "auto";
    const started = Date.now();

    const res = await this.fetch<XaiTtsResponse>("/v1/tts", {
      method: "POST",
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        language,
        // Ask for mp3 explicitly: a browser <audio> element has to play it.
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
      }),
    });

    const elapsed = Date.now() - started;
    const duration = res.duration ?? 0;
    const summary = [
      `${text.length.toLocaleString()} characters`,
      duration > 0 ? `${duration.toFixed(2)}s audio` : undefined,
      `voice ${voiceId}`,
      `${elapsed} ms`,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      audioBase64: res.audio,
      mimeType: res.content_type || "audio/mpeg",
      fileName: `xai-${voiceId}.mp3`,
      summary,
      characters: text.length,
    };
  }

  /**
   * POST /v1/stt, multipart. `file` must be the last field in the form, per the
   * docs. The clip's MIME type is forwarded exactly as the browser recorded it
   * (`audio/webm;codecs=opus` on Chromium, `audio/mp4` on Safari): xAI
   * auto-detects container formats from the header, so no `audio_format` hint
   * is sent and nothing is transcoded.
   *
   * Docs: https://docs.x.ai/developers/rest-api-reference/inference/speech-to-text
   */
  async transcribeAudio(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    const bytes = base64ToBytes(payload.audioBase64);
    if (bytes.byteLength > STT_MAX_AUDIO_BYTES) {
      throw new Error(
        `xAI plugin: clip is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${STT_MAX_AUDIO_BYTES / 1024 / 1024} MB limit`,
      );
    }

    const parts: MultipartPart[] = [];
    // `auto` is a TTS-only value; for STT an unset language means auto-detect.
    // `format` belongs in this branch rather than beside `diarize`: the docs
    // define it as `"true" | "false"` and require `language` to be set with it,
    // and the pair is what turns on inverse text normalisation (spoken numbers,
    // currencies and units written out). Sending it on its own does nothing.
    if (payload.language && payload.language !== "auto") {
      parts.push({ name: "language", value: payload.language });
      parts.push({ name: "format", value: "true" });
    }
    parts.push({ name: "diarize", value: "true" });
    parts.push({
      name: "file",
      value: bytes,
      filename: payload.fileName || fileNameForMime(payload.mimeType),
      contentType: payload.mimeType || "application/octet-stream",
    });

    const started = Date.now();
    const res = await this.postMultipart<XaiSttResponse>("/v1/stt", parts);
    const elapsed = Date.now() - started;

    const words: TranscriptWord[] = (res.words ?? []).map((w) => ({
      text: w.text,
      ...(w.start !== undefined ? { start: w.start } : {}),
      ...(w.end !== undefined ? { end: w.end } : {}),
      ...(w.speaker !== undefined ? { speaker: `Speaker ${w.speaker + 1}` } : {}),
    }));

    const confidences = (res.words ?? [])
      .map((w) => w.confidence)
      .filter((c): c is number => typeof c === "number");
    const confidence =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : undefined;

    const summary = [
      res.duration ? `${res.duration.toFixed(2)}s audio` : undefined,
      `${(bytes.byteLength / 1024).toFixed(0)} KB uploaded`,
      words.length > 0 ? `${words.length} words` : undefined,
      `${elapsed} ms`,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      text: res.text ?? "",
      summary,
      ...(res.language ? { language: res.language } : {}),
      ...(res.duration !== undefined ? { durationSeconds: res.duration } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(words.length > 0 ? { words } : {}),
    };
  }

  // ---------------------------------------------------------------- render

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "model":
        return this.renderModelDetail(resource);
      case "file":
        return this.renderFileDetail(resource);
      case "batch":
        return this.renderBatchDetail(resource);
      case "custom-voice":
        return this.renderVoiceDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      case "audit-event":
        return this.renderAuditEventDetail(resource);
      case "skill":
        return this.renderSkillDetail(resource);
      case "collection":
        return renderCollectionDetail(resource);
      case "collection-document":
        return renderCollectionDocumentDetail(resource);
      case "invoice":
        return renderInvoiceDetail(resource);
      case "spending-limit":
        return renderSpendingLimitDetail(resource);
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

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const kind = String(f["kind"] ?? "language");

    const priceRows: TableRow[] = [];
    const addPrice = (label: string, key: string, unit: string, scale = PRICE_PER_MILLION) => {
      const raw = Number(f[key] ?? 0);
      if (!raw) return;
      priceRows.push({
        cells: { meter: label, price: `$${(raw / scale).toFixed(4)}`, unit },
      });
    };
    addPrice("Prompt text", "promptTextTokenPrice", "per 1M tokens");
    addPrice("Cached prompt text", "cachedPromptTextTokenPrice", "per 1M tokens");
    addPrice("Completion text", "completionTextTokenPrice", "per 1M tokens");
    addPrice("Prompt text (long context)", "promptTextTokenPriceLongContext", "per 1M tokens");
    addPrice(
      "Cached prompt (long context)",
      "cachedPromptTextTokenPriceLongContext",
      "per 1M tokens",
    );
    addPrice(
      "Completion text (long context)",
      "completionTextTokenPriceLongContext",
      "per 1M tokens",
    );
    addPrice("Prompt image", "promptImageTokenPrice", "per 1M tokens");
    // Images and search sources are bought one at a time, not by the million.
    addPrice("Image", "imagePrice", "per image", PRICE_PER_UNIT);
    addPrice("Live search", "searchPrice", "per source", PRICE_PER_UNIT);
    for (const tier of parseJsonArray<{
      quality?: string;
      resolution?: string;
      price_per_image?: number;
    }>(f["imagePricingTiers"])) {
      if (!tier.price_per_image) continue;
      priceRows.push({
        cells: {
          meter: `Image (${tier.quality ?? "?"}, ${tier.resolution ?? "?"})`,
          price: `$${(tier.price_per_image / PRICE_PER_UNIT).toFixed(4)}`,
          unit: "per image",
        },
      });
    }

    const identity: KVItem[] = [
      { key: "Model ID", value: String(f["modelId"] ?? resource.displayName), copyable: true },
      { key: "Kind", value: kind },
      { key: "Owned By", value: String(f["ownedBy"] || DASH) },
      { key: "Version", value: String(f["version"] || DASH) },
      { key: "Fingerprint", value: String(f["fingerprint"] || DASH) },
      { key: "Aliases", value: String(f["aliases"] || DASH) },
      { key: "Created", value: String(f["created"] || DASH) },
    ];

    const capability: KVItem[] = [
      { key: "Input Modalities", value: String(f["inputModalities"] || DASH) },
      { key: "Output Modalities", value: String(f["outputModalities"] || DASH) },
    ];
    if (Number(f["longContextThreshold"] ?? 0) > 0) {
      capability.push({
        key: "Long-Context Threshold",
        value: `${Number(f["longContextThreshold"]).toLocaleString()} tokens`,
      });
    }
    if (f["reasoningEfforts"]) {
      capability.push({ key: "Reasoning Efforts", value: String(f["reasoningEfforts"]) });
      if (f["defaultReasoningEffort"]) {
        capability.push({
          key: "Default Reasoning Effort",
          value: String(f["defaultReasoningEffort"]),
        });
      }
    }
    if (Number(f["maxPromptLength"] ?? 0) > 0) {
      capability.push({
        key: "Max Prompt Length",
        value: `${Number(f["maxPromptLength"]).toLocaleString()} characters`,
      });
    }

    const schema: DetailViewSchema = {
      title: resource.displayName,
      subtitle: `xAI Model · ${kind}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Model",
          children: [{ kind: "key-value-list", items: identity }],
        },
        {
          kind: "section",
          title: "Capabilities",
          children: [{ kind: "key-value-list", items: capability }],
        },
        ...(priceRows.length > 0
          ? [
              {
                kind: "section" as const,
                title: "Pricing",
                children: [
                  {
                    kind: "table" as const,
                    emphasizeFirstColumn: true,
                    columns: [
                      { key: "meter", label: "Meter" },
                      { key: "price", label: "Price", mono: true },
                      { key: "unit", label: "Unit" },
                    ],
                    rows: priceRows,
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
    };

    if (isAudioModel(resource)) {
      schema.speechPanel = this.speechPanel(resource, undefined);
    }
    return schema;
  }

  private renderVoiceDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const builtIn = f["builtIn"] === true;
    const voiceId = String(f["voiceId"] ?? resource.externalId ?? "");

    const items: KVItem[] = [
      { key: "Voice ID", value: voiceId || DASH, copyable: true },
      { key: "Name", value: String(f["name"] || DASH) },
      { key: "Source", value: builtIn ? "Built-in (xAI)" : "Custom (cloned by this team)" },
      { key: "Language", value: String(f["language"] || DASH) },
    ];
    if (!builtIn) {
      items.push(
        { key: "Description", value: String(f["description"] || DASH) },
        { key: "Gender", value: String(f["gender"] || DASH) },
        { key: "Accent", value: String(f["accent"] || DASH) },
        { key: "Age", value: String(f["age"] || DASH) },
        { key: "Use Case", value: String(f["useCase"] || DASH) },
        { key: "Tone", value: String(f["tone"] || DASH) },
        { key: "Created", value: String(f["createdAt"] || DASH) },
      );
    }

    return {
      title: resource.displayName,
      subtitle: builtIn ? "xAI Voice · built-in" : "xAI Voice · custom",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        { kind: "section", title: "Voice", children: [{ kind: "key-value-list", items }] },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      speechPanel: this.speechPanel(resource, voiceId),
    };
  }

  private speechPanel(
    resource: ResourceInstance,
    defaultVoice: string | undefined,
  ): SpeechPanelCapability {
    let voices: SpeechPanelOption[] = FALLBACK_BUILTIN_VOICES.map((v) => ({
      id: v.voice_id,
      label: v.name,
      description: "Built-in",
    }));
    const stashed = resource.resolvedOutputs["__voices__"];
    if (stashed) {
      try {
        const parsed = JSON.parse(stashed) as SpeechPanelOption[];
        if (Array.isArray(parsed) && parsed.length > 0) voices = parsed;
      } catch {
        // keep the documented built-ins
      }
    }

    return {
      modes: ["tts", "stt"],
      subtitle:
        "xAI Voice API · TTS returns MP3, STT auto-detects the container format you record in",
      helpText:
        "Text-to-speech supports inline tags like [pause], [laugh] and <whisper> for expressive output.",
      voices,
      defaultVoice: defaultVoice || voices[0]?.id || "eve",
      voiceLabel: "Voice",
      maxCharacters: TTS_MAX_CHARACTERS,
      maxAudioBytes: STT_MAX_AUDIO_BYTES,
      acceptedAudioTypes: [
        "audio/wav",
        "audio/mpeg",
        "audio/ogg",
        "audio/flac",
        "audio/aac",
        "audio/mp4",
        "audio/webm",
        ".wav",
        ".mp3",
        ".ogg",
        ".opus",
        ".flac",
        ".aac",
        ".m4a",
        ".mp4",
        ".mkv",
      ],
      // xAI's /v1/stt and /v1/tts take no model parameter, so the shared picker
      // carries the language instead: required by TTS, optional for STT.
      models: TTS_LANGUAGES,
      defaultModel: "en",
      modelLabel: "Language",
      languages: TTS_LANGUAGES,
      defaultLanguage: "auto",
      languageLabel: "Transcription language",
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const bytes = Number(f["bytes"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: "xAI File",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "File",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "File ID", value: String(f["fileId"] || DASH), copyable: true },
                { key: "Filename", value: String(f["filename"] || DASH) },
                { key: "Size", value: bytes > 0 ? formatByteSize(bytes) : DASH },
                { key: "Purpose", value: String(f["purpose"] || DASH) },
                { key: "Created", value: String(f["createdAt"] || DASH) },
                { key: "Expires", value: String(f["expiresAt"] || "never") },
                {
                  key: "Public URL",
                  value: String(f["publicUrl"] || "none"),
                  ...(f["publicUrl"] ? { copyable: true } : {}),
                },
                ...(f["publicUrl"]
                  ? [
                      {
                        key: "Public URL Expires",
                        value: String(f["publicUrlExpiresAt"] || "never"),
                      },
                    ]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        f["publicUrl"]
          ? {
              kind: "action",
              label: "Revoke public URL",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "revoke-public-url",
                confirmMessage:
                  "Revoke this file's public URL? Anyone using the link loses access; the file itself is kept.",
                successMessage: "Public URL revoked.",
              },
            }
          : {
              kind: "action",
              label: "Create public URL",
              action: {
                type: "plugin-action",
                actionId: "create-public-url",
                confirmMessage:
                  "Create a permanent, unauthenticated URL for this file? Anyone with the link can download it until it is revoked or the file expires.",
                successMessage: "Public URL created. Refresh to copy it.",
              },
            },
      ],
    };
  }

  private renderBatchDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const pending = Number(f["numPending"] ?? 0);
    const errored = Number(f["numError"] ?? 0);
    const cancelled = String(f["cancelTime"] ?? "") !== "";
    const requests = parseJsonArray<XaiBatchRequestMeta>(resource.resolvedOutputs["__requests__"]);
    const status = cancelled
      ? "degraded"
      : errored > 0
        ? "error"
        : pending > 0
          ? "provisioning"
          : "healthy";

    return {
      title: resource.displayName,
      subtitle: "xAI Batch",
      status: { kind: "status-dot", status },
      sections: [
        {
          kind: "section",
          title: "Batch",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Batch ID", value: String(f["batchId"] || DASH), copyable: true },
                { key: "Name", value: String(f["name"] || DASH) },
                { key: "Created", value: String(f["createTime"] || DASH) },
                { key: "Expires", value: String(f["expireTime"] || DASH) },
                { key: "Cancelled", value: String(f["cancelTime"] || DASH) },
                { key: "Cancellation Reason", value: String(f["cancelMessage"] || DASH) },
                { key: "Created By API Key", value: String(f["createApiKeyId"] || DASH) },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Requests",
          children: [
            {
              kind: "table",
              emphasizeFirstColumn: true,
              columns: [
                { key: "state", label: "State" },
                { key: "count", label: "Count", mono: true },
              ],
              rows: [
                { cells: { state: "Total", count: String(f["numRequests"] ?? 0) } },
                { cells: { state: "Pending", count: String(pending) } },
                { cells: { state: "Succeeded", count: String(f["numSuccess"] ?? 0) } },
                { cells: { state: "Errored", count: String(errored) } },
                { cells: { state: "Cancelled", count: String(f["numCancelled"] ?? 0) } },
              ],
            },
            ...(requests.length > 0
              ? [
                  {
                    kind: "table" as const,
                    columns: [
                      { key: "id", label: "Request ID", mono: true },
                      { key: "state", label: "State" },
                      { key: "model", label: "Model" },
                      { key: "endpoint", label: "Endpoint" },
                      { key: "created", label: "Created" },
                      { key: "finished", label: "Finished" },
                    ],
                    rows: requests.map((r) => ({
                      cells: {
                        id: r.batch_request_id || DASH,
                        state: r.state || DASH,
                        model: r.model || DASH,
                        endpoint: r.endpoint || DASH,
                        created: r.create_time || DASH,
                        finished: r.finish_time || DASH,
                      },
                    })),
                  },
                ]
              : []),
            ...(requests.length >= BATCH_REQUESTS_PREVIEW
              ? [
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content: `Showing the first ${BATCH_REQUESTS_PREVIEW} requests.`,
                  },
                ]
              : []),
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(pending > 0 && !cancelled
          ? [
              {
                kind: "action" as const,
                label: "Cancel batch",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel every pending request in this batch? Requests already processed are still billed.",
                  successMessage: "Batch cancellation requested.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderSkillDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "xAI Skill",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Skill",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Skill ID", value: String(f["skillId"] || DASH), copyable: true },
                { key: "Name", value: String(f["name"] || DASH) },
                { key: "Description", value: String(f["description"] || DASH) },
                { key: "Default Version", value: String(f["defaultVersion"] || DASH) },
                { key: "Latest Version", value: String(f["latestVersion"] || DASH) },
                { key: "Created", value: String(f["createdAt"] || DASH) },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Name and description come from the bundle's SKILL.md frontmatter. To change them, upload a new bundle with POST /v1/skills.",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const disabled = f["disabled"] === true;
    const acls = String(f["acls"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      title: resource.displayName,
      subtitle: "xAI API Key · managed via management-api.x.ai",
      status: { kind: "status-dot", status: disabled ? "degraded" : "healthy" },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "API Key ID", value: String(f["apiKeyId"] || DASH), copyable: true },
                { key: "Name", value: String(f["name"] || DASH) },
                { key: "Redacted Key", value: String(f["redactedApiKey"] || DASH) },
                { key: "Status", value: disabled ? "Disabled" : "Active" },
                { key: "Expires", value: String(f["expireTime"] || "never") },
                { key: "Created", value: String(f["createTime"] || DASH) },
                { key: "Modified", value: String(f["modifyTime"] || DASH) },
                { key: "Created By", value: String(f["userId"] || DASH) },
                { key: "Team ID", value: String(f["teamId"] || DASH) },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Rate Limits",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Queries / second", value: limitLabel(f["qps"]) },
                { key: "Queries / minute", value: limitLabel(f["qpm"]) },
                { key: "Tokens / minute", value: limitLabel(f["tpm"]) },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Permissions",
          children: [
            {
              kind: "table",
              columns: [{ key: "acl", label: "ACL", mono: true }],
              rows:
                acls.length > 0
                  ? acls.map((acl) => ({ cells: { acl } }))
                  : [{ cells: { acl: "(no ACLs — this key cannot call anything)" } }],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Rotate secret",
          variant: "danger",
          action: {
            type: "plugin-action",
            actionId: "rotate",
            confirmMessage:
              "Rotating mints a new secret and stops the old one being accepted after 24 hours. Continue?",
            successMessage: "Secret rotated. Grab the new key from the xAI console.",
          },
        },
      ],
    };
  }

  private renderAuditEventDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "xAI Audit Event",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Event",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Event ID", value: String(f["eventId"] || DASH), copyable: true },
                { key: "Time", value: String(f["eventTime"] || DASH) },
                { key: "Description", value: String(f["description"] || DASH) },
                { key: "User", value: String(f["userName"] || DASH) },
                { key: "Email", value: String(f["userEmail"] || DASH) },
                { key: "User ID", value: String(f["userId"] || DASH) },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "api-key") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: resource.fields["disabled"] === true ? "degraded" : "healthy",
        },
      };
    }
    if (resource.resourceTypeId === "batch") {
      const errored = Number(resource.fields["numError"] ?? 0);
      const pending = Number(resource.fields["numPending"] ?? 0);
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: errored > 0 ? "error" : pending > 0 ? "provisioning" : "healthy",
        },
      };
    }
    if (resource.resourceTypeId === "collection-document") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: documentStatusDot(String(resource.fields["status"] ?? "")),
        },
      };
    }
    if (resource.resourceTypeId === "invoice") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: invoiceStatusDot(String(resource.fields["status"] ?? "")),
          label: formatUsd(Number(resource.fields["total"] ?? 0)),
        },
      };
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }
}

// -------------------------------------------------------------- helpers

/** A model that can consume or produce audio gets the Speech tab too. */
function isAudioModel(resource: ResourceInstance): boolean {
  const modalities = `${resource.fields["inputModalities"] ?? ""},${resource.fields["outputModalities"] ?? ""}`;
  return /audio|speech/i.test(modalities);
}

function parseJsonArray<T>(raw: string | number | boolean | undefined): T[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function limitLabel(value: string | number | boolean | undefined): string {
  if (value === undefined || value === "" || value === 0 || value === "0") return "unlimited";
  return String(value);
}

function formatEpochSeconds(seconds: number | undefined): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toISOString();
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How many line items the spending-limit chart breaks out beside the total. */
const TOP_LINE_ITEMS = 5;

/** `YYYY-MM-DD HH:MM:SS` in UTC, the analytics query's `timeRange` format. */
function usageTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Team-wide spend: one total series summed across every line item, then the
 * {@link TOP_LINE_ITEMS} costliest line items over the window. Line items that
 * cost nothing in the window are left out entirely.
 */
function teamSpendSeries(usage: XaiUsageResponse): MetricSeries[] {
  const total = new Map<number, number>();
  const items: Array<{ label: string; sum: number; points: MetricSeries["points"] }> = [];
  for (const s of usage.timeSeries ?? []) {
    const label = s.groupLabels?.[0] ?? s.group?.[0] ?? "xAI API";
    const points: MetricSeries["points"] = [];
    let sum = 0;
    for (const p of s.dataPoints ?? []) {
      if (!p.timestamp) continue;
      const ts = Date.parse(p.timestamp);
      if (Number.isNaN(ts)) continue;
      const value = p.values?.[0] ?? 0;
      points.push({ timestamp: ts, value });
      total.set(ts, (total.get(ts) ?? 0) + value);
      sum += value;
    }
    if (sum > 0) items.push({ label, sum, points });
  }
  if (total.size === 0) return [];
  const byTime = (a: { timestamp: number }, b: { timestamp: number }) => a.timestamp - b.timestamp;
  const out: MetricSeries[] = [
    {
      label: "Total spend",
      unit: "USD",
      points: [...total].map(([timestamp, value]) => ({ timestamp, value })).sort(byTime),
    },
  ];
  items.sort((a, b) => b.sum - a.sum);
  for (const item of items.slice(0, TOP_LINE_ITEMS)) {
    out.push({ label: item.label, unit: "USD", points: [...item.points].sort(byTime) });
  }
  return out;
}

function nextDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return date;
  return isoDate(ms + 24 * 60 * 60 * 1000);
}

function formatByteSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fileNameForMime(mimeType: string): string {
  const base = (mimeType || "").split(";")[0]?.trim().toLowerCase() ?? "";
  const ext =
    {
      "audio/webm": "webm",
      "audio/ogg": "ogg",
      "audio/mp4": "mp4",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/flac": "flac",
      "audio/aac": "aac",
    }[base] ?? "bin";
  return `clip.${ext}`;
}

/**
 * Assemble a `multipart/form-data` body as raw bytes so it can be handed to the
 * host's HTTP service (which accepts `Uint8Array`) as well as global `fetch`.
 */
function buildMultipartBody(boundary: string, parts: MultipartPart[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += "\r\n";
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += "\r\n";
    chunks.push(encoder.encode(header));
    chunks.push(typeof part.value === "string" ? encoder.encode(part.value) : part.value);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
