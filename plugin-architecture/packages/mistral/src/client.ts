import type {
  CostFetchRange,
  CostRow,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import {
  CostSetupError,
  base64ToBytes,
  formatBytes,
  jsonRestFetch,
} from "@infrawrench/plugin-base";

/** Data plane. `Authorization: Bearer <apiKey>`. https://docs.mistral.ai/api */
const BASE = "https://api.mistral.ai/v1";

/**
 * Admin plane — a *different* base and a *different* header. Mistral's own
 * docs are inconsistent about whether it wants `x-api-key` (the Admin API
 * overview) or a bearer token (the endpoint reference), so we send both and
 * let the server pick.
 *
 * Enterprise plans only; on every other plan these calls 401/403 and the
 * plugin degrades to hiding the admin-backed sections.
 * https://docs.mistral.ai/admin/admin-api/overview
 */
const ADMIN_BASE = "https://api.mistral.ai/v1/admin";

/**
 * Transcription accepts recordings up to three hours per request, but the
 * Speech tab round-trips audio base64-encoded through ordinary JSON, so cap
 * uploads at the host's default 25 MB rather than advertising the API ceiling.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** No documented per-request character cap; this keeps one round trip sane. */
const MAX_TTS_CHARACTERS = 4000;

/**
 * Used only when the live `GET /v1/models` catalogue hasn't been stashed on
 * the resource yet. Mistral's docs disagree on the TTS slug — the speech
 * endpoint's own example posts `voxtral-mini-tts-2603` while the model
 * overview table lists `voxtral-tts-2603` — so the live list always wins and
 * these are a last resort.
 */
const FALLBACK_STT_MODEL = "voxtral-mini-latest";
const FALLBACK_TTS_MODEL = "voxtral-mini-tts-2603";

const STT_LANGUAGES: SpeechPanelOption[] = [
  { id: "", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "es", label: "Spanish" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "ar", label: "Arabic" },
  { id: "hi", label: "Hindi" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
  { id: "ru", label: "Russian" },
];

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
};

interface MistralModel {
  id?: string;
  name?: string;
  description?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  max_context_length?: number;
  aliases?: string[];
  archived?: boolean;
  job?: string | null;
  type?: string;
  capabilities?: Record<string, boolean>;
}

interface MistralVoice {
  id?: string;
  name?: string;
  slug?: string | null;
  created_at?: string;
  user_id?: string | null;
  age?: number | null;
  gender?: string | null;
  description?: string | null;
  languages?: string[];
  tags?: string[] | null;
}

interface MistralFile {
  id?: string;
  object?: string;
  bytes?: number;
  created_at?: number;
  filename?: string;
  purpose?: string;
  sample_type?: string;
  source?: string;
  num_lines?: number | null;
  mimetype?: string | null;
}

interface MistralFineTuningJob {
  id?: string;
  name?: string | null;
  model?: string;
  fine_tuned_model?: string | null;
  status?: string;
  job_type?: string;
  suffix?: string | null;
  auto_start?: boolean;
  training_files?: Array<string | { file_id?: string }>;
  validation_files?: string[];
  trained_tokens?: number | null;
  created_at?: number;
  modified_at?: number;
}

interface MistralBatchJob {
  id?: string;
  status?: string;
  endpoint?: string;
  model?: string | null;
  input_files?: string[];
  output_file?: string | null;
  error_file?: string | null;
  total_requests?: number;
  completed_requests?: number;
  succeeded_requests?: number;
  failed_requests?: number;
  created_at?: number;
  started_at?: number | null;
  completed_at?: number | null;
}

interface MistralApiKey {
  key_id?: string;
  name?: string | null;
  hidden_key?: string;
  created_at?: string;
  created_by?: string | null;
  last_used?: string | null;
  expiration_date?: string | null;
  product?: string | null;
  workspace_id?: string | null;
  workspace_name?: string | null;
}

interface MistralTranscription {
  text?: string;
  model?: string;
  language?: string;
  usage?: { audio_seconds?: number; prompt_tokens?: number; total_tokens?: number };
  segments?: Array<{
    text?: string;
    start?: number;
    end?: number;
    speaker?: string | number | null;
  }>;
  words?: Array<{ word?: string; text?: string; start?: number; end?: number; speaker?: string }>;
}

/** Stashed under `__voices__` / `__audioModels__` for the synchronous renderer. */
interface VoiceStash {
  id: string;
  name: string;
  gender: string;
  languages: string[];
  description: string;
}

interface AudioModelStash {
  stt: string[];
  tts: string[];
}

function epochToIso(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return AUDIO_EXTENSIONS[base] ?? "webm";
}

function isTtsModel(id: string): boolean {
  return /tts/i.test(id);
}

function isSttModel(id: string): boolean {
  return /voxtral/i.test(id) && !isTtsModel(id);
}

/**
 * Mistral plugin client.
 *
 * Two credentials, two planes: the workspace API key drives models, files,
 * fine-tuning, batches, and audio; the optional Enterprise admin key unlocks
 * API-key management and the usage/cost report. Everything admin-backed
 * degrades to an empty listing when the admin key is absent rather than
 * failing the sync.
 *
 * Pagination is deliberately not factored into one helper — Mistral genuinely
 * uses three schemes (`limit`/`offset` for admin keys and voices' request
 * side, `page`/`page_size` for files, batches and fine-tuning, and nothing at
 * all for `/models`).
 */
export class MistralClient implements PluginClient {
  private readonly apiKey: string;
  private readonly adminApiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Mistral plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.adminApiKey = credentials["adminApiKey"] ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private get hasAdmin(): boolean {
    return this.adminApiKey.length > 0;
  }

  /** Data-plane JSON call. */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Mistral",
      url: `${BASE}${path}`,
      errorPath: path,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  /** Admin-plane JSON call — different base, different header, Enterprise-only. */
  private async adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
    if (!this.hasAdmin) {
      throw new Error(
        "Mistral plugin: this call needs an Admin API key (Enterprise plans only). Add one to the account to enable it.",
      );
    }
    return jsonRestFetch<T>({
      vendor: "Mistral",
      url: `${ADMIN_BASE}${path}`,
      errorPath: `/admin${path}`,
      headers: {
        "x-api-key": this.adminApiKey,
        Authorization: `Bearer ${this.adminApiKey}`,
        Accept: "application/json",
      },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  // ---------------------------------------------------------------- listing

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "mistral-model":
        return this.listModels(accountId);
      case "mistral-voice":
        return this.listVoices(accountId);
      case "mistral-file":
        return this.listFiles(accountId);
      case "mistral-fine-tuning-job":
        return this.listFineTuningJobs(accountId);
      case "mistral-batch-job":
        return this.listBatchJobs(accountId);
      case "mistral-api-key":
        return this.listApiKeys(accountId);
      default:
        throw new Error(`Mistral plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * https://docs.mistral.ai/api/endpoint/models — `GET /v1/models`.
   * No pagination parameters exist on this endpoint; the whole catalogue
   * comes back in one response.
   */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ data?: MistralModel[] }>("/models");
    const now = new Date().toISOString();
    return (data.data ?? [])
      .filter((m) => Boolean(m.id))
      .map((m) => this.mapModel(accountId, m, now));
  }

  private mapModel(accountId: string, model: MistralModel, now: string): ResourceInstance {
    const id = String(model.id ?? "");
    const capabilities = model.capabilities ?? {};
    return {
      id: `${accountId}:mistral-model:${id}`,
      pluginId: "mistral",
      resourceTypeId: "mistral-model",
      accountId,
      displayName: model.name || id,
      externalId: id,
      fields: {
        modelId: id,
        name: model.name ?? "",
        type: model.type ?? "",
        ownedBy: model.owned_by ?? "",
        maxContextLength: model.max_context_length ?? 0,
        // Kept as JSON so the detail view can render the full flag table
        // rather than a lossy summary string.
        capabilities: JSON.stringify(capabilities),
        aliases: (model.aliases ?? []).join(", "),
        archived: model.archived ?? false,
        job: model.job ?? "",
        created: epochToIso(model.created),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(model.created) || now,
      updatedAt: now,
    };
  }

  /**
   * https://docs.mistral.ai/api/endpoint/audio/voices — `GET /v1/audio/voices`.
   * Request side takes `limit`/`offset`; the envelope reports
   * `page`/`page_size`/`total`/`total_pages`.
   */
  private async listVoices(accountId: string): Promise<ResourceInstance[]> {
    const raw = await this.fetchAllVoices();
    const now = new Date().toISOString();
    return raw.filter((v) => Boolean(v.id)).map((v) => this.mapVoice(accountId, v, now));
  }

  private async fetchAllVoices(): Promise<MistralVoice[]> {
    const pageSize = 100;
    const out: MistralVoice[] = [];
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      const page = await this.fetch<{ items?: MistralVoice[]; total?: number }>(
        `/audio/voices?limit=${pageSize}&offset=${offset}&type=all`,
      );
      const items = page.items ?? [];
      out.push(...items);
      if (items.length < pageSize) break;
      if (typeof page.total === "number" && out.length >= page.total) break;
    }
    return out;
  }

  private mapVoice(accountId: string, voice: MistralVoice, now: string): ResourceInstance {
    const id = String(voice.id ?? "");
    return {
      id: `${accountId}:mistral-voice:${id}`,
      pluginId: "mistral",
      resourceTypeId: "mistral-voice",
      accountId,
      displayName: voice.name || id,
      externalId: id,
      fields: {
        voiceId: id,
        name: voice.name ?? "",
        slug: voice.slug ?? "",
        gender: voice.gender ?? "",
        age: voice.age ?? 0,
        languages: (voice.languages ?? []).join(", "),
        description: voice.description ?? "",
        tags: (voice.tags ?? []).join(", "),
        // Presets have no owning user; clones do. That's also what decides
        // whether DELETE is allowed upstream.
        custom: Boolean(voice.user_id),
        createdAt: voice.created_at ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: voice.created_at ?? now,
      updatedAt: now,
    };
  }

  /** https://docs.mistral.ai/api/endpoint/files — `GET /v1/files` (`page`/`page_size`). */
  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const pageSize = 100;
    const out: MistralFile[] = [];
    for (let page = 0; page < 100; page += 1) {
      const body = await this.fetch<{ data?: MistralFile[] }>(
        `/files?page=${page}&page_size=${pageSize}`,
      );
      const items = body.data ?? [];
      out.push(...items);
      if (items.length < pageSize) break;
    }
    const now = new Date().toISOString();
    return out.filter((x) => Boolean(x.id)).map((x) => this.mapFile(accountId, x, now));
  }

  private mapFile(accountId: string, file: MistralFile, now: string): ResourceInstance {
    const id = String(file.id ?? "");
    return {
      id: `${accountId}:mistral-file:${id}`,
      pluginId: "mistral",
      resourceTypeId: "mistral-file",
      accountId,
      displayName: file.filename || id,
      externalId: id,
      fields: {
        fileId: id,
        filename: file.filename ?? "",
        purpose: file.purpose ?? "",
        sampleType: file.sample_type ?? "",
        source: file.source ?? "",
        bytes: file.bytes ?? 0,
        numLines: file.num_lines ?? 0,
        mimetype: file.mimetype ?? "",
        createdAt: epochToIso(file.created_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(file.created_at) || now,
      updatedAt: now,
    };
  }

  /** `GET /v1/fine_tuning/jobs` (`page`/`page_size`). */
  private async listFineTuningJobs(accountId: string): Promise<ResourceInstance[]> {
    const pageSize = 100;
    const out: MistralFineTuningJob[] = [];
    for (let page = 0; page < 100; page += 1) {
      const body = await this.fetch<{ data?: MistralFineTuningJob[] }>(
        `/fine_tuning/jobs?page=${page}&page_size=${pageSize}`,
      );
      const items = body.data ?? [];
      out.push(...items);
      if (items.length < pageSize) break;
    }
    const now = new Date().toISOString();
    return out.filter((x) => Boolean(x.id)).map((x) => this.mapFineTuningJob(accountId, x, now));
  }

  private mapFineTuningJob(
    accountId: string,
    job: MistralFineTuningJob,
    now: string,
  ): ResourceInstance {
    const id = String(job.id ?? "");
    // `training_files` is a list of ids in older responses and a list of
    // `{file_id}` objects in newer ones.
    const trainingFiles = (job.training_files ?? []).map((entry) =>
      typeof entry === "string" ? entry : (entry.file_id ?? ""),
    );
    return {
      id: `${accountId}:mistral-fine-tuning-job:${id}`,
      pluginId: "mistral",
      resourceTypeId: "mistral-fine-tuning-job",
      accountId,
      displayName: job.name || job.fine_tuned_model || id,
      externalId: id,
      fields: {
        jobId: id,
        name: job.name ?? "",
        model: job.model ?? "",
        fineTunedModel: job.fine_tuned_model ?? "",
        status: job.status ?? "",
        jobType: job.job_type ?? "",
        suffix: job.suffix ?? "",
        trainingFiles: trainingFiles.filter(Boolean).join(", "),
        validationFiles: (job.validation_files ?? []).join(", "),
        trainedTokens: job.trained_tokens ?? 0,
        autoStart: job.auto_start ?? false,
        createdAt: epochToIso(job.created_at),
        modifiedAt: epochToIso(job.modified_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(job.created_at) || now,
      updatedAt: now,
    };
  }

  /** https://docs.mistral.ai/api/endpoint/batch — `GET /v1/batch/jobs` (`page`/`page_size`). */
  private async listBatchJobs(accountId: string): Promise<ResourceInstance[]> {
    const pageSize = 100;
    const out: MistralBatchJob[] = [];
    for (let page = 0; page < 100; page += 1) {
      const body = await this.fetch<{ data?: MistralBatchJob[] }>(
        `/batch/jobs?page=${page}&page_size=${pageSize}`,
      );
      const items = body.data ?? [];
      out.push(...items);
      if (items.length < pageSize) break;
    }
    const now = new Date().toISOString();
    return out.filter((x) => Boolean(x.id)).map((x) => this.mapBatchJob(accountId, x, now));
  }

  private mapBatchJob(accountId: string, job: MistralBatchJob, now: string): ResourceInstance {
    const id = String(job.id ?? "");
    return {
      id: `${accountId}:mistral-batch-job:${id}`,
      pluginId: "mistral",
      resourceTypeId: "mistral-batch-job",
      accountId,
      displayName: id,
      externalId: id,
      fields: {
        jobId: id,
        status: job.status ?? "",
        endpoint: job.endpoint ?? "",
        model: job.model ?? "",
        inputFiles: (job.input_files ?? []).join(", "),
        outputFile: job.output_file ?? "",
        errorFile: job.error_file ?? "",
        totalRequests: job.total_requests ?? 0,
        completedRequests: job.completed_requests ?? 0,
        succeededRequests: job.succeeded_requests ?? 0,
        failedRequests: job.failed_requests ?? 0,
        createdAt: epochToIso(job.created_at),
        startedAt: epochToIso(job.started_at),
        completedAt: epochToIso(job.completed_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(job.created_at) || now,
      updatedAt: now,
    };
  }

  /**
   * https://docs.mistral.ai/api/endpoint/beta/admin/api-keys —
   * `GET /v1/admin/api-keys` (`limit`/`offset`).
   *
   * Enterprise-only. Without an admin key this returns nothing rather than
   * throwing, so a sync on a Pro account still succeeds for everything else.
   */
  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    if (!this.hasAdmin) return [];
    const limit = 100;
    const out: MistralApiKey[] = [];
    for (let offset = 0; offset < 10_000; offset += limit) {
      const body = await this.adminFetch<{ keys?: MistralApiKey[] } | MistralApiKey[]>(
        `/api-keys?limit=${limit}&offset=${offset}`,
      );
      const items = Array.isArray(body) ? body : (body.keys ?? []);
      out.push(...items);
      if (items.length < limit) break;
    }
    const now = new Date().toISOString();
    return out.filter((k) => Boolean(k.key_id)).map((k) => this.mapApiKey(accountId, k, now));
  }

  private mapApiKey(accountId: string, key: MistralApiKey, now: string): ResourceInstance {
    const id = String(key.key_id ?? "");
    return {
      id: `${accountId}:mistral-api-key:${id}`,
      pluginId: "mistral",
      resourceTypeId: "mistral-api-key",
      accountId,
      displayName: key.name || key.hidden_key || id,
      externalId: id,
      fields: {
        keyId: id,
        name: key.name ?? "",
        hiddenKey: key.hidden_key ?? "",
        workspaceName: key.workspace_name ?? "",
        workspaceId: key.workspace_id ?? "",
        product: key.product ?? "",
        createdBy: key.created_by ?? "",
        createdAt: key.created_at ?? "",
        lastUsed: key.last_used ?? "",
        expirationDate: key.expiration_date ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: key.created_at ?? now,
      updatedAt: now,
    };
  }

  // ------------------------------------------------------------------- get

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Mistral plugin: resource ${typeId}/${resourceId} not found`);

    if (typeId === "mistral-voice" || typeId === "mistral-model") {
      // `renderDetail` is synchronous, but the Speech tab's pickers need the
      // live voice catalogue and the live audio-model list. Fetch them here
      // and stash them as JSON under `__`-prefixed keys, then parse them back
      // in the renderer — the same trick the Cloudflare queue plugin uses for
      // `__consumers__`.
      const [voices, models] = await Promise.all([
        this.fetchAllVoices().catch(() => [] as MistralVoice[]),
        this.fetch<{ data?: MistralModel[] }>("/models").catch(() => ({
          data: [] as MistralModel[],
        })),
      ]);

      const voiceStash: VoiceStash[] = voices
        .filter((voice) => Boolean(voice.id))
        .map((voice) => ({
          id: String(voice.id),
          name: voice.name ?? String(voice.id),
          gender: voice.gender ?? "",
          languages: voice.languages ?? [],
          description: voice.description ?? "",
        }));

      const modelStash: AudioModelStash = { stt: [], tts: [] };
      for (const model of models.data ?? []) {
        const id = String(model.id ?? "");
        if (!id) continue;
        if (isTtsModel(id)) modelStash.tts.push(id);
        else if (isSttModel(id)) modelStash.stt.push(id);
      }

      found.resolvedOutputs = {
        ...found.resolvedOutputs,
        __voices__: JSON.stringify(voiceStash),
        __audioModels__: JSON.stringify(modelStash),
      };
    }

    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "baseUrl") return BASE;
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.fields[outputKey];
    return value === undefined || value === null ? "" : String(value);
  }

  // --------------------------------------------------------------- mutation

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "mistral-voice") {
      throw new Error(`Mistral plugin: ${typeId} does not support edit`);
    }
    const voiceId = resourceId.slice(`${accountId}:${typeId}:`.length);

    // https://docs.mistral.ai/api/endpoint/audio/voices — PATCH /v1/audio/voices/{voice_id}
    const body: Record<string, unknown> = {};
    if (fields["name"] !== undefined) body["name"] = fields["name"];
    if (fields["gender"] !== undefined) body["gender"] = fields["gender"];
    if (fields["description"] !== undefined) body["description"] = fields["description"];
    if (fields["age"] !== undefined) body["age"] = Number(fields["age"]) || null;
    if (fields["languages"] !== undefined) {
      body["languages"] = splitList(fields["languages"]);
    }
    if (fields["tags"] !== undefined) body["tags"] = splitList(fields["tags"]);

    const updated = await this.fetch<MistralVoice>(`/audio/voices/${encodeURIComponent(voiceId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return this.mapVoice(accountId, updated, new Date().toISOString());
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const externalId = resourceId.slice(`${accountId}:${typeId}:`.length);
    if (!externalId) throw new Error(`Mistral plugin: cannot parse resource id "${resourceId}"`);

    switch (typeId) {
      // https://docs.mistral.ai/api/endpoint/files — DELETE /v1/files/{file_id}
      case "mistral-file":
        await this.fetch<unknown>(`/files/${encodeURIComponent(externalId)}`, { method: "DELETE" });
        return;
      // https://docs.mistral.ai/api/endpoint/batch — DELETE /v1/batch/jobs/{job_id}
      case "mistral-batch-job":
        await this.fetch<unknown>(`/batch/jobs/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      // https://docs.mistral.ai/api/endpoint/audio/voices — DELETE /v1/audio/voices/{voice_id}
      // Only workspace clones can be removed; presets belong to Mistral.
      case "mistral-voice":
        await this.fetch<unknown>(`/audio/voices/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      // Admin plane — DELETE /v1/admin/api-keys/{key_id}
      case "mistral-api-key":
        await this.adminFetch<unknown>(`/api-keys/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      default:
        throw new Error(`Mistral plugin: ${typeId} does not support delete`);
    }
  }

  /** https://docs.mistral.ai/api/endpoint/batch — `POST /v1/batch/jobs/{job_id}/cancel` */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "mistral-batch-job" && actionId === "cancel") {
      const jobId = resourceId.slice(`${accountId}:${typeId}:`.length);
      await this.fetch<unknown>(`/batch/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
      });
      return;
    }
    throw new Error(`Mistral plugin: unknown action "${actionId}" for ${typeId}`);
  }

  // ------------------------------------------------------------------ costs

  /**
   * https://docs.mistral.ai/api/endpoint/beta/admin/billing —
   * `GET /v1/admin/usage?month=&year=`.
   *
   * Monthly granularity with a per-service breakdown (chat, completion, ocr,
   * audio, audio_characters, fine_tuning, connectors, libraries_api), so rows
   * are period-native and the manifest says so.
   *
   * **Every row is dated to the *first* day of its month, and the chunk only
   * reports months whose first day it contains.** Both halves matter, and the
   * date has to be a fixed point in the period rather than a moving one.
   *
   * The endpoint returns the *running* total of a month, so an in-progress
   * month is re-fetched on every collection. Dating those re-fetches to
   * anything that moves — the month end clamped into the requested range, say —
   * files month-to-date-through-the-15th on the 15th, month-to-date-through-the
   * -16th on the 16th, and so on: each collection lands on a **new** key
   * instead of replacing the previous one, and summing the month yields the sum
   * of its own prefixes (roughly 15× the true figure by mid-month). The host
   * only re-fetches a trailing window, so those earlier days are never restated
   * and the inflation is permanent. A stable date makes every collection of a
   * month write the same key, which is what makes the ReplacingMergeTree behind
   * `cost_daily` *replace* rather than accumulate.
   *
   * The period start is that stable point, and it is what the other
   * period-native plugins use (Scaleway's billing period, PlanetScale's
   * `billing_period_start`, Cloudflare's charge-period start). Skipping months
   * whose first day falls outside the chunk keeps re-fetches exactly-once
   * across the host's month-aligned chunks — and it is why the manifest asks
   * for a restatement window wide enough to always contain the 1st (see
   * `plugin.ts`).
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (!this.hasAdmin) {
      throw new CostSetupError(
        "Mistral reports usage and spend only through its Admin API, which is available on Enterprise plans. Add an Admin API key to this account to collect costs.",
        { label: "Mistral Admin API", url: "https://docs.mistral.ai/admin/admin-api/overview" },
      );
    }

    const rows: CostRow[] = [];
    for (const { year, month, date } of monthStartsInRange(range)) {
      const body = await this.adminFetch<Record<string, unknown>>(
        `/usage?year=${year}&month=${month}`,
      );
      const currency = typeof body["currency"] === "string" ? (body["currency"] as string) : "USD";

      for (const [service, value] of Object.entries(body)) {
        const amount = costOf(value);
        if (amount === undefined || amount === 0) continue;
        rows.push({ date, service, currency, amount });
      }
    }
    return rows;
  }

  // ------------------------------------------------------------------ audio

  /**
   * Text-to-speech.
   * https://docs.mistral.ai/studio-api/audio/text_to_speech/speech —
   * `POST /v1/audio/speech`
   *
   * The non-streaming response is **JSON with base64 audio in `audio_data`**,
   * not raw bytes — so unlike most providers this call can go through
   * `jsonRestFetch` and keep bastion routing. `response_format: "mp3"` is
   * requested explicitly so the browser's `<audio>` element can play it.
   */
  async synthesizeSpeech(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    const text = payload.text.trim();
    if (!text) throw new Error("Mistral plugin: nothing to synthesize");
    if (text.length > MAX_TTS_CHARACTERS) {
      throw new Error(
        `Mistral plugin: at most ${MAX_TTS_CHARACTERS} characters per request (got ${text.length})`,
      );
    }

    // When the Speech tab is opened from a voice, that voice *is* the subject —
    // fall back to it when no explicit selection came through.
    const voiceId = payload.voiceId || resourceId.split(":").slice(2).join(":");
    if (!voiceId) throw new Error("Mistral plugin: no voice selected");

    const model =
      payload.modelId && isTtsModel(payload.modelId) ? payload.modelId : FALLBACK_TTS_MODEL;

    const started = Date.now();
    const result = await this.fetch<{ audio_data?: string; model?: string; usage?: unknown }>(
      "/audio/speech",
      {
        method: "POST",
        body: JSON.stringify({
          model,
          input: text,
          voice_id: voiceId,
          response_format: "mp3",
          stream: false,
        }),
      },
    );

    const audioBase64 = String(result.audio_data ?? "");
    if (!audioBase64) throw new Error("Mistral plugin: /v1/audio/speech returned no audio_data");
    const bytes = base64ToBytes(audioBase64).byteLength;

    return {
      audioBase64,
      mimeType: "audio/mpeg",
      fileName: `mistral-${voiceId}.mp3`,
      summary: `${model} · ${voiceId} · ${text.length} characters · ${formatBytes(bytes)} · ${Date.now() - started} ms`,
      characters: text.length,
    };
  }

  /**
   * Speech-to-text.
   * https://docs.mistral.ai/api/endpoint/audio/transcriptions —
   * `POST /v1/audio/transcriptions`
   *
   * Multipart, so this uses global `fetch` with a real `FormData`:
   * `jsonRestFetch`'s host-http path stringifies `FormData` instead of
   * encoding it. The trade-off is that this call bypasses bastion routing.
   *
   * Diarisation is on, which is what lets `words` carry speaker labels.
   */
  async transcribeAudio(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    const model =
      payload.modelId && isSttModel(payload.modelId) ? payload.modelId : FALLBACK_STT_MODEL;

    const buffer = base64ToBytes(payload.audioBase64);
    if (buffer.byteLength === 0) throw new Error("Mistral plugin: empty audio clip");
    if (buffer.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(
        `Mistral plugin: clip is ${formatBytes(buffer.byteLength)}, over the ${formatBytes(MAX_AUDIO_BYTES)} limit`,
      );
    }

    // Forward MediaRecorder's own container (webm/opus on Chromium, mp4 on
    // Safari) rather than guessing or transcoding.
    const fileName = payload.fileName || `clip.${extensionFor(payload.mimeType)}`;
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: payload.mimeType }), fileName);
    form.append("model", model);
    form.append("diarize", "true");
    form.append("timestamp_granularities", "segment");
    form.append("timestamp_granularities", "word");
    if (payload.language) form.append("language", payload.language);

    const started = Date.now();
    const response = await fetch(`${BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      throw new Error(
        `Mistral API error ${response.status} for /audio/transcriptions: ${await response.text()}`,
      );
    }

    const result = (await response.json()) as MistralTranscription;
    const elapsedMs = Date.now() - started;

    const words: TranscriptWord[] = (result.words ?? []).map((word) => ({
      text: String(word.word ?? word.text ?? ""),
      ...(typeof word.start === "number" ? { start: word.start } : {}),
      ...(typeof word.end === "number" ? { end: word.end } : {}),
      ...(word.speaker ? { speaker: String(word.speaker) } : {}),
    }));
    if (words.length === 0) {
      for (const segment of result.segments ?? []) {
        words.push({
          text: String(segment.text ?? "").trim(),
          ...(typeof segment.start === "number" ? { start: segment.start } : {}),
          ...(typeof segment.end === "number" ? { end: segment.end } : {}),
          ...(segment.speaker !== null && segment.speaker !== undefined
            ? { speaker: `Speaker ${segment.speaker}` }
            : {}),
        });
      }
    }

    const speakers = new Set(words.map((word) => word.speaker).filter(Boolean));
    const duration = result.usage?.audio_seconds;
    const summaryParts = [result.model ?? model];
    if (typeof duration === "number") summaryParts.push(`${duration.toFixed(1)} s of audio`);
    if (speakers.size > 1) summaryParts.push(`${speakers.size} speakers`);
    summaryParts.push(`${elapsedMs} ms`);

    return {
      text: String(result.text ?? ""),
      summary: summaryParts.join(" · "),
      ...(result.language ? { language: String(result.language) } : {}),
      ...(typeof duration === "number" ? { durationSeconds: duration } : {}),
      ...(words.length > 0 ? { words } : {}),
    };
  }

  // ----------------------------------------------------------------- render

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status:
          resource.resourceTypeId === "mistral-batch-job" ||
          resource.resourceTypeId === "mistral-fine-tuning-job"
            ? jobStatusDot(String(resource.fields["status"] ?? ""))
            : resource.fields["archived"] === true
              ? "degraded"
              : "healthy",
      },
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "mistral-model":
        return this.renderModelDetail(resource);
      case "mistral-voice":
        return this.renderVoiceDetail(resource);
      case "mistral-file":
        return this.renderFileDetail(resource);
      case "mistral-fine-tuning-job":
        return this.renderFineTuningJobDetail(resource);
      case "mistral-batch-job":
        return this.renderBatchJobDetail(resource);
      case "mistral-api-key":
        return this.renderApiKeyDetail(resource);
      default:
        return { title: resource.displayName, subtitle: "Mistral", sections: [] };
    }
  }

  /**
   * Builds the Speech tab from whatever `getResource` stashed. Falls back to
   * a usable-but-minimal panel when the stash is missing (cold cache, offline
   * render, contract tests).
   */
  private speechPanel(resource: ResourceInstance, currentVoiceId?: string) {
    const voices = parseJson<VoiceStash[]>(resource.resolvedOutputs["__voices__"]) ?? [];
    const audio = parseJson<AudioModelStash>(resource.resolvedOutputs["__audioModels__"]);

    const sttModels = audio?.stt.length ? audio.stt : [FALLBACK_STT_MODEL];
    const ttsModels = audio?.tts.length ? audio.tts : [FALLBACK_TTS_MODEL];
    const models: SpeechPanelOption[] = [
      ...sttModels.map((id) => ({ id, label: id, description: "Transcription (Voxtral)" })),
      ...ttsModels.map((id) => ({ id, label: id, description: "Speech synthesis (Voxtral TTS)" })),
    ];

    const voiceOptions: SpeechPanelOption[] = voices.map((voice) => ({
      id: voice.id,
      label: voice.name,
      description:
        [voice.gender, voice.languages.join("/"), voice.description].filter(Boolean).join(" · ") ||
        voice.id,
    }));

    const modelId = String(resource.fields["modelId"] ?? "");
    const defaultModel = models.some((option) => option.id === modelId)
      ? modelId
      : (sttModels[0] ?? FALLBACK_STT_MODEL);

    const defaultVoice =
      currentVoiceId && voiceOptions.some((option) => option.id === currentVoiceId)
        ? currentVoiceId
        : (currentVoiceId ?? voiceOptions[0]?.id ?? "");

    return {
      modes: ["tts", "stt"] as Array<"tts" | "stt">,
      subtitle: "Voxtral transcription and speech synthesis",
      helpText:
        "Transcription runs with speaker diarisation on, so the word table carries speaker labels. Synthesis returns base64 mp3.",
      models,
      defaultModel,
      modelLabel: "Model",
      ...(voiceOptions.length > 0 ? { voices: voiceOptions } : {}),
      ...(defaultVoice ? { defaultVoice } : {}),
      languages: STT_LANGUAGES,
      defaultLanguage: "",
      maxCharacters: MAX_TTS_CHARACTERS,
      maxAudioBytes: MAX_AUDIO_BYTES,
      acceptedAudioTypes: [
        "audio/flac",
        "audio/mpeg",
        "audio/mp4",
        "audio/m4a",
        "audio/ogg",
        "audio/wav",
        "audio/webm",
        ".flac",
        ".mp3",
        ".mp4",
        ".m4a",
        ".ogg",
        ".wav",
        ".webm",
      ],
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const capabilities = parseJson<Record<string, boolean>>(
      String(resource.fields["capabilities"] ?? ""),
    );
    const contextLength = Number(resource.fields["maxContextLength"] ?? 0);

    return {
      title: resource.displayName,
      subtitle: `Mistral Model · ${String(resource.fields["type"] ?? "base")}`,
      status: {
        kind: "status-dot",
        status: resource.fields["archived"] === true ? "degraded" : "healthy",
        ...(resource.fields["archived"] === true ? { label: "Archived" } : {}),
      },
      sections: [
        {
          kind: "section",
          title: "Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Model ID", value: String(resource.fields["modelId"] ?? "—") || "—" },
                { key: "Type", value: String(resource.fields["type"] ?? "—") || "—" },
                { key: "Owned By", value: String(resource.fields["ownedBy"] ?? "—") || "—" },
                {
                  key: "Max Context Length",
                  value: contextLength > 0 ? `${contextLength.toLocaleString()} tokens` : "—",
                },
                { key: "Aliases", value: String(resource.fields["aliases"] ?? "—") || "—" },
                {
                  key: "Fine-Tuning Job",
                  value: String(resource.fields["job"] ?? "—") || "—",
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Capabilities",
          children: [
            capabilities && Object.keys(capabilities).length > 0
              ? {
                  kind: "table" as const,
                  emphasizeFirstColumn: true,
                  columns: [
                    { key: "capability", label: "Capability" },
                    { key: "supported", label: "Supported" },
                  ],
                  rows: Object.entries(capabilities).map(([key, on]) => ({
                    cells: {
                      capability: key.replace(/_/g, " "),
                      supported: on ? "Yes" : "No",
                    },
                  })),
                }
              : {
                  kind: "text" as const,
                  variant: "muted" as const,
                  content: "No capability flags reported for this model.",
                },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      speechPanel: this.speechPanel(resource),
    };
  }

  private renderVoiceDetail(resource: ResourceInstance): DetailViewSchema {
    const voiceId = String(resource.fields["voiceId"] ?? resource.externalId ?? "");
    const custom = resource.fields["custom"] === true;

    return {
      title: resource.displayName,
      subtitle: `Mistral Voice · ${custom ? "Workspace clone" : "Preset"}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Voice",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Voice ID", value: voiceId || "—" },
                { key: "Name", value: String(resource.fields["name"] ?? "—") || "—" },
                { key: "Slug", value: String(resource.fields["slug"] ?? "—") || "—" },
                { key: "Gender", value: String(resource.fields["gender"] ?? "—") || "—" },
                { key: "Languages", value: String(resource.fields["languages"] ?? "—") || "—" },
                { key: "Tags", value: String(resource.fields["tags"] ?? "—") || "—" },
                {
                  key: "Description",
                  value: String(resource.fields["description"] ?? "—") || "—",
                },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") || "—" },
              ],
            },
            ...(custom
              ? []
              : [
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content:
                      "Preset voices belong to Mistral — they can be used but not edited or deleted.",
                  },
                ]),
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      speechPanel: this.speechPanel(resource, voiceId),
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const bytes = Number(resource.fields["bytes"] ?? 0);
    const lines = Number(resource.fields["numLines"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: `Mistral File · ${String(resource.fields["purpose"] ?? "")}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "File",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "File ID", value: String(resource.fields["fileId"] ?? "—") || "—" },
                { key: "Filename", value: String(resource.fields["filename"] ?? "—") || "—" },
                { key: "Purpose", value: String(resource.fields["purpose"] ?? "—") || "—" },
                { key: "Sample Type", value: String(resource.fields["sampleType"] ?? "—") || "—" },
                { key: "Source", value: String(resource.fields["source"] ?? "—") || "—" },
                { key: "Size", value: bytes > 0 ? formatBytes(bytes) : "—" },
                { key: "Lines", value: lines > 0 ? lines.toLocaleString() : "—" },
                { key: "MIME Type", value: String(resource.fields["mimetype"] ?? "—") || "—" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFineTuningJobDetail(resource: ResourceInstance): DetailViewSchema {
    const status = String(resource.fields["status"] ?? "");
    const fineTuned = String(resource.fields["fineTunedModel"] ?? "");
    const trained = Number(resource.fields["trainedTokens"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: `Mistral Fine-Tuning · ${String(resource.fields["model"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: jobStatusDot(status),
        ...(status ? { label: status } : {}),
      },
      sections: [
        {
          kind: "section",
          title: "Job",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Job ID", value: String(resource.fields["jobId"] ?? "—") || "—" },
                { key: "Status", value: status || "—" },
                { key: "Base Model", value: String(resource.fields["model"] ?? "—") || "—" },
                { key: "Job Type", value: String(resource.fields["jobType"] ?? "—") || "—" },
                { key: "Suffix", value: String(resource.fields["suffix"] ?? "—") || "—" },
                { key: "Trained Tokens", value: trained > 0 ? trained.toLocaleString() : "—" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") || "—" },
                { key: "Modified", value: String(resource.fields["modifiedAt"] ?? "—") || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Datasets",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Training Files",
                  value: String(resource.fields["trainingFiles"] ?? "—") || "—",
                },
                {
                  key: "Validation Files",
                  value: String(resource.fields["validationFiles"] ?? "—") || "—",
                },
              ],
            },
          ],
        },
        ...(fineTuned
          ? [
              {
                kind: "section" as const,
                title: "Resulting Model",
                children: [
                  {
                    kind: "text" as const,
                    variant: "mono" as const,
                    copyable: true,
                    content: fineTuned,
                  },
                ],
              },
            ]
          : []),
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderBatchJobDetail(resource: ResourceInstance): DetailViewSchema {
    const status = String(resource.fields["status"] ?? "");
    const cancellable = ["QUEUED", "RUNNING"].includes(status.toUpperCase());
    return {
      title: resource.displayName,
      subtitle: `Mistral Batch · ${String(resource.fields["endpoint"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: jobStatusDot(status),
        ...(status ? { label: status } : {}),
      },
      sections: [
        {
          kind: "section",
          title: "Progress",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Status", value: status || "—" },
                { key: "Model", value: String(resource.fields["model"] ?? "—") || "—" },
                {
                  key: "Total Requests",
                  value: Number(resource.fields["totalRequests"] ?? 0).toLocaleString(),
                },
                {
                  key: "Succeeded",
                  value: Number(resource.fields["succeededRequests"] ?? 0).toLocaleString(),
                },
                {
                  key: "Failed",
                  value: Number(resource.fields["failedRequests"] ?? 0).toLocaleString(),
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Files",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Input", value: String(resource.fields["inputFiles"] ?? "—") || "—" },
                { key: "Output", value: String(resource.fields["outputFile"] ?? "—") || "—" },
                { key: "Errors", value: String(resource.fields["errorFile"] ?? "—") || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Timeline",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") || "—" },
                { key: "Started", value: String(resource.fields["startedAt"] ?? "—") || "—" },
                { key: "Completed", value: String(resource.fields["completedAt"] ?? "—") || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(cancellable
          ? [
              {
                kind: "action" as const,
                label: "Cancel job",
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this batch job? Requests already processed are still billed.",
                  successMessage: "Batch cancellation requested.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: `Mistral API Key · ${String(resource.fields["workspaceName"] ?? "organization")}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key ID", value: String(resource.fields["keyId"] ?? "—") || "—" },
                { key: "Name", value: String(resource.fields["name"] ?? "—") || "—" },
                { key: "Masked Key", value: String(resource.fields["hiddenKey"] ?? "—") || "—" },
                { key: "Workspace", value: String(resource.fields["workspaceName"] ?? "—") || "—" },
                { key: "Product", value: String(resource.fields["product"] ?? "—") || "—" },
                { key: "Created By", value: String(resource.fields["createdBy"] ?? "—") || "—" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") || "—" },
                { key: "Last Used", value: String(resource.fields["lastUsed"] ?? "—") || "—" },
                { key: "Expires", value: String(resource.fields["expirationDate"] ?? "—") || "—" },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Listed through the Enterprise-only Admin API. New keys are minted in the Mistral backoffice so the plaintext value is shown exactly once, at the source.",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Pull a money figure out of one branch of the usage response. Mistral returns
 * a mix of scalars and per-category objects, so this handles both without
 * assuming a fixed schema for every service key.
 */
function costOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["cost", "total_cost", "amount", "total"]) {
      const candidate = record[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The billing months whose **first day** falls inside the chunk, as the
 * `/admin/usage` query parameters plus the date their row is filed under.
 *
 * A month whose 1st is outside the range is not reported by this chunk at all —
 * some other chunk owns it — so a month is never fetched twice for one
 * collection and never lands on two different days.
 */
function monthStartsInRange(range: CostFetchRange): Array<{
  year: number;
  month: number;
  date: string;
}> {
  const out: Array<{ year: number; month: number; date: string }> = [];
  const start = new Date(`${range.fromDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return out;

  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  // The chunk may start mid-month; that month's 1st belongs to an earlier one.
  if (cursor.toISOString().slice(0, 10) < range.fromDate) {
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  // 60 months is well past the host's 365-day backfill; it just bounds the loop.
  for (let guard = 0; guard < 60; guard += 1) {
    const date = cursor.toISOString().slice(0, 10);
    if (date > range.toDate) break;
    out.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1, date });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function jobStatusDot(
  status: string,
): "healthy" | "degraded" | "error" | "provisioning" | "info" | "unknown" {
  switch (status.toUpperCase()) {
    case "SUCCESS":
    case "SUCCEEDED":
    case "DONE":
      return "healthy";
    case "FAILED":
    case "FAILED_VALIDATION":
    case "TIMEOUT_EXCEEDED":
      return "error";
    case "CANCELLED":
    case "CANCELLATION_REQUESTED":
      return "degraded";
    case "QUEUED":
    case "RUNNING":
    case "STARTED":
    case "VALIDATED":
      return "provisioning";
    default:
      return "info";
  }
}
