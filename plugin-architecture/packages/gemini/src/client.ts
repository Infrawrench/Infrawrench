import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SidebarItemSchema,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";
import { base64ToBytes, bytesToBase64, jsonRestFetch } from "@infrawrench/plugin-base";
import {
  GEMINI_PCM_BITS_PER_SAMPLE,
  GEMINI_PCM_CHANNELS,
  GEMINI_PCM_SAMPLE_RATE,
  geminiPcmDurationSeconds,
  pcmToWav,
} from "./audio.js";
import {
  ACCEPTED_AUDIO_TYPES,
  AUDIO_TOKENS_PER_SECOND,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE,
  GEMINI_VOICES,
  MAX_INLINE_AUDIO_BYTES,
  TTS_LANGUAGES,
  TTS_MODELS,
} from "./speech-catalog.js";
import type {
  CachedContent,
  FileSearchDocument,
  FileSearchStore,
  GeminiFile,
  GeminiModel,
  GenerateContentResponse,
  InteractionResponse,
  ListCachedContentsResponse,
  ListFileSearchDocumentsResponse,
  ListFileSearchStoresResponse,
  ListFilesResponse,
  ListModelsResponse,
  ListOperationsResponse,
  ListTunedModelsResponse,
  Operation,
  TunedModel,
} from "./api-types.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * The default model for the STT half of the Speech tab. Audio understanding
 * runs through ordinary `generateContent`, so any multimodal Gemini model can
 * do it; the picker is populated from the live model list and this is only the
 * fallback when that call fails.
 */
const DEFAULT_STT_MODEL = "gemini-2.5-flash";

const SPEECH_HELP_TEXT =
  "Text-to-speech runs through the Interactions API and returns raw 24 kHz mono PCM, which this " +
  "plugin wraps in a WAV header so the player below can play it. Speech-to-text sends the clip " +
  "inline to generateContent. Google documents WAV, MP3, AIFF, AAC, OGG and FLAC as accepted " +
  "input — notably not the WebM your browser records on Chrome, Edge and Firefox, nor the MP4 " +
  "Safari records. Those are very likely accepted anyway (Firebase AI Logic, which fronts this " +
  "same endpoint, lists both), so a recording is still worth trying — but upload one of the six " +
  "documented formats if you want a guarantee. Inline requests are capped at 20 MB.";

/**
 * Gemini (AI Studio) plugin client.
 *
 * ⚠️ `generativelanguage.googleapis.com` has **no admin, usage, quota or
 * billing API of any kind**. This plugin therefore reads models, tuned models,
 * files, context caches, batches and File Search stores, mutates the handful of
 * things the API allows, and says plainly in the UI that spend and quota are
 * dashboard-only.
 *
 * Every call here is JSON in and JSON out — including both halves of the Speech
 * tab, since Interactions returns base64 audio inside a JSON envelope rather
 * than raw bytes. That means everything can go through `jsonRestFetch` and keep
 * bastion egress routing and the custom CA; no binary or multipart side-channel
 * is needed.
 */
/**
 * Instruction for the transcription call, optionally pinned to a language.
 *
 * An empty/absent language means "auto", which is the picker's first entry and
 * the sensible default — the model infers it from the audio.
 */
function transcriptionPrompt(language: string | undefined): string {
  const base =
    "Transcribe this audio verbatim. Reply with the transcript only — no preamble, no commentary, no formatting.";
  if (!language) return base;
  return `${base} The audio is in ${language}; transcribe it in that language and do not translate it.`;
}

export class GeminiClient implements PluginClient {
  private readonly apiKey: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Gemini plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Gemini",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: {
        // The legacy `?key=` query parameter also works, but the header keeps
        // the key out of URLs, proxy logs and error messages.
        "x-goog-api-key": this.apiKey,
        Accept: "application/json",
      },
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  /**
   * Walk a Google-standard `pageSize` / `pageToken` → `nextPageToken` list.
   * Page-size defaults and caps vary per collection, so callers pass their own.
   */
  private async paginate<TItem, TResponse extends { nextPageToken?: string }>(
    path: string,
    pageSize: number,
    pick: (response: TResponse) => TItem[] | undefined,
    extraParams?: Record<string, string>,
  ): Promise<TItem[]> {
    const items: TItem[] = [];
    let pageToken: string | undefined;
    // Bounded so a pathological cursor cannot spin forever.
    for (let page = 0; page < 25; page += 1) {
      const params = new URLSearchParams({ pageSize: String(pageSize), ...extraParams });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.fetch<TResponse>(`${path}?${params.toString()}`);
      items.push(...(pick(data) ?? []));
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return items;
  }

  // ---------------------------------------------------------------------------
  // Resource listing
  // ---------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return this.listModels(accountId);
      case "tuned-model":
        return this.listTunedModels(accountId);
      case "file":
        return this.listFiles(accountId);
      case "cached-content":
        return this.listCachedContents(accountId);
      case "batch":
        return this.listBatches(accountId);
      case "file-search-store":
        return this.listFileSearchStores(accountId);
      case "file-search-document":
        return this.listAllFileSearchDocuments(accountId);
      default:
        throw new Error(`Gemini plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "model") {
      // The model detail view carries the Speech tab, whose STT model picker is
      // populated from the live model list. `renderDetail` is synchronous, so
      // that extra call happens here and the result is stashed as JSON under a
      // __double-underscore__ key in resolvedOutputs.
      const resource = await this.findResource(typeId, resourceId, accountId);
      const sttModels = await this.safely(() => this.fetchAudioCapableModelOptions(), []);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          __sttModels__: JSON.stringify(sttModels),
        },
      };
    }

    return this.findResource(typeId, resourceId, accountId);
  }

  private async findResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Gemini plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  private async safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  /**
   * `GET /v1beta/models` — https://ai.google.dev/api/models
   * `pageSize` defaults to 50 and the endpoint returns at most 1000 per page.
   */
  private async fetchModels(): Promise<GeminiModel[]> {
    return this.paginate<GeminiModel, ListModelsResponse>("/models", 1000, (r) => r.models);
  }

  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const models = await this.fetchModels();
    const now = new Date().toISOString();
    return models.filter((m) => Boolean(m.name)).map((m) => this.mapModel(accountId, m, now));
  }

  private mapModel(accountId: string, model: GeminiModel, now: string): ResourceInstance {
    const name = model.name ?? "";
    const shortId = shortName(name);
    return {
      id: `${accountId}:model:${shortId}`,
      pluginId: "gemini",
      resourceTypeId: "model",
      accountId,
      displayName: model.displayName || shortId,
      fields: {
        name,
        baseModelId: model.baseModelId ?? "",
        displayName: model.displayName ?? "",
        version: model.version ?? "",
        descriptionText: model.description ?? "",
        inputTokenLimit: model.inputTokenLimit ?? 0,
        outputTokenLimit: model.outputTokenLimit ?? 0,
        supportedGenerationMethods: (model.supportedGenerationMethods ?? []).join(", "),
        thinking: Boolean(model.thinking),
        temperature: model.temperature ?? 0,
        maxTemperature: model.maxTemperature ?? 0,
        topP: model.topP ?? 0,
        topK: model.topK ?? 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: shortId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1beta/tunedModels` — verified against the v1beta discovery document.
   * ⚠️ `pageSize` defaults to **10** here, not 50.
   */
  private async fetchTunedModels(): Promise<TunedModel[]> {
    return this.paginate<TunedModel, ListTunedModelsResponse>(
      "/tunedModels",
      1000,
      (r) => r.tunedModels,
    );
  }

  private async listTunedModels(accountId: string): Promise<ResourceInstance[]> {
    const models = await this.fetchTunedModels();
    const now = new Date().toISOString();
    return models.filter((m) => Boolean(m.name)).map((m) => this.mapTunedModel(accountId, m, now));
  }

  private mapTunedModel(accountId: string, model: TunedModel, now: string): ResourceInstance {
    const name = model.name ?? "";
    const shortId = shortName(name);
    const hyper = model.tuningTask?.hyperparameters;
    return {
      id: `${accountId}:tuned-model:${shortId}`,
      pluginId: "gemini",
      resourceTypeId: "tuned-model",
      accountId,
      displayName: model.displayName || shortId,
      fields: {
        name,
        displayName: model.displayName ?? "",
        state: model.state ?? "",
        baseModel: model.baseModel ?? model.tunedModelSource?.baseModel ?? "",
        sourceTunedModel: model.tunedModelSource?.tunedModel ?? "",
        descriptionText: model.description ?? "",
        createTime: model.createTime ?? "",
        updateTime: model.updateTime ?? "",
        temperature: model.temperature ?? 0,
        topP: model.topP ?? 0,
        topK: model.topK ?? 0,
        epochCount: hyper?.epochCount ?? 0,
        batchSize: hyper?.batchSize ?? 0,
        learningRate: hyper?.learningRate ?? 0,
        tuningStartTime: model.tuningTask?.startTime ?? "",
        tuningCompleteTime: model.tuningTask?.completeTime ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: shortId,
      createdAt: model.createTime ?? now,
      updatedAt: model.updateTime ?? now,
    };
  }

  /**
   * `GET /v1beta/files` — https://ai.google.dev/api/files
   * ⚠️ `pageSize` defaults to 10 and caps at **100** here.
   */
  private async fetchFiles(): Promise<GeminiFile[]> {
    return this.paginate<GeminiFile, ListFilesResponse>("/files", 100, (r) => r.files);
  }

  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const files = await this.fetchFiles();
    const now = new Date().toISOString();
    return files.filter((f) => Boolean(f.name)).map((f) => this.mapFile(accountId, f, now));
  }

  private mapFile(accountId: string, file: GeminiFile, now: string): ResourceInstance {
    const name = file.name ?? "";
    const shortId = shortName(name);
    return {
      id: `${accountId}:file:${shortId}`,
      pluginId: "gemini",
      resourceTypeId: "file",
      accountId,
      displayName: file.displayName || shortId,
      fields: {
        name,
        displayName: file.displayName ?? "",
        mimeType: file.mimeType ?? "",
        sizeBytes: file.sizeBytes ?? "0",
        state: file.state ?? "",
        source: file.source ?? "",
        createTime: file.createTime ?? "",
        updateTime: file.updateTime ?? "",
        expirationTime: file.expirationTime ?? "",
        sha256Hash: file.sha256Hash ?? "",
        uri: file.uri ?? "",
        downloadUri: file.downloadUri ?? "",
        errorMessage: file.error?.message ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: shortId,
      createdAt: file.createTime ?? now,
      updatedAt: file.updateTime ?? now,
    };
  }

  /**
   * `GET /v1beta/cachedContents` — https://ai.google.dev/api/caching
   * `pageSize` is coerced down to 1000.
   */
  private async fetchCachedContents(): Promise<CachedContent[]> {
    return this.paginate<CachedContent, ListCachedContentsResponse>(
      "/cachedContents",
      1000,
      (r) => r.cachedContents,
    );
  }

  private async listCachedContents(accountId: string): Promise<ResourceInstance[]> {
    const caches = await this.fetchCachedContents();
    const now = new Date().toISOString();
    return caches
      .filter((c) => Boolean(c.name))
      .map((c) => this.mapCachedContent(accountId, c, now));
  }

  private mapCachedContent(accountId: string, cache: CachedContent, now: string): ResourceInstance {
    const name = cache.name ?? "";
    const shortId = shortName(name);
    return {
      id: `${accountId}:cached-content:${shortId}`,
      pluginId: "gemini",
      resourceTypeId: "cached-content",
      accountId,
      displayName: cache.displayName || shortId,
      fields: {
        name,
        displayName: cache.displayName ?? "",
        model: cache.model ?? "",
        totalTokenCount: cache.usageMetadata?.totalTokenCount ?? 0,
        ttl: cache.ttl ?? "",
        expireTime: cache.expireTime ?? "",
        createTime: cache.createTime ?? "",
        updateTime: cache.updateTime ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: shortId,
      createdAt: cache.createTime ?? now,
      updatedAt: cache.updateTime ?? now,
    };
  }

  /**
   * `GET /v1beta/batches` — https://ai.google.dev/api/batch-mode
   *
   * ⚠️ This is an Operations API: the response key is **`operations[]`**, not
   * `batches[]`, and the batch payload lives in each operation's `metadata`.
   */
  private async fetchBatches(): Promise<Operation[]> {
    return this.paginate<Operation, ListOperationsResponse>("/batches", 100, (r) => r.operations);
  }

  private async listBatches(accountId: string): Promise<ResourceInstance[]> {
    const operations = await this.fetchBatches();
    const now = new Date().toISOString();
    return operations.filter((o) => Boolean(o.name)).map((o) => this.mapBatch(accountId, o, now));
  }

  private mapBatch(accountId: string, operation: Operation, now: string): ResourceInstance {
    const name = operation.name ?? "";
    const shortId = shortName(name);
    const batch = operation.metadata ?? {};
    const stats = batch.batchStats ?? {};
    return {
      id: `${accountId}:batch:${shortId}`,
      pluginId: "gemini",
      resourceTypeId: "batch",
      accountId,
      displayName: batch.displayName || shortId,
      fields: {
        name,
        displayName: batch.displayName ?? "",
        model: batch.model ?? "",
        state: batch.state ?? "",
        done: Boolean(operation.done),
        createTime: batch.createTime ?? "",
        updateTime: batch.updateTime ?? "",
        endTime: batch.endTime ?? "",
        requestCount: Number(stats.requestCount ?? 0),
        pendingRequestCount: Number(stats.pendingRequestCount ?? 0),
        successfulRequestCount: Number(stats.successfulRequestCount ?? 0),
        failedRequestCount: Number(stats.failedRequestCount ?? 0),
        outputFileName: batch.output?.responsesFile ?? "",
        errorMessage: operation.error?.message ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: shortId,
      createdAt: batch.createTime ?? now,
      updatedAt: batch.updateTime ?? now,
    };
  }

  /**
   * `GET /v1beta/fileSearchStores` — https://ai.google.dev/api/file-search
   * ⚠️ `pageSize` defaults to 10 and caps at **20** for stores and documents.
   */
  private async fetchFileSearchStores(): Promise<FileSearchStore[]> {
    return this.paginate<FileSearchStore, ListFileSearchStoresResponse>(
      "/fileSearchStores",
      20,
      (r) => r.fileSearchStores,
    );
  }

  private async listFileSearchStores(accountId: string): Promise<ResourceInstance[]> {
    const stores = await this.fetchFileSearchStores();
    const now = new Date().toISOString();
    return stores
      .filter((s) => Boolean(s.name))
      .map((s) => this.mapFileSearchStore(accountId, s, now));
  }

  private mapFileSearchStore(
    accountId: string,
    store: FileSearchStore,
    now: string,
  ): ResourceInstance {
    const name = store.name ?? "";
    const shortId = shortName(name);
    return {
      id: `${accountId}:file-search-store:${shortId}`,
      pluginId: "gemini",
      resourceTypeId: "file-search-store",
      accountId,
      displayName: store.displayName || shortId,
      fields: {
        name,
        displayName: store.displayName ?? "",
        embeddingModel: store.embeddingModel ?? "",
        createTime: store.createTime ?? "",
        updateTime: store.updateTime ?? "",
        activeDocumentsCount: Number(store.activeDocumentsCount ?? 0),
        pendingDocumentsCount: Number(store.pendingDocumentsCount ?? 0),
        failedDocumentsCount: Number(store.failedDocumentsCount ?? 0),
        sizeBytes: store.sizeBytes ?? "0",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: shortId,
      createdAt: store.createTime ?? now,
      updatedAt: store.updateTime ?? now,
    };
  }

  /** `GET /v1beta/fileSearchStores/{store}/documents` */
  private async fetchFileSearchDocuments(storeName: string): Promise<FileSearchDocument[]> {
    return this.paginate<FileSearchDocument, ListFileSearchDocumentsResponse>(
      `/${storeName}/documents`,
      20,
      (r) => r.documents,
    );
  }

  /**
   * Documents across every store. The API only lists documents per store, so
   * this fans out over the store list.
   */
  private async listAllFileSearchDocuments(accountId: string): Promise<ResourceInstance[]> {
    const stores = await this.fetchFileSearchStores();
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];

    for (const store of stores) {
      const storeName = store.name;
      if (!storeName) continue;
      // One unreadable store shouldn't blank the whole listing.
      const documents = await this.safely(() => this.fetchFileSearchDocuments(storeName), []);
      for (const doc of documents) {
        if (!doc.name) continue;
        out.push(this.mapFileSearchDocument(accountId, storeName, doc, now));
      }
    }
    return out;
  }

  private mapFileSearchDocument(
    accountId: string,
    storeName: string,
    doc: FileSearchDocument,
    now: string,
  ): ResourceInstance {
    const name = doc.name ?? "";
    return {
      id: `${accountId}:file-search-document:${name}`,
      pluginId: "gemini",
      resourceTypeId: "file-search-document",
      accountId,
      displayName: doc.displayName || shortName(name),
      parentResourceId: `${accountId}:file-search-store:${shortName(storeName)}`,
      fields: {
        name,
        displayName: doc.displayName ?? "",
        storeName,
        mimeType: doc.mimeType ?? "",
        state: doc.state ?? "",
        sizeBytes: doc.sizeBytes ?? "0",
        createTime: doc.createTime ?? "",
        updateTime: doc.updateTime ?? "",
        customMetadata: doc.customMetadata?.length ? JSON.stringify(doc.customMetadata) : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: doc.createTime ?? now,
      updatedAt: doc.updateTime ?? now,
    };
  }

  // ---------------------------------------------------------------------------
  // Outputs
  // ---------------------------------------------------------------------------

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "model" && outputKey === "endpoint") return BASE_URL;

    const resource = await this.findResource(typeId, resourceId, accountId);
    const fields = resource.fields;

    if (typeId === "model") {
      if (outputKey === "modelId") return resource.externalId ?? "";
      if (outputKey === "modelName") return String(fields["name"] ?? "");
      if (outputKey === "inputTokenLimit") return String(fields["inputTokenLimit"] ?? "");
      if (outputKey === "outputTokenLimit") return String(fields["outputTokenLimit"] ?? "");
    }

    if (typeId === "tuned-model") {
      if (outputKey === "tunedModelId") return resource.externalId ?? "";
      if (outputKey === "tunedModelName") return String(fields["name"] ?? "");
      if (outputKey === "state") return String(fields["state"] ?? "");
    }

    if (typeId === "file") {
      if (outputKey === "fileUri") return String(fields["uri"] ?? "");
      if (outputKey === "fileName") return String(fields["name"] ?? "");
      if (outputKey === "mimeType") return String(fields["mimeType"] ?? "");
      if (outputKey === "state") return String(fields["state"] ?? "");
    }

    if (typeId === "cached-content") {
      if (outputKey === "cachedContentName") return String(fields["name"] ?? "");
      if (outputKey === "model") return String(fields["model"] ?? "");
      if (outputKey === "totalTokenCount") return String(fields["totalTokenCount"] ?? "");
    }

    if (typeId === "batch") {
      if (outputKey === "batchName") return String(fields["name"] ?? "");
      if (outputKey === "state") return String(fields["state"] ?? "");
      if (outputKey === "outputFileName") return String(fields["outputFileName"] ?? "");
    }

    if (typeId === "file-search-store") {
      if (outputKey === "fileSearchStoreName") return String(fields["name"] ?? "");
      if (outputKey === "activeDocumentsCount") return String(fields["activeDocumentsCount"] ?? "");
    }

    if (typeId === "file-search-document") {
      if (outputKey === "documentName") return String(fields["name"] ?? "");
      if (outputKey === "state") return String(fields["state"] ?? "");
    }

    throw new Error(`Gemini plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "file-search-store") {
      return {
        fields: [
          {
            key: "displayName",
            label: "Display Name",
            kind: "text",
            required: true,
            description: "Shown in Infrawrench and AI Studio. The resource name is generated.",
          },
        ],
      };
    }
    throw new Error(`Gemini plugin: no create config for type "${typeId}"`);
  }

  /** `POST /v1beta/fileSearchStores` — https://ai.google.dev/api/file-search */
  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "file-search-store") {
      throw new Error(`Gemini plugin: cannot create type "${typeId}"`);
    }
    const displayName = fields["displayName"];
    if (!displayName) throw new Error("Gemini plugin: a display name is required");

    const store = await this.fetch<FileSearchStore>("/fileSearchStores", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    });
    return this.mapFileSearchStore(accountId, store, new Date().toISOString());
  }

  /**
   * Only a context cache's expiry is updatable —
   * `PATCH /v1beta/cachedContents/{id}?updateMask=ttl`.
   * https://ai.google.dev/api/caching
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "cached-content") {
      throw new Error(`Gemini plugin: cannot update type "${typeId}"`);
    }
    const ttl = fields["ttl"];
    if (!ttl) {
      throw new Error(
        'Gemini plugin: only a cache\'s ttl is updatable — supply a duration such as "3600s"',
      );
    }

    const externalId = externalIdOf(resourceId);
    const cache = await this.fetch<CachedContent>(
      `/cachedContents/${encodeURIComponent(externalId)}?updateMask=ttl`,
      { method: "PATCH", body: JSON.stringify({ ttl }) },
    );
    return this.mapCachedContent(accountId, cache, new Date().toISOString());
  }

  /**
   * Delete paths, all verified:
   *  - `DELETE /v1beta/files/{id}`               https://ai.google.dev/api/files
   *  - `DELETE /v1beta/cachedContents/{id}`      https://ai.google.dev/api/caching
   *  - `DELETE /v1beta/tunedModels/{id}`         v1beta discovery document
   *  - `DELETE /v1beta/batches/{id}`             https://ai.google.dev/api/batch-mode
   *  - `DELETE /v1beta/fileSearchStores/{id}?force=true`
   *  - `DELETE /v1beta/fileSearchStores/{store}/documents/{id}?force=true`
   *
   * `force` is required on both File Search deletes: without it a store that
   * still holds documents returns FAILED_PRECONDITION. Since the host has
   * already confirmed the deletion with the user, passing it is the behaviour
   * they asked for.
   */
  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);

    switch (typeId) {
      case "file":
        await this.fetch(`/files/${encodeURIComponent(externalId)}`, { method: "DELETE" });
        return;
      case "cached-content":
        await this.fetch(`/cachedContents/${encodeURIComponent(externalId)}`, { method: "DELETE" });
        return;
      case "tuned-model":
        await this.fetch(`/tunedModels/${encodeURIComponent(externalId)}`, { method: "DELETE" });
        return;
      case "batch":
        await this.fetch(`/batches/${encodeURIComponent(externalId)}`, { method: "DELETE" });
        return;
      case "file-search-store":
        await this.fetch(`/fileSearchStores/${encodeURIComponent(externalId)}?force=true`, {
          method: "DELETE",
        });
        return;
      case "file-search-document":
        // The document's externalId is its full resource name, which already
        // includes the store path.
        await this.fetch(`/${externalId}?force=true`, { method: "DELETE" });
        return;
      default:
        throw new Error(`Gemini plugin: cannot delete type "${typeId}"`);
    }
  }

  /** `POST /v1beta/batches/{id}:cancel` — https://ai.google.dev/api/batch-mode */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "batch" && actionId === "cancel") {
      await this.fetch(`/batches/${encodeURIComponent(externalIdOf(resourceId))}:cancel`, {
        method: "POST",
      });
      return;
    }
    throw new Error(`Gemini plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  // ---------------------------------------------------------------------------
  // Dashboard stats
  // ---------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.findResource(resourceTypeId, resourceId, accountId);
    const fields = resource.fields;

    if (resourceTypeId === "model") {
      return [
        { label: "Input", value: formatTokens(Number(fields["inputTokenLimit"] ?? 0)) },
        { label: "Output", value: formatTokens(Number(fields["outputTokenLimit"] ?? 0)) },
        ...(fields["thinking"] === true ? [{ label: "Thinking", value: "yes" }] : []),
      ];
    }

    if (resourceTypeId === "tuned-model") {
      return [
        { label: "State", value: String(fields["state"] || "—") },
        { label: "Base", value: shortName(String(fields["baseModel"] || "")) || "—" },
      ];
    }

    if (resourceTypeId === "file") {
      return [
        { label: "Type", value: String(fields["mimeType"] || "—") },
        { label: "Size", value: formatBytes(Number(fields["sizeBytes"] ?? 0)) },
        { label: "State", value: String(fields["state"] || "—") },
      ];
    }

    if (resourceTypeId === "cached-content") {
      return [
        { label: "Cached", value: formatTokens(Number(fields["totalTokenCount"] ?? 0)) },
        { label: "Model", value: shortName(String(fields["model"] || "")) || "—" },
        { label: "Expires", value: String(fields["expireTime"] || "—") },
      ];
    }

    if (resourceTypeId === "batch") {
      return [
        { label: "State", value: prettyBatchState(String(fields["state"] || "")) },
        {
          label: "Requests",
          value: `${Number(fields["successfulRequestCount"] ?? 0)}/${Number(fields["requestCount"] ?? 0)}`,
        },
        ...(Number(fields["failedRequestCount"] ?? 0) > 0
          ? [
              {
                label: "Failed",
                value: String(fields["failedRequestCount"]),
                variant: "status-degraded" as const,
              },
            ]
          : []),
      ];
    }

    if (resourceTypeId === "file-search-store") {
      return [
        { label: "Documents", value: String(fields["activeDocumentsCount"] ?? 0) },
        { label: "Pending", value: String(fields["pendingDocumentsCount"] ?? 0) },
        { label: "Size", value: formatBytes(Number(fields["sizeBytes"] ?? 0)) },
      ];
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "model":
        return this.renderModelDetail(resource);
      case "tuned-model":
        return this.renderTunedModelDetail(resource);
      case "file":
        return this.renderFileDetail(resource);
      case "cached-content":
        return this.renderCachedContentDetail(resource);
      case "batch":
        return this.renderBatchDetail(resource);
      case "file-search-store":
        return this.renderFileSearchStoreDetail(resource);
      case "file-search-document":
        return this.renderFileSearchDocumentDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: "Gemini",
          sections: [
            {
              kind: "section",
              title: "Details",
              children: [{ kind: "key-value-list", items: keyValuesFrom(resource.fields) }],
            },
          ],
        };
    }
  }

  /**
   * The "there is no usage API" panel. This is the honest state of the AI
   * Studio API surface, and saying so beats rendering an empty chart.
   */
  private quotaSection() {
    return {
      kind: "section" as const,
      title: "Quota & Billing",
      children: [
        {
          kind: "text" as const,
          variant: "muted" as const,
          content:
            "The Gemini API on AI Studio has no admin, usage, quota or billing endpoints at all — " +
            "generativelanguage.googleapis.com exposes only inference and storage. Rate limits, " +
            "token consumption and spend are visible in AI Studio and in the Google Cloud console " +
            "for the project behind the key. The only cost signal in the API itself is the " +
            "per-response usageMetadata token count.",
        },
        {
          kind: "link" as const,
          label: "Open Google AI Studio",
          url: "https://aistudio.google.com/app/apikey",
        },
        {
          kind: "link" as const,
          label: "Rate limits and tiers",
          url: "https://ai.google.dev/gemini-api/docs/rate-limits",
        },
      ],
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const methods = String(fields["supportedGenerationMethods"] ?? "");
    const modelId = resource.externalId ?? "";
    const isTtsModel = modelId.includes("-tts");

    return {
      title: resource.displayName,
      subtitle: `Gemini Model · ${modelId}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Model ID", value: modelId, copyable: true },
                { key: "Resource Name", value: String(fields["name"] ?? "—"), copyable: true },
                { key: "Version", value: String(fields["version"] || "—") },
                { key: "Base Model", value: String(fields["baseModelId"] || "—") },
                { key: "Description", value: String(fields["descriptionText"] || "—") },
                { key: "Thinking", value: fields["thinking"] === true ? "Yes" : "No" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Limits",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Input Token Limit",
                  value: formatTokens(Number(fields["inputTokenLimit"] ?? 0)),
                },
                {
                  key: "Output Token Limit",
                  value: formatTokens(Number(fields["outputTokenLimit"] ?? 0)),
                },
                { key: "Supported Generation Methods", value: methods || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Sampling Defaults",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Temperature", value: String(fields["temperature"] ?? "—") },
                { key: "Max Temperature", value: String(fields["maxTemperature"] ?? "—") },
                { key: "Top P", value: String(fields["topP"] ?? "—") },
                { key: "Top K", value: String(fields["topK"] ?? "—") },
              ],
            },
          ],
        },
        this.quotaSection(),
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "API reference",
          action: { type: "open-url", url: "https://ai.google.dev/api/models" },
        },
      ],
      speechPanel: {
        modes: ["tts", "stt"],
        subtitle: isTtsModel
          ? "Synthesize speech with this TTS model, or transcribe a clip"
          : "Synthesize speech, or transcribe a clip with a Gemini model",
        helpText: SPEECH_HELP_TEXT,
        voices: GEMINI_VOICES,
        defaultVoice: DEFAULT_VOICE,
        voiceLabel: "Voice",
        // Gemini's TTS models are a distinct, small set addressed through the
        // Interactions API; the STT half accepts any multimodal model. The
        // single shared picker lists both, TTS models first, so whichever half
        // the user runs has a sensible selection.
        models: this.speechModelOptions(resource),
        defaultModel: isTtsModel ? modelId : DEFAULT_TTS_MODEL,
        languages: TTS_LANGUAGES,
        defaultLanguage: "",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        maxAudioBytes: MAX_INLINE_AUDIO_BYTES,
        maxCharacters: 5000,
        synthesizeLabel: "Synthesize",
        transcribeLabel: "Transcribe",
      },
    };
  }

  private renderTunedModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Gemini Tuned Model · ${shortName(String(fields["baseModel"] || "")) || "unknown base"}`,
      status: { kind: "status-dot", status: tunedModelStatusDot(state) },
      sections: [
        {
          kind: "section",
          title: "Tuned Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Resource Name", value: String(fields["name"] ?? "—"), copyable: true },
                { key: "State", value: state || "—" },
                { key: "Base Model", value: String(fields["baseModel"] || "—") },
                ...(fields["sourceTunedModel"]
                  ? [{ key: "Tuned From", value: String(fields["sourceTunedModel"]) }]
                  : []),
                { key: "Description", value: String(fields["descriptionText"] || "—") },
                { key: "Created", value: String(fields["createTime"] || "—") },
                { key: "Updated", value: String(fields["updateTime"] || "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Tuning Task",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Started", value: String(fields["tuningStartTime"] || "—") },
                { key: "Completed", value: String(fields["tuningCompleteTime"] || "—") },
                { key: "Epochs", value: String(fields["epochCount"] || "—") },
                { key: "Batch Size", value: String(fields["batchSize"] || "—") },
                { key: "Learning Rate", value: String(fields["learningRate"] || "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Inference Defaults",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Temperature", value: String(fields["temperature"] ?? "—") },
                { key: "Top P", value: String(fields["topP"] ?? "—") },
                { key: "Top K", value: String(fields["topK"] ?? "—") },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");
    const error = String(fields["errorMessage"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Gemini File · ${String(fields["mimeType"] || "unknown type")}`,
      status: { kind: "status-dot", status: fileStatusDot(state) },
      sections: [
        {
          kind: "section",
          title: "File",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Resource Name", value: String(fields["name"] ?? "—"), copyable: true },
                { key: "URI", value: String(fields["uri"] || "—"), copyable: true },
                { key: "MIME Type", value: String(fields["mimeType"] || "—") },
                { key: "Size", value: formatBytes(Number(fields["sizeBytes"] ?? 0)) },
                { key: "State", value: state || "—" },
                { key: "Source", value: String(fields["source"] || "—") },
                { key: "SHA-256", value: String(fields["sha256Hash"] || "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Lifetime",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(fields["createTime"] || "—") },
                { key: "Updated", value: String(fields["updateTime"] || "—") },
                { key: "Expires", value: String(fields["expirationTime"] || "—") },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "The Files API deletes uploads automatically 48 hours after they are created. " +
                "Storage is capped at 20 GB per project and 2 GB per file.",
            },
          ],
        },
        ...(error
          ? [
              {
                kind: "section" as const,
                title: "Error",
                children: [{ kind: "text" as const, variant: "mono" as const, content: error }],
              },
            ]
          : []),
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderCachedContentDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;

    return {
      title: resource.displayName,
      subtitle: `Gemini Context Cache · ${shortName(String(fields["model"] || "")) || "unknown model"}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Cache",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Resource Name", value: String(fields["name"] ?? "—"), copyable: true },
                { key: "Model", value: String(fields["model"] || "—") },
                {
                  key: "Cached Tokens",
                  value: formatTokens(Number(fields["totalTokenCount"] ?? 0)),
                },
                { key: "TTL", value: String(fields["ttl"] || "—") },
                { key: "Expires", value: String(fields["expireTime"] || "—") },
                { key: "Created", value: String(fields["createTime"] || "—") },
                { key: "Updated", value: String(fields["updateTime"] || "—") },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Cached tokens are billed at a reduced rate on every request that references this " +
                "cache. Expiry is the only property the API lets you change after creation — edit " +
                'the ttl (for example "3600s") to extend or shorten it.',
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderBatchDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");
    const cancellable = state === "BATCH_STATE_PENDING" || state === "BATCH_STATE_RUNNING";
    const error = String(fields["errorMessage"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Gemini Batch · ${shortName(String(fields["model"] || "")) || "unknown model"}`,
      status: { kind: "status-dot", status: batchStatusDot(state) },
      sections: [
        {
          kind: "section",
          title: "Batch",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Operation Name", value: String(fields["name"] ?? "—"), copyable: true },
                { key: "State", value: prettyBatchState(state) },
                { key: "Model", value: String(fields["model"] || "—") },
                { key: "Done", value: fields["done"] === true ? "Yes" : "No" },
                { key: "Created", value: String(fields["createTime"] || "—") },
                { key: "Updated", value: String(fields["updateTime"] || "—") },
                { key: "Ended", value: String(fields["endTime"] || "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Requests",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Total", value: String(fields["requestCount"] ?? 0) },
                { key: "Successful", value: String(fields["successfulRequestCount"] ?? 0) },
                { key: "Failed", value: String(fields["failedRequestCount"] ?? 0) },
                { key: "Pending", value: String(fields["pendingRequestCount"] ?? 0) },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Batch requests are billed at half the interactive rate, with a 24-hour target " +
                "turnaround.",
            },
          ],
        },
        ...(fields["outputFileName"]
          ? [
              {
                kind: "section" as const,
                title: "Output",
                children: [
                  {
                    kind: "key-value-list" as const,
                    items: [
                      {
                        key: "Results File",
                        value: String(fields["outputFileName"]),
                        copyable: true,
                      },
                    ],
                  },
                ],
              },
            ]
          : []),
        ...(error
          ? [
              {
                kind: "section" as const,
                title: "Error",
                children: [{ kind: "text" as const, variant: "mono" as const, content: error }],
              },
            ]
          : []),
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(cancellable
          ? [
              {
                kind: "action" as const,
                label: "Cancel batch",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this batch? Requests already completed stay billed; the rest are dropped.",
                  successMessage: "Batch cancelled.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderFileSearchStoreDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const failed = Number(fields["failedDocumentsCount"] ?? 0);
    const pending = Number(fields["pendingDocumentsCount"] ?? 0);

    return {
      title: resource.displayName,
      subtitle: "Gemini File Search Store",
      status: {
        kind: "status-dot",
        status: failed > 0 ? "degraded" : pending > 0 ? "provisioning" : "healthy",
      },
      sections: [
        {
          kind: "section",
          title: "Store",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Resource Name", value: String(fields["name"] ?? "—"), copyable: true },
                { key: "Embedding Model", value: String(fields["embeddingModel"] || "—") },
                { key: "Size", value: formatBytes(Number(fields["sizeBytes"] ?? 0)) },
                { key: "Created", value: String(fields["createTime"] || "—") },
                { key: "Updated", value: String(fields["updateTime"] || "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Documents",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Active", value: String(fields["activeDocumentsCount"] ?? 0) },
                { key: "Pending", value: String(fields["pendingDocumentsCount"] ?? 0) },
                { key: "Failed", value: String(fields["failedDocumentsCount"] ?? 0) },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Query this store by passing its resource name to the file_search tool on a " +
                "generateContent request. Deleting the store also deletes every document in it.",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFileSearchDocumentDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `File Search Document · ${String(fields["mimeType"] || "unknown type")}`,
      status: { kind: "status-dot", status: documentStatusDot(state) },
      sections: [
        {
          kind: "section",
          title: "Document",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Resource Name", value: String(fields["name"] ?? "—"), copyable: true },
                { key: "Store", value: String(fields["storeName"] || "—"), copyable: true },
                { key: "MIME Type", value: String(fields["mimeType"] || "—") },
                { key: "State", value: state || "—" },
                { key: "Size", value: formatBytes(Number(fields["sizeBytes"] ?? 0)) },
                { key: "Created", value: String(fields["createTime"] || "—") },
                { key: "Updated", value: String(fields["updateTime"] || "—") },
              ],
            },
          ],
        },
        ...(fields["customMetadata"]
          ? [
              {
                kind: "section" as const,
                title: "Custom Metadata",
                children: [
                  {
                    kind: "text" as const,
                    variant: "mono" as const,
                    copyable: true,
                    content: String(fields["customMetadata"]),
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;
    const label = resource.displayName;

    switch (resource.resourceTypeId) {
      case "file":
        return {
          id: resource.id,
          label,
          status: { kind: "status-dot", status: fileStatusDot(String(fields["state"] ?? "")) },
        };
      case "tuned-model":
        return {
          id: resource.id,
          label,
          status: {
            kind: "status-dot",
            status: tunedModelStatusDot(String(fields["state"] ?? "")),
          },
        };
      case "batch":
        return {
          id: resource.id,
          label,
          status: { kind: "status-dot", status: batchStatusDot(String(fields["state"] ?? "")) },
        };
      case "file-search-document":
        return {
          id: resource.id,
          label,
          status: { kind: "status-dot", status: documentStatusDot(String(fields["state"] ?? "")) },
        };
      case "file-search-store":
        return {
          id: resource.id,
          label,
          status: {
            kind: "status-dot",
            status: Number(fields["failedDocumentsCount"] ?? 0) > 0 ? "degraded" : "healthy",
          },
        };
      default:
        return { id: resource.id, label, status: { kind: "status-dot", status: "healthy" } };
    }
  }

  // ---------------------------------------------------------------------------
  // Speech tab
  // ---------------------------------------------------------------------------

  /**
   * The shared model picker: Gemini's three TTS models first, then whatever
   * multimodal models `getResource` found for the transcription half.
   */
  private speechModelOptions(resource: ResourceInstance): SpeechPanelOption[] {
    const stashed = resource.resolvedOutputs?.["__sttModels__"];
    let sttModels: SpeechPanelOption[] = [];
    if (typeof stashed === "string" && stashed.length > 0) {
      try {
        const parsed = JSON.parse(stashed) as SpeechPanelOption[];
        if (Array.isArray(parsed)) sttModels = parsed;
      } catch {
        /* fall through to the static default */
      }
    }
    if (sttModels.length === 0) {
      sttModels = [
        {
          id: DEFAULT_STT_MODEL,
          label: DEFAULT_STT_MODEL,
          description: "Transcription — audio understanding via generateContent",
        },
      ];
    }

    const ttsIds = new Set(TTS_MODELS.map((m) => m.id));
    return [...TTS_MODELS, ...sttModels.filter((m) => !ttsIds.has(m.id))];
  }

  /**
   * Models that can accept audio input: anything supporting `generateContent`
   * and not itself a TTS or embedding model. Reading this from the live list
   * means the picker keeps working as the model lineup rotates.
   */
  private async fetchAudioCapableModelOptions(): Promise<SpeechPanelOption[]> {
    const models = await this.fetchModels();
    return models
      .filter((m) => Boolean(m.name))
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .filter((m) => {
        const id = shortName(m.name!);
        return !id.includes("-tts") && !id.includes("embedding") && !id.includes("aqa");
      })
      .map<SpeechPanelOption>((m) => ({
        id: shortName(m.name!),
        label: m.displayName || shortName(m.name!),
        description: "Transcription",
      }));
  }

  /**
   * `POST /v1beta/interactions` —
   * https://ai.google.dev/gemini-api/docs/interactions/speech-generation
   *
   * ⚠️ Gemini TTS is documented through **Interactions**, not `generateContent`.
   * The body is `{ model, input, response_format: { type: "audio" },
   * generation_config: { speech_config: [{ voice }] } }` — note `speech_config`
   * is an array of speaker configs, not a single object.
   *
   * ⚠️ The reply carries base64 audio at `interaction.output_audio.data`, and
   * for the TTS models that is **raw headerless PCM at 24 000 Hz, mono,
   * 16-bit** — no container. A browser `<audio>` element cannot play that, so
   * the bytes are wrapped in a WAV header here and returned as `audio/wav`.
   * The response also reports `mime_type`, `sample_rate` and `channels`, which
   * are read at runtime: if Google ever starts returning a real container the
   * payload is passed straight through instead of being double-wrapped.
   */
  async synthesizeSpeech(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    const text = payload.text.trim();
    if (!text) throw new Error("Gemini plugin: nothing to synthesize");

    const model = ttsModelFor(payload.modelId);
    const voice = payload.voiceId || DEFAULT_VOICE;

    const response = await this.fetch<InteractionResponse>("/interactions", {
      method: "POST",
      body: JSON.stringify({
        model,
        input: text,
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice }] },
      }),
    });

    const audio = response.interaction?.output_audio;
    const base64 = audio?.data;
    if (!base64) {
      throw new Error(
        `Gemini plugin: ${model} returned no audio. TTS is only available on the *-tts models — ` +
          "pick one of gemini-3.1-flash-tts-preview, gemini-2.5-flash-preview-tts or " +
          "gemini-2.5-pro-preview-tts.",
      );
    }

    const reportedMime = (audio.mime_type ?? "").toLowerCase();
    const sampleRate = audio.sample_rate ?? GEMINI_PCM_SAMPLE_RATE;
    const channels = audio.channels ?? GEMINI_PCM_CHANNELS;
    const usage = response.interaction?.usage;

    // `audio/l16` is raw 16-bit linear PCM. Treat an unknown or missing type as
    // PCM too — that is what the TTS models actually emit, and it is what every
    // official sample assumes.
    const isContainer = CONTAINER_MIME_TYPES.has(reportedMime);

    if (isContainer) {
      return {
        audioBase64: base64,
        mimeType: reportedMime,
        fileName: `gemini-${voice.toLowerCase()}.${extensionForContainer(reportedMime)}`,
        summary: summariseSynthesis({ model, voice, text, usage, sampleRate, channels }),
        characters: text.length,
        ...(response.interaction?.id ? { requestId: response.interaction.id } : {}),
      };
    }

    const pcm = base64ToBytes(base64);
    const wav = pcmToWav(pcm, sampleRate, channels, GEMINI_PCM_BITS_PER_SAMPLE);

    return {
      audioBase64: bytesToBase64(wav),
      mimeType: "audio/wav",
      fileName: `gemini-${voice.toLowerCase()}.wav`,
      summary: summariseSynthesis({
        model,
        voice,
        text,
        usage,
        sampleRate,
        channels,
        durationSeconds:
          sampleRate === GEMINI_PCM_SAMPLE_RATE && channels === GEMINI_PCM_CHANNELS
            ? geminiPcmDurationSeconds(pcm.byteLength)
            : undefined,
      }),
      characters: text.length,
      ...(response.interaction?.id ? { requestId: response.interaction.id } : {}),
    };
  }

  /**
   * `POST /v1beta/models/{model}:generateContent` —
   * https://ai.google.dev/gemini-api/docs/audio
   *
   * Audio rides inline as base64 in an `inline_data` part alongside the
   * instruction text. Google documents WAV, MP3, AIFF, AAC, OGG and FLAC as
   * accepted; `audio/webm` and `audio/mp4` — what browsers actually record —
   * are not on that list, though Firebase AI Logic (the same endpoint behind a
   * client SDK) does list both. Rather than guess, the clip's real MIME type is
   * forwarded unchanged and an undocumented-format rejection is turned into an
   * error that explains the situation.
   */
  async transcribeAudio(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    const audio = base64ToBytes(payload.audioBase64);
    if (audio.byteLength === 0) throw new Error("Gemini plugin: the audio clip was empty");
    if (audio.byteLength > MAX_INLINE_AUDIO_BYTES) {
      throw new Error(
        `Gemini plugin: the clip is ${formatBytes(audio.byteLength)}. Inline requests are capped ` +
          "at 20 MB including base64 overhead, so upload larger audio through the Files API and " +
          "reference it with file_data instead.",
      );
    }

    const model = sttModelFor(payload.modelId);
    // Whatever the browser or file picker produced. Never transcode, never
    // assume wav/mp3.
    const mimeType = payload.mimeType || "audio/wav";

    let response: GenerateContentResponse;
    try {
      response = await this.fetch<GenerateContentResponse>(
        `/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    // The panel's language picker feeds `payload.language`
                    // (TranscribeAudioPayload carries it; SynthesizeSpeechPayload
                    // does not). Gemini has no language parameter on
                    // generateContent, so the only way to honour the choice is
                    // to name it in the instruction — otherwise the control is
                    // inert and the request goes out identical either way.
                    text: transcriptionPrompt(payload.language),
                  },
                  { inline_data: { mime_type: mimeType, data: payload.audioBase64 } },
                ],
              },
            ],
            generationConfig: { temperature: 0 },
          }),
        },
      );
    } catch (error) {
      throw enrichTranscriptionError(error, mimeType);
    }

    const text = (response.candidates ?? [])
      .flatMap((c) => c.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();

    const usage = response.usageMetadata;
    const summaryParts = [`Model ${model}`, formatBytes(audio.byteLength), mimeType];
    if (usage?.promptTokenCount) {
      summaryParts.push(`${usage.promptTokenCount} input tokens`);
      // Gemini bills 32 tokens per second of audio, so the prompt token count
      // gives a usable duration estimate even though the API reports none.
      const seconds = usage.promptTokenCount / AUDIO_TOKENS_PER_SECOND;
      if (seconds >= 1) summaryParts.push(`~${seconds.toFixed(1)}s of audio`);
    }

    return {
      text,
      summary: summaryParts.join(" · "),
      // Gemini's audio understanding returns prose, not a timed transcript —
      // no word timings, no confidence, no detected-language field — so those
      // stay unset rather than being invented.
      ...(response.responseId ? { requestId: response.responseId } : {}),
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** MIME types that already carry a container a browser can play. */
const CONTAINER_MIME_TYPES = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/m4a",
  "audio/opus",
]);

function extensionForContainer(mimeType: string): string {
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") return "mp3";
  if (mimeType === "audio/m4a") return "m4a";
  return mimeType.split("/")[1] ?? "audio";
}

/** Resource ids are `{accountId}:{typeId}:{externalId}`. */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/** `models/gemini-2.5-flash` → `gemini-2.5-flash`. */
function shortName(resourceName: string): string {
  const parts = resourceName.split("/");
  return parts[parts.length - 1] ?? resourceName;
}

/**
 * Only the `*-tts` models can synthesize. The shared model picker also lists
 * transcription models, so a user who leaves it on a chat model still gets
 * audio rather than a confusing empty response.
 */
function ttsModelFor(modelId: string | undefined): string {
  if (modelId && modelId.includes("-tts")) return modelId;
  return DEFAULT_TTS_MODEL;
}

/** Conversely, a TTS model cannot transcribe — fall back to a multimodal one. */
function sttModelFor(modelId: string | undefined): string {
  if (modelId && !modelId.includes("-tts")) return modelId;
  return DEFAULT_STT_MODEL;
}

function summariseSynthesis(args: {
  model: string;
  voice: string;
  text: string;
  usage?: { total_output_tokens?: number; total_tokens?: number } | undefined;
  sampleRate: number;
  channels: number;
  durationSeconds?: number | undefined;
}): string {
  const parts = [
    `${args.voice} · ${args.model}`,
    `${args.text.length} characters`,
    `${args.sampleRate} Hz ${args.channels === 1 ? "mono" : `${args.channels}ch`}`,
  ];
  if (args.durationSeconds !== undefined) parts.push(`${args.durationSeconds.toFixed(1)}s`);
  if (args.usage?.total_tokens) parts.push(`${args.usage.total_tokens} tokens`);
  return parts.join(" · ");
}

/**
 * Turn a 400 from an undocumented container into an explanation the user can
 * act on, rather than a raw INVALID_ARGUMENT.
 */
function enrichTranscriptionError(error: unknown, mimeType: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const undocumented = mimeType.startsWith("audio/webm") || mimeType.startsWith("audio/mp4");
  if (undocumented && /400|INVALID_ARGUMENT|unsupported/i.test(message)) {
    return new Error(
      `${message}\n\nGemini rejected ${mimeType}. Google documents WAV, MP3, AIFF, AAC, OGG and ` +
        "FLAC as accepted audio input, and that is what your browser's recorder does not produce " +
        "(WebM on Chrome, Edge and Firefox; MP4 on Safari). Upload a file in one of the six " +
        "documented formats instead.",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function formatTokens(tokens: number): string {
  if (!tokens) return "—";
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M tokens`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** `BATCH_STATE_SUCCEEDED` → `Succeeded`. */
function prettyBatchState(state: string): string {
  if (!state) return "—";
  return state
    .replace(/^BATCH_STATE_/, "")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

function batchStatusDot(state: string): ResourceStatus {
  switch (state) {
    case "BATCH_STATE_SUCCEEDED":
      return "healthy";
    case "BATCH_STATE_FAILED":
      return "error";
    case "BATCH_STATE_CANCELLED":
    case "BATCH_STATE_EXPIRED":
      return "degraded";
    case "BATCH_STATE_PENDING":
    case "BATCH_STATE_RUNNING":
      return "provisioning";
    default:
      return "info";
  }
}

/** Files use bare `PROCESSING | ACTIVE | FAILED`. */
function fileStatusDot(state: string): ResourceStatus {
  switch (state) {
    case "ACTIVE":
      return "healthy";
    case "FAILED":
      return "error";
    case "PROCESSING":
      return "provisioning";
    default:
      return "info";
  }
}

/** ⚠️ File Search documents use the `STATE_`-prefixed variant instead. */
function documentStatusDot(state: string): ResourceStatus {
  switch (state) {
    case "STATE_ACTIVE":
      return "healthy";
    case "STATE_FAILED":
      return "error";
    case "STATE_PENDING":
      return "provisioning";
    default:
      return "info";
  }
}

function tunedModelStatusDot(state: string): ResourceStatus {
  switch (state) {
    case "ACTIVE":
      return "healthy";
    case "FAILED":
      return "error";
    case "CREATING":
      return "provisioning";
    default:
      return "info";
  }
}

function keyValuesFrom(fields: Record<string, string | number | boolean>) {
  return Object.entries(fields).map(([key, value]) => ({ key, value: String(value) }));
}
