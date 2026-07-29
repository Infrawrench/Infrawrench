import type {
  CreateResourceConfig,
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
import { base64ToBytes, bytesToBase64, formatBytes, jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * OpenAI-compatible surface: models, batches, files, audio.
 * https://console.groq.com/docs/api-reference
 */
const OPENAI_BASE = "https://api.groq.com/openai/v1";

/**
 * Fine-tuning lives on a *different* base — no `/openai` segment.
 * https://console.groq.com/docs/lora
 */
const ROOT_BASE = "https://api.groq.com/v1";

/** Groq's console — there is no usage or billing API to read instead. */
const USAGE_CONSOLE_URL = "https://console.groq.com/dashboard/usage";

/**
 * `GET /openai/v1/audio/transcriptions` limits, verified against
 * https://console.groq.com/docs/speech-to-text (July 2026):
 * 25 MB on the free tier, 100 MB on the dev tier. We advertise the smaller
 * one so the host never lets a free-tier key upload something that 413s.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Orpheus caps `input` at 200 characters per request.
 * https://console.groq.com/docs/text-to-speech/orpheus
 */
const MAX_TTS_CHARACTERS = 200;

/**
 * Fallbacks used only when the live model list hasn't been stashed on the
 * resource yet (cold cache, offline render, contract tests). The live list
 * from `GET /openai/v1/models` always wins — Groq deprecates models on a
 * rolling schedule and a stale constant would offer a model that 404s.
 */
const FALLBACK_STT_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];
const FALLBACK_TTS_MODELS = ["canopylabs/orpheus-v1-english", "canopylabs/orpheus-arabic-saudi"];

const ORPHEUS_ENGLISH_MODEL = "canopylabs/orpheus-v1-english";
const ORPHEUS_ARABIC_MODEL = "canopylabs/orpheus-arabic-saudi";

/**
 * Orpheus voices, per https://console.groq.com/docs/text-to-speech/orpheus.
 * Voices are a property of the Orpheus checkpoints rather than of the
 * account, so unlike the model list there is nothing to list at runtime.
 */
const ORPHEUS_VOICES: Array<{ id: string; model: string; gender: string }> = [
  { id: "autumn", model: ORPHEUS_ENGLISH_MODEL, gender: "Female" },
  { id: "diana", model: ORPHEUS_ENGLISH_MODEL, gender: "Female" },
  { id: "hannah", model: ORPHEUS_ENGLISH_MODEL, gender: "Female" },
  { id: "austin", model: ORPHEUS_ENGLISH_MODEL, gender: "Male" },
  { id: "daniel", model: ORPHEUS_ENGLISH_MODEL, gender: "Male" },
  { id: "troy", model: ORPHEUS_ENGLISH_MODEL, gender: "Male" },
  { id: "abdullah", model: ORPHEUS_ARABIC_MODEL, gender: "Male" },
  { id: "fahad", model: ORPHEUS_ARABIC_MODEL, gender: "Male" },
  { id: "sultan", model: ORPHEUS_ARABIC_MODEL, gender: "Male" },
  { id: "lulwa", model: ORPHEUS_ARABIC_MODEL, gender: "Female" },
  { id: "noura", model: ORPHEUS_ARABIC_MODEL, gender: "Female" },
  { id: "aisha", model: ORPHEUS_ARABIC_MODEL, gender: "Female" },
];

const DEFAULT_VOICE = "hannah";

/**
 * Whisper's language menu. Groq accepts ISO-639-1 codes; auto-detect is the
 * default when the field is left off entirely.
 */
const STT_LANGUAGES: SpeechPanelOption[] = [
  { id: "", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "pl", label: "Polish" },
  { id: "ru", label: "Russian" },
  { id: "tr", label: "Turkish" },
  { id: "ar", label: "Arabic" },
  { id: "hi", label: "Hindi" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
];

/** MIME type of a browser recording → the extension Groq's uploader expects. */
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

interface GroqModel {
  id?: string;
  object?: string;
  created?: number;
  owned_by?: string;
  active?: boolean;
  context_window?: number;
  max_completion_tokens?: number;
}

interface GroqBatch {
  id?: string;
  status?: string;
  endpoint?: string;
  input_file_id?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  completion_window?: string;
  request_counts?: { total?: number; completed?: number; failed?: number };
  created_at?: number;
  expires_at?: number;
  completed_at?: number | null;
}

interface GroqFile {
  id?: string;
  bytes?: number;
  created_at?: number;
  filename?: string;
  purpose?: string;
}

interface GroqFineTuning {
  id?: string;
  name?: string;
  type?: string;
  base_model?: string;
  fine_tuned_model?: string;
  status?: string;
  input_file_id?: string;
  created_at?: number;
}

interface GroqTranscription {
  text?: string;
  language?: string;
  duration?: number;
  x_groq?: { id?: string };
  words?: Array<{ word?: string; start?: number; end?: number }>;
  segments?: Array<{
    text?: string;
    start?: number;
    end?: number;
    avg_logprob?: number;
    no_speech_prob?: number;
  }>;
}

/** Shape stashed under `__audioModels__` by `getResource`. */
interface AudioModelStash {
  stt: string[];
  tts: string[];
}

function isSttModel(id: string): boolean {
  return /whisper|transcribe/i.test(id);
}

function isTtsModel(id: string): boolean {
  return /orpheus|(^|[-/])tts([-/]|$)/i.test(id);
}

function modality(id: string): string {
  if (isSttModel(id)) return "Transcription";
  if (isTtsModel(id)) return "Speech";
  if (/guard|prompt-guard/i.test(id)) return "Moderation";
  return "Chat";
}

function epochToIso(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString();
}

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return AUDIO_EXTENSIONS[base] ?? "webm";
}

/**
 * GroqCloud plugin client.
 *
 * Covers the model catalogue, batch jobs, uploaded files, registered LoRA
 * adapters, and the Speech playground (Whisper transcription + Orpheus
 * synthesis). Groq publishes no usage, cost, or API-key management API — the
 * console is the only surface for those, and the detail views say so rather
 * than rendering an empty chart.
 */
export class GroqClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Groq plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** JSON calls against the OpenAI-compatible base. */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return this.fetchAt(OPENAI_BASE, path, options);
  }

  /**
   * JSON calls against the root base. Only fine-tuning lives here — Groq's
   * LoRA registry is *not* under `/openai`, so a single-base client would
   * silently 404 on every fine-tuning call.
   * https://console.groq.com/docs/lora
   */
  private async rootFetch<T>(path: string, options?: RequestInit): Promise<T> {
    return this.fetchAt(ROOT_BASE, path, options);
  }

  private async fetchAt<T>(base: string, path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Groq",
      url: `${base}${path}`,
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

  // ---------------------------------------------------------------- listing

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "groq-model":
        return this.listModels(accountId);
      case "groq-batch":
        return this.listBatches(accountId);
      case "groq-file":
        return this.listFiles(accountId);
      case "groq-fine-tuning":
        return this.listFineTunings(accountId);
      default:
        throw new Error(`Groq plugin: unknown resource type "${typeId}"`);
    }
  }

  /** https://console.groq.com/docs/api-reference — `GET /openai/v1/models` */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ data?: GroqModel[] }>("/models");
    const now = new Date().toISOString();
    return (data.data ?? [])
      .filter((m) => Boolean(m.id))
      .map((m) => this.mapModel(accountId, m, now));
  }

  private mapModel(accountId: string, model: GroqModel, now: string): ResourceInstance {
    const id = String(model.id ?? "");
    return {
      id: `${accountId}:groq-model:${id}`,
      pluginId: "groq",
      resourceTypeId: "groq-model",
      accountId,
      displayName: id,
      externalId: id,
      fields: {
        modelId: id,
        ownedBy: model.owned_by ?? "",
        modality: modality(id),
        contextWindow: model.context_window ?? 0,
        maxCompletionTokens: model.max_completion_tokens ?? 0,
        active: model.active ?? true,
        created: epochToIso(model.created),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(model.created) || now,
      updatedAt: now,
    };
  }

  /** https://console.groq.com/docs/api-reference — `GET /openai/v1/batches` */
  private async listBatches(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ data?: GroqBatch[] }>("/batches");
    const now = new Date().toISOString();
    return (data.data ?? [])
      .filter((b) => Boolean(b.id))
      .map((b) => this.mapBatch(accountId, b, now));
  }

  private mapBatch(accountId: string, batch: GroqBatch, now: string): ResourceInstance {
    const id = String(batch.id ?? "");
    return {
      id: `${accountId}:groq-batch:${id}`,
      pluginId: "groq",
      resourceTypeId: "groq-batch",
      accountId,
      displayName: id,
      externalId: id,
      fields: {
        batchId: id,
        status: batch.status ?? "",
        endpoint: batch.endpoint ?? "",
        completionWindow: batch.completion_window ?? "",
        inputFileId: batch.input_file_id ?? "",
        outputFileId: batch.output_file_id ?? "",
        errorFileId: batch.error_file_id ?? "",
        totalRequests: batch.request_counts?.total ?? 0,
        completedRequests: batch.request_counts?.completed ?? 0,
        failedRequests: batch.request_counts?.failed ?? 0,
        createdAt: epochToIso(batch.created_at),
        expiresAt: epochToIso(batch.expires_at),
        completedAt: epochToIso(batch.completed_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(batch.created_at) || now,
      updatedAt: now,
    };
  }

  /** https://console.groq.com/docs/api-reference — `GET /openai/v1/files` */
  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ data?: GroqFile[] }>("/files");
    const now = new Date().toISOString();
    return (data.data ?? [])
      .filter((x) => Boolean(x.id))
      .map((x) => this.mapFile(accountId, x, now));
  }

  private mapFile(accountId: string, file: GroqFile, now: string): ResourceInstance {
    const id = String(file.id ?? "");
    return {
      id: `${accountId}:groq-file:${id}`,
      pluginId: "groq",
      resourceTypeId: "groq-file",
      accountId,
      displayName: file.filename || id,
      externalId: id,
      fields: {
        fileId: id,
        filename: file.filename ?? "",
        purpose: file.purpose ?? "",
        bytes: file.bytes ?? 0,
        createdAt: epochToIso(file.created_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(file.created_at) || now,
      updatedAt: now,
    };
  }

  /** https://console.groq.com/docs/lora — `GET https://api.groq.com/v1/fine_tunings` */
  private async listFineTunings(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.rootFetch<{ data?: GroqFineTuning[] }>("/fine_tunings");
    const now = new Date().toISOString();
    return (data.data ?? [])
      .filter((x) => Boolean(x.id))
      .map((x) => this.mapFineTuning(accountId, x, now));
  }

  private mapFineTuning(accountId: string, tuning: GroqFineTuning, now: string): ResourceInstance {
    const id = String(tuning.id ?? "");
    return {
      id: `${accountId}:groq-fine-tuning:${id}`,
      pluginId: "groq",
      resourceTypeId: "groq-fine-tuning",
      accountId,
      displayName: tuning.name || id,
      externalId: id,
      fields: {
        fineTuningId: id,
        name: tuning.name ?? "",
        type: tuning.type ?? "",
        baseModel: tuning.base_model ?? "",
        fineTunedModel: tuning.fine_tuned_model ?? "",
        status: tuning.status ?? "",
        inputFileId: tuning.input_file_id ?? "",
        createdAt: epochToIso(tuning.created_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: epochToIso(tuning.created_at) || now,
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
    if (!found) throw new Error(`Groq plugin: resource ${typeId}/${resourceId} not found`);

    if (typeId === "groq-model") {
      // `renderDetail` is synchronous but the Speech tab's model pickers have
      // to reflect Groq's live catalogue (models are deprecated on a rolling
      // schedule). Stash the audio subset here and parse it back in the
      // renderer — same trick the Cloudflare queue plugin uses for
      // `__consumers__`.
      const stash: AudioModelStash = { stt: [], tts: [] };
      for (const resource of all) {
        const id = String(resource.fields["modelId"] ?? "");
        if (!id) continue;
        if (isSttModel(id)) stash.stt.push(id);
        else if (isTtsModel(id)) stash.tts.push(id);
      }
      found.resolvedOutputs = {
        ...found.resolvedOutputs,
        __audioModels__: JSON.stringify(stash),
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
    if (outputKey === "baseUrl") return OPENAI_BASE;
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.fields[outputKey];
    return value === undefined || value === null ? "" : String(value);
  }

  // --------------------------------------------------------------- mutation

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "groq-fine-tuning") {
      throw new Error(`Groq plugin: ${typeId} cannot be created through the API`);
    }

    // Both pickers are populated from live calls — the user never has to know
    // a file id or type out a base-model slug.
    const [files, models] = await Promise.all([
      this.fetch<{ data?: GroqFile[] }>("/files").catch(() => ({ data: [] as GroqFile[] })),
      this.fetch<{ data?: GroqModel[] }>("/models").catch(() => ({ data: [] as GroqModel[] })),
    ]);

    const fileOptions = (files.data ?? [])
      .filter((file) => Boolean(file.id))
      .map((file) => ({ id: String(file.id), label: file.filename || String(file.id) }));

    // Only a subset of chat models accept LoRA adapters; Groq's self-serve
    // tier is `llama-3.1-8b-instant`. Offer what the account can actually see
    // rather than a constant that a deprecation would invalidate.
    const baseOptions = (models.data ?? [])
      .map((m) => String(m.id ?? ""))
      .filter((id) => id && !isSttModel(id) && !isTtsModel(id))
      .map((id) => ({ id, label: id }));

    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          placeholder: "my-lora-adapter",
          description: "Shown in the Groq console and used to build the inference model id.",
        },
        {
          key: "inputFileId",
          label: "Adapter File",
          kind: "select",
          required: true,
          options: fileOptions,
          description:
            fileOptions.length > 0
              ? "The uploaded LoRA adapter archive to register."
              : "No files uploaded yet — upload the adapter archive to Groq first.",
        },
        {
          key: "baseModel",
          label: "Base Model",
          kind: "select",
          required: true,
          options: baseOptions,
          defaultValue:
            baseOptions.find((option) => option.id === "llama-3.1-8b-instant")?.id ??
            baseOptions[0]?.id ??
            "",
          description:
            "The model the adapter was trained against. Self-serve LoRA currently covers llama-3.1-8b-instant.",
        },
      ],
    };
  }

  /** https://console.groq.com/docs/lora — `POST https://api.groq.com/v1/fine_tunings` */
  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "groq-fine-tuning") {
      throw new Error(`Groq plugin: ${typeId} cannot be created through the API`);
    }
    const name = fields["name"];
    const inputFileId = fields["inputFileId"];
    const baseModel = fields["baseModel"];
    if (!name) throw new Error("Groq plugin: missing fine-tuning name");
    if (!inputFileId) throw new Error("Groq plugin: missing adapter file");
    if (!baseModel) throw new Error("Groq plugin: missing base model");

    const created = await this.rootFetch<{ data?: GroqFineTuning } & GroqFineTuning>(
      "/fine_tunings",
      {
        method: "POST",
        body: JSON.stringify({
          input_file_id: inputFileId,
          name,
          type: "lora",
          base_model: baseModel,
        }),
      },
    );

    // The create response nests the record under `data`; list/get return it flat.
    const record: GroqFineTuning = created.data ?? created;
    return this.mapFineTuning(accountId, record, new Date().toISOString());
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const externalId = resourceId.slice(`${accountId}:${typeId}:`.length);
    if (!externalId) throw new Error(`Groq plugin: cannot parse resource id "${resourceId}"`);

    switch (typeId) {
      // https://console.groq.com/docs/api-reference — `DELETE /openai/v1/files/{file_id}`
      case "groq-file":
        await this.fetch<unknown>(`/files/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      // https://console.groq.com/docs/lora — `DELETE /v1/fine_tunings/{id}`
      case "groq-fine-tuning":
        await this.rootFetch<unknown>(`/fine_tunings/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      default:
        throw new Error(`Groq plugin: ${typeId} does not support delete`);
    }
  }

  /** https://console.groq.com/docs/api-reference — `POST /openai/v1/batches/{id}/cancel` */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "groq-batch" && actionId === "cancel") {
      const batchId = resourceId.slice(`${accountId}:${typeId}:`.length);
      await this.fetch<unknown>(`/batches/${encodeURIComponent(batchId)}/cancel`, {
        method: "POST",
      });
      return;
    }
    throw new Error(`Groq plugin: unknown action "${actionId}" for ${typeId}`);
  }

  // ------------------------------------------------------------------ audio

  /**
   * Text-to-speech.
   * https://console.groq.com/docs/text-to-speech — `POST /openai/v1/audio/speech`
   *
   * Returns **raw audio bytes**, not JSON, so this deliberately bypasses
   * `jsonRestFetch` (which would try to `JSON.parse` a WAV file) and with it
   * bastion egress routing. Orpheus only emits WAV; there is no mp3 option to
   * ask for, and browsers play WAV natively.
   */
  async synthesizeSpeech(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    const text = payload.text.trim();
    if (!text) throw new Error("Groq plugin: nothing to synthesize");
    if (text.length > MAX_TTS_CHARACTERS) {
      throw new Error(
        `Groq plugin: Orpheus accepts at most ${MAX_TTS_CHARACTERS} characters per request (got ${text.length})`,
      );
    }

    const voice = payload.voiceId || DEFAULT_VOICE;
    // The voice implies its checkpoint — an Arabic voice on the English model
    // is a 400. Prefer the voice's own model over whatever the shared model
    // dropdown happened to be showing.
    const voiceModel = ORPHEUS_VOICES.find((v) => v.id === voice)?.model;
    const selected = payload.modelId && isTtsModel(payload.modelId) ? payload.modelId : undefined;
    const model = voiceModel ?? selected ?? ORPHEUS_ENGLISH_MODEL;

    const started = Date.now();
    const response = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input: text, voice, response_format: "wav" }),
    });
    if (!response.ok) {
      throw new Error(
        `Groq API error ${response.status} for /audio/speech: ${await response.text()}`,
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const elapsedMs = Date.now() - started;
    const requestId = response.headers.get("x-request-id") ?? undefined;

    return {
      audioBase64: bytesToBase64(bytes),
      mimeType: "audio/wav",
      fileName: `groq-${voice}.wav`,
      summary: `${model} · ${voice} · ${text.length} characters · ${formatBytes(bytes.byteLength)} · ${elapsedMs} ms`,
      characters: text.length,
      ...(requestId ? { requestId } : {}),
    };
  }

  /**
   * Speech-to-text.
   * https://console.groq.com/docs/speech-to-text — `POST /openai/v1/audio/transcriptions`
   *
   * Multipart, so this goes through global `fetch` with a real `FormData`:
   * `jsonRestFetch`'s host-http path stringifies `FormData` rather than
   * encoding it, which would post the literal text "[object FormData]".
   * The trade-off is that this call bypasses bastion egress routing.
   */
  async transcribeAudio(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    const model =
      payload.modelId && isSttModel(payload.modelId)
        ? payload.modelId
        : (FALLBACK_STT_MODELS[0] as string);

    const buffer = base64ToBytes(payload.audioBase64);
    if (buffer.byteLength === 0) throw new Error("Groq plugin: empty audio clip");
    if (buffer.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(
        `Groq plugin: clip is ${formatBytes(buffer.byteLength)}, over the ${formatBytes(MAX_AUDIO_BYTES)} free-tier limit`,
      );
    }

    // Forward whatever MediaRecorder produced (webm/opus on Chromium, mp4 on
    // Safari) verbatim — Groq accepts both and transcoding here would only
    // lose fidelity.
    const fileName = payload.fileName || `clip.${extensionFor(payload.mimeType)}`;
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: payload.mimeType }), fileName);
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (payload.language) form.append("language", payload.language);

    const started = Date.now();
    const response = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      throw new Error(
        `Groq API error ${response.status} for /audio/transcriptions: ${await response.text()}`,
      );
    }

    const result = (await response.json()) as GroqTranscription;
    const elapsedMs = Date.now() - started;

    const words: TranscriptWord[] = (result.words ?? []).map((word) => ({
      text: String(word.word ?? ""),
      ...(typeof word.start === "number" ? { start: word.start } : {}),
      ...(typeof word.end === "number" ? { end: word.end } : {}),
    }));
    if (words.length === 0) {
      for (const segment of result.segments ?? []) {
        words.push({
          text: String(segment.text ?? "").trim(),
          ...(typeof segment.start === "number" ? { start: segment.start } : {}),
          ...(typeof segment.end === "number" ? { end: segment.end } : {}),
        });
      }
    }

    // `avg_logprob` is a mean log-probability per segment; exponentiating it
    // gives a 0..1 figure comparable to what other providers call confidence.
    const logProbs = (result.segments ?? [])
      .map((segment) => segment.avg_logprob)
      .filter((value): value is number => typeof value === "number");
    const confidence =
      logProbs.length > 0
        ? Math.exp(logProbs.reduce((sum, value) => sum + value, 0) / logProbs.length)
        : undefined;

    const duration = typeof result.duration === "number" ? result.duration : undefined;
    const billed = duration !== undefined ? Math.max(duration, 10) : undefined;
    const summaryParts = [model];
    if (duration !== undefined) summaryParts.push(`${duration.toFixed(1)} s of audio`);
    if (billed !== undefined && duration !== undefined && billed > duration) {
      summaryParts.push("billed as 10 s (Groq's minimum)");
    }
    summaryParts.push(`${elapsedMs} ms`);

    return {
      text: String(result.text ?? ""),
      summary: summaryParts.join(" · "),
      ...(result.language ? { language: String(result.language) } : {}),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(words.length > 0 ? { words } : {}),
      ...(result.x_groq?.id ? { requestId: String(result.x_groq.id) } : {}),
    };
  }

  // ----------------------------------------------------------------- render

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const status = String(resource.fields["status"] ?? "");
    return {
      id: resource.id,
      label: resource.displayName,
      status: {
        kind: "status-dot",
        status:
          resource.resourceTypeId === "groq-model"
            ? resource.fields["active"] === false
              ? "degraded"
              : "healthy"
            : batchStatusDot(status),
      },
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "groq-model":
        return this.renderModelDetail(resource);
      case "groq-batch":
        return this.renderBatchDetail(resource);
      case "groq-file":
        return this.renderFileDetail(resource);
      case "groq-fine-tuning":
        return this.renderFineTuningDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: "Groq",
          sections: [],
        };
    }
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const modelId = String(resource.fields["modelId"] ?? resource.displayName);
    const kind = String(resource.fields["modality"] ?? modality(modelId));
    const contextWindow = Number(resource.fields["contextWindow"] ?? 0);
    const maxCompletion = Number(resource.fields["maxCompletionTokens"] ?? 0);

    const stash = parseAudioStash(resource.resolvedOutputs["__audioModels__"]);
    const sttModels = stash?.stt.length ? stash.stt : FALLBACK_STT_MODELS;
    const ttsModels = stash?.tts.length ? stash.tts : FALLBACK_TTS_MODELS;

    const speechModels: SpeechPanelOption[] = [
      ...sttModels.map((id) => ({
        id,
        label: id,
        description: "Transcription (Whisper)",
      })),
      ...ttsModels.map((id) => ({
        id,
        label: id,
        description: `Speech synthesis (Orpheus${id === ORPHEUS_ARABIC_MODEL ? ", Arabic" : ""})`,
      })),
    ];

    const defaultModel = speechModels.some((option) => option.id === modelId)
      ? modelId
      : (sttModels[0] ?? FALLBACK_STT_MODELS[0] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Groq Model · ${kind}`,
      status: {
        kind: "status-dot",
        status: resource.fields["active"] === false ? "degraded" : "healthy",
        label: resource.fields["active"] === false ? "Inactive" : "Active",
      },
      sections: [
        {
          kind: "section",
          title: "Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Model ID", value: modelId },
                { key: "Modality", value: kind },
                { key: "Owned By", value: String(resource.fields["ownedBy"] ?? "—") || "—" },
                {
                  key: "Context Window",
                  value: contextWindow > 0 ? `${contextWindow.toLocaleString()} tokens` : "—",
                },
                {
                  key: "Max Completion Tokens",
                  value: maxCompletion > 0 ? maxCompletion.toLocaleString() : "—",
                },
                { key: "Created", value: String(resource.fields["created"] ?? "—") || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Endpoint",
          children: [
            {
              kind: "text",
              variant: "mono",
              copyable: true,
              content: `${OPENAI_BASE}/chat/completions`,
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Groq exposes no usage, cost, or API-key management API — spend and rate-limit history live only in the Groq console.",
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Usage in console",
          action: { type: "open-url", url: USAGE_CONSOLE_URL },
        },
      ],
      speechPanel: {
        modes: ["tts", "stt"],
        subtitle: "Whisper transcription and Orpheus synthesis on GroqCloud",
        helpText:
          "Groq bills a minimum of 10 seconds per transcription request, so a 2-second clip still costs 10 seconds. Files with several audio tracks are transcribed from the first track only. Synthesis is capped at 200 characters per request and returns WAV.",
        models: speechModels,
        defaultModel,
        modelLabel: "Model",
        voices: ORPHEUS_VOICES.map((voice) => ({
          id: voice.id,
          label: voice.id.charAt(0).toUpperCase() + voice.id.slice(1),
          description: `${voice.gender} · ${voice.model === ORPHEUS_ARABIC_MODEL ? "Arabic (Saudi)" : "English"}`,
        })),
        defaultVoice: DEFAULT_VOICE,
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
          ".mpeg",
          ".mpga",
          ".m4a",
          ".ogg",
          ".wav",
          ".webm",
        ],
      },
    };
  }

  private renderBatchDetail(resource: ResourceInstance): DetailViewSchema {
    const status = String(resource.fields["status"] ?? "");
    const total = Number(resource.fields["totalRequests"] ?? 0);
    const completed = Number(resource.fields["completedRequests"] ?? 0);
    const failed = Number(resource.fields["failedRequests"] ?? 0);
    const cancellable = ["validating", "in_progress", "finalizing"].includes(status);

    return {
      title: resource.displayName,
      subtitle: `Groq Batch · ${String(resource.fields["endpoint"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: batchStatusDot(status),
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
                { key: "Total Requests", value: total.toLocaleString() },
                { key: "Completed", value: completed.toLocaleString() },
                { key: "Failed", value: failed.toLocaleString() },
                {
                  key: "Completion Window",
                  value: String(resource.fields["completionWindow"] ?? "—") || "—",
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
                { key: "Input", value: String(resource.fields["inputFileId"] ?? "—") || "—" },
                { key: "Output", value: String(resource.fields["outputFileId"] ?? "—") || "—" },
                { key: "Errors", value: String(resource.fields["errorFileId"] ?? "—") || "—" },
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
                { key: "Expires", value: String(resource.fields["expiresAt"] ?? "—") || "—" },
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
                label: "Cancel batch",
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this batch? Requests already completed are still billed and remain in the output file.",
                  successMessage: "Batch cancellation requested.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const bytes = Number(resource.fields["bytes"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: `Groq File · ${String(resource.fields["purpose"] ?? "")}`,
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
                { key: "Size", value: bytes > 0 ? formatBytes(bytes) : "—" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFineTuningDetail(resource: ResourceInstance): DetailViewSchema {
    const fineTuned = String(resource.fields["fineTunedModel"] ?? "");
    return {
      title: resource.displayName,
      subtitle: `Groq LoRA Adapter · ${String(resource.fields["baseModel"] ?? "")}`,
      status: {
        kind: "status-dot",
        status: fineTuningStatusDot(String(resource.fields["status"] ?? "")),
        ...(resource.fields["status"] ? { label: String(resource.fields["status"]) } : {}),
      },
      sections: [
        {
          kind: "section",
          title: "Adapter",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(resource.fields["name"] ?? "—") || "—" },
                { key: "Type", value: String(resource.fields["type"] ?? "—") || "—" },
                { key: "Base Model", value: String(resource.fields["baseModel"] ?? "—") || "—" },
                { key: "Status", value: String(resource.fields["status"] ?? "—") || "—" },
                { key: "Input File", value: String(resource.fields["inputFileId"] ?? "—") || "—" },
                { key: "Created", value: String(resource.fields["createdAt"] ?? "—") || "—" },
              ],
            },
          ],
        },
        ...(fineTuned
          ? [
              {
                kind: "section" as const,
                title: "Inference",
                children: [
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content: "Pass this id as `model` on chat completions to use the adapter.",
                  },
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
}

function parseAudioStash(raw: string | undefined): AudioModelStash | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<AudioModelStash>;
    return {
      stt: Array.isArray(parsed.stt) ? parsed.stt.map(String) : [],
      tts: Array.isArray(parsed.tts) ? parsed.tts.map(String) : [],
    };
  } catch {
    return undefined;
  }
}

function batchStatusDot(
  status: string,
): "healthy" | "degraded" | "error" | "provisioning" | "info" | "unknown" {
  switch (status) {
    case "completed":
      return "healthy";
    case "failed":
    case "expired":
      return "error";
    case "cancelled":
    case "cancelling":
      return "degraded";
    case "validating":
    case "in_progress":
    case "finalizing":
      return "provisioning";
    default:
      return "info";
  }
}

function fineTuningStatusDot(
  status: string,
): "healthy" | "degraded" | "error" | "provisioning" | "info" {
  switch (status.toLowerCase()) {
    case "succeeded":
    case "ready":
    case "active":
      return "healthy";
    case "failed":
      return "error";
    case "cancelled":
      return "degraded";
    case "pending":
    case "running":
    case "queued":
      return "provisioning";
    default:
      return "info";
  }
}
