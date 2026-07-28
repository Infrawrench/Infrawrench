import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SidebarItemSchema,
  SpeechPanelOption,
  TableRow,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import { buildMultipartBody, type MultipartPart } from "./multipart.js";
import type {
  CheckApiKeyResponse,
  CohereBatch,
  CohereDataset,
  CohereEmbedJob,
  CohereFinetunedModel,
  CohereModel,
  DatasetUsageResponse,
  ListBatchesResponse,
  ListDatasetsResponse,
  ListEmbedJobsResponse,
  ListEventsResponse,
  ListFinetunedModelsResponse,
  ListModelsResponse,
  ListTrainingStepMetricsResponse,
  TranscriptionResponse,
} from "./api-types.js";

const BASE_URL = "https://api.cohere.com";

/**
 * The only transcription model Cohere ships.
 * https://docs.cohere.com/v2/docs/transcribe
 */
const TRANSCRIBE_MODEL = "cohere-transcribe-03-2026";

/** Cohere caps transcription uploads at 25 MB. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * The six container formats the transcription endpoint accepts, quoted from
 * the spec: "Supported file extensions are flac, mp3, mpeg, mpga, ogg, and
 * wav."
 *
 * ⚠️ Deliberately excludes `audio/webm` and `audio/mp4`. Those are exactly
 * what `MediaRecorder` produces (WebM/Opus on Chrome, Edge and Firefox; MP4 on
 * Safari) and Cohere rejects both — so the file picker is steered at the six
 * real formats, and the panel's help text tells the user not to bother
 * recording in the browser.
 */
const ACCEPTED_AUDIO_TYPES = [
  "audio/flac",
  "audio/mpeg",
  "audio/mp3",
  "audio/mpga",
  "audio/ogg",
  "audio/wav",
  ".flac",
  ".mp3",
  ".mpeg",
  ".mpga",
  ".ogg",
  ".wav",
];

/** Extension Cohere expects for each accepted container. */
const MIME_TO_EXTENSION: Record<string, string> = {
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mpga": "mpga",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
};

const ACCEPTED_EXTENSIONS = ["flac", "mp3", "mpeg", "mpga", "ogg", "wav"];

/**
 * The fourteen languages Cohere's transcription model documents, as ISO-639-1
 * codes. `language` is a **required** form field on the endpoint, so there is
 * no auto-detect entry — the panel always sends one of these.
 * https://docs.cohere.com/v2/docs/transcribe
 */
const LANGUAGES: SpeechPanelOption[] = [
  { id: "en", label: "English" },
  { id: "ar", label: "Arabic" },
  { id: "zh", label: "Chinese" },
  { id: "nl", label: "Dutch" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "el", label: "Greek" },
  { id: "it", label: "Italian" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "pl", label: "Polish" },
  { id: "pt", label: "Portuguese" },
  { id: "es", label: "Spanish" },
  { id: "vi", label: "Vietnamese" },
];

const SPEECH_HELP_TEXT =
  "Upload a clip up to 25 MB in FLAC, MP3, MPEG, MPGA, OGG or WAV. Cohere does not accept the " +
  "WebM your browser records on Chrome, Edge and Firefox, nor the MP4 Safari records, so " +
  "convert a recording before uploading rather than capturing one here. Language is required " +
  "by the API — pick the one spoken in the clip. Cohere returns plain text only, with no " +
  "word-level timings.";

/**
 * Cohere plugin client.
 *
 * Read-mostly by necessity: the platform exposes **no admin API, no usage or
 * billing API, and no key-management API**. `POST /v1/check-api-key` is the
 * only key-related endpoint in the product, and `GET /v1/datasets/usage`
 * (dataset storage bytes) is the only aggregate figure available — token spend
 * lives in the dashboard.
 */
export class CohereClient implements PluginClient {
  private readonly apiKey: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Cohere plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.services = services;
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Cohere",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        // Declared on every endpoint in Cohere's spec as "the name of the
        // project that is making the request". Their own SDKs set it.
        "X-Client-Name": "infrawrench",
      },
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Credential validation
  // ---------------------------------------------------------------------------

  /**
   * `POST /v1/check-api-key` — https://docs.cohere.com/reference/check-api-key
   *
   * The only key-related endpoint Cohere has: no list, no create, no rotate.
   * It takes an empty body and answers from the Authorization header alone.
   * (Cohere files it under "Deprecated" in their API index, but with no
   * announced shutdown date and no replacement.)
   */
  async checkApiKey(): Promise<CheckApiKeyResponse> {
    return this.fetch<CheckApiKeyResponse>("/v1/check-api-key", { method: "POST" });
  }

  async validateCredentials(): Promise<void> {
    const result = await this.checkApiKey();
    if (!result.valid) throw new Error("Cohere plugin: the API key was rejected as invalid");
  }

  // ---------------------------------------------------------------------------
  // Resource listing
  // ---------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return this.listModels(accountId);
      case "dataset":
        return this.listDatasets(accountId);
      case "finetuned-model":
        return this.listFinetunedModels(accountId);
      case "embed-job":
        return this.listEmbedJobs(accountId);
      case "batch":
        return this.listBatches(accountId);
      default:
        throw new Error(`Cohere plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const resource = await this.findResource(typeId, resourceId, accountId);

    // `renderDetail` is synchronous, so anything needing an extra API call is
    // fetched here and stashed in resolvedOutputs as JSON under a
    // __double-underscore__ key.
    if (typeId === "model") {
      const speechModels = await this.safely(() => this.fetchTranscriptionModelOptions(), []);
      return withStash(resource, { __speechModels__: speechModels });
    }

    if (typeId === "dataset") {
      const usage = await this.safely(() => this.fetchDatasetUsage(), null);
      return withStash(resource, { __datasetUsage__: usage });
    }

    if (typeId === "finetuned-model") {
      const id = resource.externalId ?? "";
      const [events, stepMetrics] = await Promise.all([
        this.safely(() => this.fetchFinetuneEvents(id), []),
        this.safely(() => this.fetchTrainingStepMetrics(id), []),
      ]);
      return withStash(resource, { __events__: events, __stepMetrics__: stepMetrics });
    }

    return resource;
  }

  private async findResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Cohere plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  /** Run an enrichment call, falling back rather than breaking the detail page. */
  private async safely<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  /**
   * `GET /v1/models` — https://docs.cohere.com/reference/list-models
   *
   * Cursor pagination: `page_size` (default 20, max 1000) / `page_token` →
   * `next_page_token`. ⚠️ The token is an **empty string** rather than absent
   * at the end of the list, which the falsy check below handles.
   *
   * Deprecated models stay in the response; callers building pickers must
   * filter on `is_deprecated` themselves.
   */
  private async fetchModels(): Promise<CohereModel[]> {
    const models: CohereModel[] = [];
    let pageToken: string | undefined;
    // Bounded so a pathological cursor cannot spin forever.
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ page_size: "1000" });
      if (pageToken) params.set("page_token", pageToken);
      const data = await this.fetch<ListModelsResponse>(`/v1/models?${params.toString()}`);
      models.push(...(data.models ?? []));
      if (!data.next_page_token) break;
      pageToken = data.next_page_token;
    }
    return models;
  }

  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const models = await this.fetchModels();
    const now = new Date().toISOString();
    return models.filter((m) => Boolean(m.name)).map((m) => this.mapModel(accountId, m, now));
  }

  private mapModel(accountId: string, model: CohereModel, now: string): ResourceInstance {
    const name = model.name ?? "";
    const defaults = model.sampling_defaults;
    return {
      id: `${accountId}:model:${name}`,
      pluginId: "cohere",
      resourceTypeId: "model",
      accountId,
      displayName: name,
      fields: {
        name,
        endpoints: (model.endpoints ?? []).join(", "),
        contextLength: model.context_length ?? 0,
        features: (model.features ?? []).join(", "),
        finetuned: Boolean(model.finetuned),
        isDeprecated: Boolean(model.is_deprecated),
        defaultEndpoints: (model.default_endpoints ?? []).join(", "),
        tokenizerUrl: model.tokenizer_url ?? "",
        samplingDefaults: defaults ? JSON.stringify(defaults) : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/datasets` — https://docs.cohere.com/reference/list-datasets
   *
   * ⚠️ Pagination differs from models: `limit` / `offset`, no cursor. This
   * endpoint's query params are camelCase (`datasetType`, `validationStatus`)
   * while its response fields are snake_case.
   */
  private async fetchDatasets(): Promise<CohereDataset[]> {
    const datasets: CohereDataset[] = [];
    const limit = 100;
    for (let offset = 0; offset < 2000; offset += limit) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const data = await this.fetch<ListDatasetsResponse>(`/v1/datasets?${params.toString()}`);
      const page = data.datasets ?? [];
      datasets.push(...page);
      if (page.length < limit) break;
    }
    return datasets;
  }

  /**
   * `GET /v1/datasets/usage` — https://docs.cohere.com/reference/get-dataset-usage
   *
   * The only aggregate usage figure the API exposes: dataset storage bytes
   * against a 10 GB organization cap. It is not token usage and not spend.
   */
  private async fetchDatasetUsage(): Promise<number | null> {
    const data = await this.fetch<DatasetUsageResponse>("/v1/datasets/usage");
    return typeof data.organization_usage === "number" ? data.organization_usage : null;
  }

  private async listDatasets(accountId: string): Promise<ResourceInstance[]> {
    const datasets = await this.fetchDatasets();
    const now = new Date().toISOString();
    return datasets.filter((d) => Boolean(d.id)).map((d) => this.mapDataset(accountId, d, now));
  }

  private mapDataset(accountId: string, dataset: CohereDataset, now: string): ResourceInstance {
    const id = dataset.id ?? "";
    const parts = dataset.dataset_parts ?? [];
    // ⚠️ Byte sizes and row counts are per-part, not top-level — and the row
    // field is `num_rows`, not `row_count`.
    const sizeBytes = parts.reduce((sum, p) => sum + (p.size_bytes ?? 0), 0);
    const numRows = parts.reduce((sum, p) => sum + (p.num_rows ?? 0), 0);

    return {
      id: `${accountId}:dataset:${id}`,
      pluginId: "cohere",
      resourceTypeId: "dataset",
      accountId,
      displayName: dataset.name || id,
      fields: {
        name: dataset.name ?? id,
        datasetType: dataset.dataset_type ?? "",
        validationStatus: dataset.validation_status ?? "",
        createdAt: dataset.created_at ?? "",
        updatedAt: dataset.updated_at ?? "",
        validationError: dataset.validation_error ?? "",
        validationWarnings: (dataset.validation_warnings ?? []).join("; "),
        partCount: parts.length,
        sizeBytes: String(sizeBytes),
        numRows,
        requiredFields: (dataset.required_fields ?? []).join(", "),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id,
      createdAt: dataset.created_at ?? now,
      updatedAt: dataset.updated_at ?? now,
    };
  }

  /**
   * `GET /v1/finetuning/finetuned-models` —
   * https://docs.cohere.com/reference/listfinetunedmodels
   *
   * Cursor pagination again: `page_size` (0 → 50) / `page_token`.
   *
   * ⚠️ Cohere files the entire fine-tuning group under "Deprecated", and
   * retired fine-tuning for command, command-light, command-r, classify and
   * rerank on 2025-09-15. The endpoints still answer, so existing fine-tunes
   * remain listable and deletable — but this plugin does not offer creation.
   */
  private async fetchFinetunedModels(): Promise<CohereFinetunedModel[]> {
    const models: CohereFinetunedModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ page_size: "100" });
      if (pageToken) params.set("page_token", pageToken);
      const data = await this.fetch<ListFinetunedModelsResponse>(
        `/v1/finetuning/finetuned-models?${params.toString()}`,
      );
      models.push(...(data.finetuned_models ?? []));
      if (!data.next_page_token) break;
      pageToken = data.next_page_token;
    }
    return models;
  }

  /** `GET /v1/finetuning/finetuned-models/{id}/events` */
  private async fetchFinetuneEvents(
    id: string,
  ): Promise<Array<{ status: string; userId: string; createdAt: string }>> {
    if (!id) return [];
    const data = await this.fetch<ListEventsResponse>(
      `/v1/finetuning/finetuned-models/${encodeURIComponent(id)}/events?page_size=50`,
    );
    return (data.events ?? []).map((e) => ({
      status: e.status ?? "",
      // Cohere documents an empty user_id as "initiated by the system".
      userId: e.user_id || "system",
      createdAt: e.created_at ?? "",
    }));
  }

  /**
   * `GET /v1/finetuning/finetuned-models/{id}/training-step-metrics`
   *
   * ⚠️ The path segment is `training-step-metrics`, not `metrics`, and the
   * response key is `step_metrics`.
   */
  private async fetchTrainingStepMetrics(
    id: string,
  ): Promise<Array<{ step: number; createdAt: string; metrics: Record<string, number> }>> {
    if (!id) return [];
    const data = await this.fetch<ListTrainingStepMetricsResponse>(
      `/v1/finetuning/finetuned-models/${encodeURIComponent(id)}/training-step-metrics?page_size=100`,
    );
    return (data.step_metrics ?? []).map((m) => ({
      step: m.step_number ?? 0,
      createdAt: m.created_at ?? "",
      metrics: m.metrics ?? {},
    }));
  }

  private async listFinetunedModels(accountId: string): Promise<ResourceInstance[]> {
    const models = await this.fetchFinetunedModels();
    const now = new Date().toISOString();
    return models
      .filter((m) => Boolean(m.id))
      .map((m) => this.mapFinetunedModel(accountId, m, now));
  }

  private mapFinetunedModel(
    accountId: string,
    model: CohereFinetunedModel,
    now: string,
  ): ResourceInstance {
    const id = model.id ?? "";
    const base = model.settings?.base_model;
    const hyper = model.settings?.hyperparameters;
    return {
      id: `${accountId}:finetuned-model:${id}`,
      pluginId: "cohere",
      resourceTypeId: "finetuned-model",
      accountId,
      displayName: model.name || id,
      fields: {
        name: model.name ?? id,
        status: model.status ?? "",
        baseType: base?.base_type ?? "",
        baseModel: base?.name ?? "",
        baseVersion: base?.version ?? "",
        strategy: base?.strategy ?? "",
        datasetId: model.settings?.dataset_id ?? "",
        createdAt: model.created_at ?? "",
        updatedAt: model.updated_at ?? "",
        completedAt: model.completed_at ?? "",
        hyperparameters: hyper ? JSON.stringify(hyper) : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id,
      createdAt: model.created_at ?? now,
      updatedAt: model.updated_at ?? now,
    };
  }

  /**
   * `GET /v1/embed-jobs` — https://docs.cohere.com/reference/list-embed-jobs
   *
   * ⚠️ This endpoint documents no query parameters whatsoever — there is no
   * pagination to drive, and the response is the full list.
   */
  private async fetchEmbedJobs(): Promise<CohereEmbedJob[]> {
    const data = await this.fetch<ListEmbedJobsResponse>("/v1/embed-jobs");
    return data.embed_jobs ?? [];
  }

  private async listEmbedJobs(accountId: string): Promise<ResourceInstance[]> {
    const jobs = await this.fetchEmbedJobs();
    const now = new Date().toISOString();
    return jobs.filter((j) => Boolean(j.job_id)).map((j) => this.mapEmbedJob(accountId, j, now));
  }

  private mapEmbedJob(accountId: string, job: CohereEmbedJob, now: string): ResourceInstance {
    const id = job.job_id ?? "";
    return {
      id: `${accountId}:embed-job:${id}`,
      pluginId: "cohere",
      resourceTypeId: "embed-job",
      accountId,
      displayName: job.name || id,
      fields: {
        name: job.name ?? id,
        status: job.status ?? "",
        model: job.model ?? "",
        truncate: job.truncate ?? "",
        createdAt: job.created_at ?? "",
        inputDatasetId: job.input_dataset_id ?? "",
        outputDatasetId: job.output_dataset_id ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id,
      createdAt: job.created_at ?? now,
      updatedAt: job.created_at ?? now,
    };
  }

  /**
   * `GET /v2/batches` — https://docs.cohere.com/reference/list-batches
   *
   * One of the few management-shaped surfaces that really is on `/v2/`.
   * Cursor pagination: `page_size` (default 50, max 1000) / `page_token`.
   */
  private async fetchBatches(): Promise<CohereBatch[]> {
    const batches: CohereBatch[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ page_size: "1000" });
      if (pageToken) params.set("page_token", pageToken);
      const data = await this.fetch<ListBatchesResponse>(`/v2/batches?${params.toString()}`);
      batches.push(...(data.batches ?? []));
      if (!data.next_page_token) break;
      pageToken = data.next_page_token;
    }
    return batches;
  }

  private async listBatches(accountId: string): Promise<ResourceInstance[]> {
    const batches = await this.fetchBatches();
    const now = new Date().toISOString();
    return batches.filter((b) => Boolean(b.id)).map((b) => this.mapBatch(accountId, b, now));
  }

  private mapBatch(accountId: string, batch: CohereBatch, now: string): ResourceInstance {
    const id = batch.id ?? "";
    return {
      id: `${accountId}:batch:${id}`,
      pluginId: "cohere",
      resourceTypeId: "batch",
      accountId,
      displayName: batch.name || id,
      fields: {
        name: batch.name ?? id,
        status: batch.status ?? "",
        model: batch.model ?? "",
        statusReason: batch.status_reason ?? "",
        createdAt: batch.created_at ?? "",
        updatedAt: batch.updated_at ?? "",
        inputDatasetId: batch.input_dataset_id ?? "",
        outputDatasetId: batch.output_dataset_id ?? "",
        numRecords: batch.num_records ?? 0,
        numSuccessfulRecords: batch.num_successful_records ?? 0,
        numFailedRecords: batch.num_failed_records ?? 0,
        inputTokens: String(batch.input_tokens ?? 0),
        outputTokens: String(batch.output_tokens ?? 0),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id,
      createdAt: batch.created_at ?? now,
      updatedAt: batch.updated_at ?? now,
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
      if (outputKey === "modelName") return String(fields["name"] ?? "");
      if (outputKey === "contextLength") return String(fields["contextLength"] ?? "");
    }

    if (typeId === "dataset") {
      if (outputKey === "datasetId") return resource.externalId ?? "";
      if (outputKey === "datasetName") return String(fields["name"] ?? "");
    }

    if (typeId === "finetuned-model") {
      if (outputKey === "finetunedModelId") return resource.externalId ?? "";
      if (outputKey === "modelName") return String(fields["name"] ?? "");
      if (outputKey === "status") return String(fields["status"] ?? "");
    }

    if (typeId === "embed-job") {
      if (outputKey === "jobId") return resource.externalId ?? "";
      if (outputKey === "outputDatasetId") return String(fields["outputDatasetId"] ?? "");
      if (outputKey === "status") return String(fields["status"] ?? "");
    }

    if (typeId === "batch") {
      if (outputKey === "batchId") return resource.externalId ?? "";
      if (outputKey === "outputDatasetId") return String(fields["outputDatasetId"] ?? "");
      if (outputKey === "status") return String(fields["status"] ?? "");
    }

    throw new Error(`Cohere plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Datasets: `DELETE /v1/datasets/{id}` —
   * https://docs.cohere.com/reference/delete-dataset
   * Fine-tuned models: `DELETE /v1/finetuning/finetuned-models/{id}` —
   * https://docs.cohere.com/reference/deletefinetunedmodel (irreversible).
   *
   * Base models belong to Cohere and jobs are cancelled rather than removed,
   * so those types declare `supportsDelete: false`.
   */
  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "dataset") {
      await this.fetch(`/v1/datasets/${encodeURIComponent(externalId)}`, { method: "DELETE" });
      return;
    }
    if (typeId === "finetuned-model") {
      await this.fetch(`/v1/finetuning/finetuned-models/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }
    throw new Error(`Cohere plugin: cannot delete type "${typeId}"`);
  }

  /**
   * Embed jobs: `POST /v1/embed-jobs/{id}/cancel` —
   * https://docs.cohere.com/reference/cancel-embed-job
   * Batches: `POST /v2/batches/{id}:cancel` —
   * https://docs.cohere.com/reference/cancel-batch (note the colon verb, and
   * that this one lives on `/v2/`).
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "embed-job" && actionId === "cancel") {
      await this.fetch(`/v1/embed-jobs/${encodeURIComponent(externalId)}/cancel`, {
        method: "POST",
      });
      return;
    }

    if (typeId === "batch" && actionId === "cancel") {
      await this.fetch(`/v2/batches/${encodeURIComponent(externalId)}:cancel`, { method: "POST" });
      return;
    }

    throw new Error(`Cohere plugin: unknown action "${actionId}" for type "${typeId}"`);
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
        { label: "Context", value: formatTokens(Number(fields["contextLength"] ?? 0)) },
        { label: "Endpoints", value: String(fields["endpoints"] || "—") },
        ...(fields["isDeprecated"] === true
          ? [{ label: "Status", value: "deprecated", variant: "status-degraded" as const }]
          : []),
      ];
    }

    if (resourceTypeId === "dataset") {
      return [
        { label: "Type", value: String(fields["datasetType"] || "—") },
        { label: "Rows", value: String(fields["numRows"] ?? 0) },
        { label: "Size", value: formatBytes(Number(fields["sizeBytes"] ?? 0)) },
      ];
    }

    if (resourceTypeId === "finetuned-model") {
      return [
        { label: "Status", value: prettyEnum(String(fields["status"] || "")) },
        { label: "Base", value: prettyEnum(String(fields["baseType"] || "")) },
      ];
    }

    if (resourceTypeId === "embed-job") {
      return [
        { label: "Status", value: String(fields["status"] || "—") },
        { label: "Model", value: String(fields["model"] || "—") },
      ];
    }

    if (resourceTypeId === "batch") {
      return [
        { label: "Status", value: prettyEnum(String(fields["status"] || "")) },
        {
          label: "Records",
          value: `${Number(fields["numSuccessfulRecords"] ?? 0)}/${Number(fields["numRecords"] ?? 0)}`,
        },
        {
          label: "Tokens",
          value: String(Number(fields["inputTokens"] ?? 0) + Number(fields["outputTokens"] ?? 0)),
        },
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
      case "dataset":
        return this.renderDatasetDetail(resource);
      case "finetuned-model":
        return this.renderFinetunedModelDetail(resource);
      case "embed-job":
        return this.renderEmbedJobDetail(resource);
      case "batch":
        return this.renderBatchDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: "Cohere",
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

  /** The shared "there is no usage API" panel. Cohere genuinely has none. */
  private billingSection() {
    return {
      kind: "section" as const,
      title: "Usage & Billing",
      children: [
        {
          kind: "text" as const,
          variant: "muted" as const,
          content:
            "Cohere exposes no usage or billing API. Token consumption is reported only per " +
            "response, in each inference call's meta.billed_units — there is no aggregate " +
            "query, and spend is visible only in the Cohere dashboard.",
        },
        {
          kind: "link" as const,
          label: "Open billing in the Cohere dashboard",
          url: "https://dashboard.cohere.com/billing",
        },
      ],
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const deprecated = fields["isDeprecated"] === true;

    return {
      title: resource.displayName,
      subtitle: `Cohere Model${deprecated ? " · deprecated" : ""}`,
      status: { kind: "status-dot", status: deprecated ? "degraded" : "healthy" },
      sections: [
        {
          kind: "section",
          title: "Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(fields["name"] ?? "—"), copyable: true },
                {
                  key: "Context Length",
                  value: formatTokens(Number(fields["contextLength"] ?? 0)),
                },
                { key: "Endpoints", value: String(fields["endpoints"] || "—") },
                { key: "Default Endpoints", value: String(fields["defaultEndpoints"] || "—") },
                { key: "Features", value: String(fields["features"] || "—") },
                { key: "Fine-tuned", value: fields["finetuned"] === true ? "Yes" : "No" },
                { key: "Deprecated", value: deprecated ? "Yes" : "No" },
                ...(fields["tokenizerUrl"]
                  ? [{ key: "Tokenizer", value: String(fields["tokenizerUrl"]), copyable: true }]
                  : []),
              ],
            },
          ],
        },
        ...(fields["samplingDefaults"]
          ? [
              {
                kind: "section" as const,
                title: "Sampling Defaults",
                children: [
                  {
                    kind: "text" as const,
                    variant: "mono" as const,
                    copyable: true,
                    content: String(fields["samplingDefaults"]),
                  },
                ],
              },
            ]
          : []),
        this.billingSection(),
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "API reference",
          action: { type: "open-url", url: "https://docs.cohere.com/reference/about" },
        },
      ],
      speechPanel: {
        // Cohere ships transcription only — there is no text-to-speech
        // endpoint anywhere in the product, so no "tts" mode here.
        modes: ["stt"],
        subtitle: "Transcribe an audio clip with Cohere's speech-to-text model",
        helpText: SPEECH_HELP_TEXT,
        models: this.speechModelOptions(resource),
        defaultModel: TRANSCRIBE_MODEL,
        languages: LANGUAGES,
        defaultLanguage: "en",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        maxAudioBytes: MAX_AUDIO_BYTES,
        transcribeLabel: "Transcribe",
      },
    };
  }

  private renderDatasetDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["validationStatus"] ?? "").toLowerCase();
    const warnings = String(fields["validationWarnings"] ?? "");
    const error = String(fields["validationError"] ?? "");
    const usage = readStash<number | null>(resource, "__datasetUsage__", null);
    const quotaBytes = 10 * 1024 * 1024 * 1024;

    return {
      title: resource.displayName,
      subtitle: `Cohere Dataset · ${String(fields["datasetType"] || "unknown type")}`,
      status: { kind: "status-dot", status: datasetStatusDot(status) },
      sections: [
        {
          kind: "section",
          title: "Dataset",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "ID", value: resource.externalId ?? "—", copyable: true },
                { key: "Name", value: String(fields["name"] ?? "—") },
                { key: "Type", value: String(fields["datasetType"] || "—") },
                { key: "Validation Status", value: String(fields["validationStatus"] || "—") },
                { key: "Parts", value: String(fields["partCount"] ?? 0) },
                { key: "Rows", value: String(fields["numRows"] ?? 0) },
                { key: "Size", value: formatBytes(Number(fields["sizeBytes"] ?? 0)) },
                ...(fields["requiredFields"]
                  ? [{ key: "Required Fields", value: String(fields["requiredFields"]) }]
                  : []),
                { key: "Created", value: String(fields["createdAt"] || "—") },
                { key: "Updated", value: String(fields["updatedAt"] || "—") },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content: "Cohere deletes datasets automatically 30 days after upload.",
            },
          ],
        },
        ...(error || warnings
          ? [
              {
                kind: "section" as const,
                title: "Validation",
                children: [
                  {
                    kind: "key-value-list" as const,
                    items: [
                      ...(error ? [{ key: "Error", value: error }] : []),
                      ...(warnings ? [{ key: "Warnings", value: warnings }] : []),
                    ],
                  },
                ],
              },
            ]
          : []),
        {
          kind: "section",
          title: "Organization Storage",
          children:
            usage === null
              ? [
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content: "Storage usage is unavailable for this account.",
                  },
                ]
              : [
                  {
                    kind: "key-value-list" as const,
                    items: [
                      { key: "Used", value: formatBytes(usage) },
                      { key: "Quota", value: "10 GB" },
                      {
                        key: "Utilisation",
                        value: `${((usage / quotaBytes) * 100).toFixed(1)}%`,
                      },
                    ],
                  },
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content:
                      "Dataset storage is the only aggregate usage figure Cohere's API reports. " +
                      "It says nothing about token consumption or spend.",
                  },
                ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFinetunedModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const events = readStash<Array<{ status: string; userId: string; createdAt: string }>>(
      resource,
      "__events__",
      [],
    );
    const stepMetrics = readStash<
      Array<{ step: number; createdAt: string; metrics: Record<string, number> }>
    >(resource, "__stepMetrics__", []);

    const metricKeys = Array.from(
      new Set(stepMetrics.flatMap((m) => Object.keys(m.metrics))),
    ).sort();

    return {
      title: resource.displayName,
      subtitle: `Cohere Fine-tuned Model · ${prettyEnum(String(fields["baseType"] || ""))}`,
      status: { kind: "status-dot", status: finetuneStatusDot(status) },
      sections: [
        {
          kind: "section",
          title: "Fine-tune",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "ID", value: resource.externalId ?? "—", copyable: true },
                { key: "Name", value: String(fields["name"] ?? "—") },
                { key: "Status", value: prettyEnum(status) },
                { key: "Base Type", value: prettyEnum(String(fields["baseType"] || "")) },
                { key: "Base Model", value: String(fields["baseModel"] || "—") },
                { key: "Base Version", value: String(fields["baseVersion"] || "—") },
                { key: "Strategy", value: prettyEnum(String(fields["strategy"] || "")) },
                { key: "Dataset", value: String(fields["datasetId"] || "—"), copyable: true },
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
                { key: "Created", value: String(fields["createdAt"] || "—") },
                { key: "Updated", value: String(fields["updatedAt"] || "—") },
                { key: "Completed", value: String(fields["completedAt"] || "—") },
              ],
            },
          ],
        },
        ...(fields["hyperparameters"]
          ? [
              {
                kind: "section" as const,
                title: "Hyperparameters",
                children: [
                  {
                    kind: "text" as const,
                    variant: "mono" as const,
                    copyable: true,
                    content: String(fields["hyperparameters"]),
                  },
                ],
              },
            ]
          : []),
        {
          kind: "section",
          title: "Deprecation",
          children: [
            {
              kind: "text",
              variant: "muted",
              content:
                "Cohere retired fine-tuning for command, command-light, command-r, classify and " +
                "rerank on 15 September 2025, and files the whole fine-tuning API under " +
                "Deprecated. Existing fine-tunes stay listable and deletable; new ones cannot be " +
                "created.",
            },
            {
              kind: "link",
              label: "Cohere deprecations",
              url: "https://docs.cohere.com/docs/deprecations",
            },
          ],
        },
      ],
      customTabs: [
        {
          id: "events",
          label: "Events",
          sections: [
            {
              kind: "section",
              title: "Status history",
              children:
                events.length === 0
                  ? [
                      {
                        kind: "text",
                        variant: "muted",
                        content: "No events reported for this fine-tune.",
                      },
                    ]
                  : [
                      {
                        kind: "table",
                        columns: [
                          { key: "createdAt", label: "When", width: "wide" },
                          { key: "status", label: "Status" },
                          { key: "userId", label: "Initiated by" },
                        ],
                        rows: events.map<TableRow>((e) => ({
                          cells: {
                            createdAt: e.createdAt || "—",
                            status: prettyEnum(e.status),
                            userId: e.userId,
                          },
                        })),
                      },
                    ],
            },
          ],
        },
        {
          id: "training-metrics",
          label: "Training Metrics",
          sections: [
            {
              kind: "section",
              title: "Per-step metrics",
              children:
                stepMetrics.length === 0
                  ? [
                      {
                        kind: "text",
                        variant: "muted",
                        content:
                          "No training-step metrics are available. Cohere reports them only " +
                          "while a fine-tune is training and for a period afterwards.",
                      },
                    ]
                  : [
                      {
                        kind: "table",
                        columns: [
                          { key: "step", label: "Step", width: "narrow" },
                          ...metricKeys.map((k) => ({ key: k, label: k, mono: true as const })),
                        ],
                        rows: stepMetrics.map<TableRow>((m) => ({
                          cells: {
                            step: String(m.step),
                            ...Object.fromEntries(
                              metricKeys.map((k) => [
                                k,
                                m.metrics[k] === undefined ? "—" : String(m.metrics[k]),
                              ]),
                            ),
                          },
                        })),
                      },
                    ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderEmbedJobDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "").toLowerCase();
    const running = status === "processing";

    return {
      title: resource.displayName,
      subtitle: `Cohere Embed Job · ${String(fields["model"] || "unknown model")}`,
      status: { kind: "status-dot", status: embedJobStatusDot(status) },
      sections: [
        {
          kind: "section",
          title: "Job",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Job ID", value: resource.externalId ?? "—", copyable: true },
                { key: "Name", value: String(fields["name"] ?? "—") },
                { key: "Status", value: String(fields["status"] || "—") },
                { key: "Model", value: String(fields["model"] || "—") },
                { key: "Truncate", value: String(fields["truncate"] || "—") },
                { key: "Created", value: String(fields["createdAt"] || "—") },
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
                  key: "Input Dataset",
                  value: String(fields["inputDatasetId"] || "—"),
                  copyable: true,
                },
                {
                  key: "Output Dataset",
                  value: String(fields["outputDatasetId"] || "—"),
                  copyable: true,
                },
              ],
            },
          ],
        },
      ],
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        ...(running
          ? [
              {
                kind: "action" as const,
                label: "Cancel job",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this embed job? Partial results are not written to the output dataset.",
                  successMessage: "Embed job cancelled.",
                },
              },
            ]
          : []),
      ],
    };
  }

  private renderBatchDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const cancellable = status === "BATCH_STATUS_QUEUED" || status === "BATCH_STATUS_IN_PROGRESS";

    return {
      title: resource.displayName,
      subtitle: `Cohere Batch · ${String(fields["model"] || "unknown model")}`,
      status: { kind: "status-dot", status: batchStatusDot(status) },
      sections: [
        {
          kind: "section",
          title: "Batch",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Batch ID", value: resource.externalId ?? "—", copyable: true },
                { key: "Name", value: String(fields["name"] ?? "—") },
                { key: "Status", value: prettyEnum(status) },
                { key: "Model", value: String(fields["model"] || "—") },
                ...(fields["statusReason"]
                  ? [{ key: "Status Reason", value: String(fields["statusReason"]) }]
                  : []),
                { key: "Created", value: String(fields["createdAt"] || "—") },
                { key: "Updated", value: String(fields["updatedAt"] || "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Progress",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Records", value: String(fields["numRecords"] ?? 0) },
                { key: "Successful", value: String(fields["numSuccessfulRecords"] ?? 0) },
                { key: "Failed", value: String(fields["numFailedRecords"] ?? 0) },
                { key: "Input Tokens", value: String(fields["inputTokens"] ?? 0) },
                { key: "Output Tokens", value: String(fields["outputTokens"] ?? 0) },
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
                  key: "Input Dataset",
                  value: String(fields["inputDatasetId"] || "—"),
                  copyable: true,
                },
                {
                  key: "Output Dataset",
                  value: String(fields["outputDatasetId"] || "—"),
                  copyable: true,
                },
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
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this batch? Records already processed stay in the output dataset; the rest are dropped.",
                  successMessage: "Batch cancelled.",
                },
              },
            ]
          : []),
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;
    const label = resource.displayName;

    switch (resource.resourceTypeId) {
      case "model":
        return {
          id: resource.id,
          label,
          status: {
            kind: "status-dot",
            status: fields["isDeprecated"] === true ? "degraded" : "healthy",
          },
        };
      case "finetuned-model":
        return {
          id: resource.id,
          label,
          status: { kind: "status-dot", status: finetuneStatusDot(String(fields["status"] ?? "")) },
        };
      case "embed-job":
        return {
          id: resource.id,
          label,
          status: {
            kind: "status-dot",
            status: embedJobStatusDot(String(fields["status"] ?? "").toLowerCase()),
          },
        };
      case "batch":
        return {
          id: resource.id,
          label,
          status: { kind: "status-dot", status: batchStatusDot(String(fields["status"] ?? "")) },
        };
      case "dataset":
        return {
          id: resource.id,
          label,
          status: {
            kind: "status-dot",
            status: datasetStatusDot(String(fields["validationStatus"] ?? "").toLowerCase()),
          },
        };
      default:
        return { id: resource.id, label, status: { kind: "status-dot", status: "info" } };
    }
  }

  // ---------------------------------------------------------------------------
  // Speech tab — transcription only
  // ---------------------------------------------------------------------------

  /**
   * Model options for the Speech tab, from the live model list when
   * `getResource` managed to fetch it, falling back to the one documented
   * transcription model.
   */
  private speechModelOptions(resource: ResourceInstance): SpeechPanelOption[] {
    const stashed = readStash<SpeechPanelOption[]>(resource, "__speechModels__", []);
    return stashed.length > 0 ? stashed : [defaultTranscribeOption()];
  }

  /**
   * Non-deprecated speech models from `GET /v1/models`.
   *
   * ⚠️ The `CompatibleEndpoint` enum has no `transcribe` or `audio` member —
   * it is exactly chat, embed, classify, summarize, rerank, rate, generate —
   * so the speech model cannot be found by filtering `endpoints[]` the way a
   * chat or embed model can. Matching on the `cohere-transcribe` name prefix is
   * the only discovery route, and it degrades to the documented default if
   * Cohere does not list the model at all.
   */
  private async fetchTranscriptionModelOptions(): Promise<SpeechPanelOption[]> {
    const models = await this.fetchModels();
    const options = models
      .filter((m) => !m.is_deprecated && m.name?.startsWith("cohere-transcribe"))
      .map<SpeechPanelOption>((m) => ({
        id: m.name!,
        label: m.name!,
        description: "Speech-to-text",
      }));

    return options.length > 0 ? options : [defaultTranscribeOption()];
  }

  /**
   * `POST /v2/audio/transcriptions` —
   * https://docs.cohere.com/reference/create-audio-transcription
   *
   * Multipart, so the body is hand-encoded rather than passed as a `FormData`
   * (which the host HTTP bridge would stringify into "[object FormData]").
   * The response is JSON, so it still goes through `jsonRestFetch` and keeps
   * bastion egress routing and the custom CA.
   *
   * Form fields are exactly `file`, `model` and `language` (all three
   * required), plus an optional `temperature`. There is no `response_format`
   * and no `prompt`.
   */
  async transcribeAudio(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    const audio = new Uint8Array(Buffer.from(payload.audioBase64, "base64"));
    if (audio.byteLength === 0) throw new Error("Cohere plugin: the audio clip was empty");
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(
        `Cohere plugin: the clip is ${formatBytes(audio.byteLength)} — the transcription endpoint accepts at most 25 MB`,
      );
    }

    const extension = extensionForMime(payload.mimeType, payload.fileName);
    if (!extension) {
      throw new Error(
        `Cohere plugin: ${payload.mimeType || "this clip"} is not a container Cohere transcribes. ` +
          "Supported formats are FLAC, MP3, MPEG, MPGA, OGG and WAV — browser recordings " +
          "(WebM on Chrome, Edge and Firefox; MP4 on Safari) must be converted first.",
      );
    }

    // `language` is a required form field on this endpoint — there is no
    // auto-detect mode — so fall back to English rather than omitting it.
    const language = payload.language || "en";
    const model = payload.modelId || TRANSCRIBE_MODEL;

    const parts: MultipartPart[] = [
      { kind: "field", name: "model", value: model },
      { kind: "field", name: "language", value: language },
      {
        kind: "file",
        name: "file",
        fileName: payload.fileName || `audio.${extension}`,
        contentType: payload.mimeType || `audio/${extension}`,
        data: audio,
      },
    ];

    const { contentType, body } = buildMultipartBody(parts);
    const response = await this.fetch<TranscriptionResponse>("/v2/audio/transcriptions", {
      method: "POST",
      headers: { "Content-Type": contentType },
      // A raw byte array is a valid body for both paths at runtime — global
      // `fetch` takes it as a BufferSource, and the host HTTP bridge passes
      // `Uint8Array` straight through. The cast is only needed because the
      // DOM and Node `BodyInit` unions disagree about the generic parameter
      // on `Uint8Array`.
      body: body as unknown as BodyInit,
    });

    return {
      text: response.text ?? "",
      summary: `${model} · ${language} · ${formatBytes(audio.byteLength)} of ${extension.toUpperCase()}`,
      language,
      // Cohere's documented response is exactly `{ text }` — no duration, no
      // confidence, no word or segment timings — so those stay unset rather
      // than being invented from the transcript.
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Resource ids are `{accountId}:{typeId}:{externalId}`. */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function defaultTranscribeOption(): SpeechPanelOption {
  return {
    id: TRANSCRIBE_MODEL,
    label: TRANSCRIBE_MODEL,
    description: "Cohere's speech-to-text model",
  };
}

/** Stash extra API data on a resource for the synchronous `renderDetail`. */
function withStash(resource: ResourceInstance, extra: Record<string, unknown>): ResourceInstance {
  const stash: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) stash[key] = JSON.stringify(value);
  return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...stash } };
}

function readStash<T>(resource: ResourceInstance, key: string, fallback: T): T {
  const raw = resource.resolvedOutputs?.[key];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function extensionForMime(mimeType: string | undefined, fileName?: string): string | undefined {
  const normalised = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const fromMime = MIME_TO_EXTENSION[normalised];
  if (fromMime) return fromMime;

  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext && ACCEPTED_EXTENSIONS.includes(ext)) return ext;
  return undefined;
}

function formatTokens(tokens: number): string {
  if (!tokens) return "—";
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Turn `STATUS_READY` / `BASE_TYPE_CHAT` into something a human reads. */
function prettyEnum(value: string): string {
  if (!value) return "—";
  return value
    .replace(/^(STATUS|BASE_TYPE|STRATEGY|BATCH_STATUS)_/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

function finetuneStatusDot(status: string): ResourceStatus {
  switch (status.toUpperCase()) {
    case "STATUS_READY":
      return "healthy";
    case "STATUS_FAILED":
    case "STATUS_DELETED":
      return "error";
    case "STATUS_PAUSED":
    case "STATUS_TEMPORARILY_OFFLINE":
      return "degraded";
    case "STATUS_FINETUNING":
    case "STATUS_QUEUED":
    case "STATUS_DEPLOYING_API":
      return "provisioning";
    default:
      return "info";
  }
}

function embedJobStatusDot(status: string): ResourceStatus {
  switch (status) {
    case "complete":
      return "healthy";
    case "failed":
      return "error";
    case "cancelling":
    case "cancelled":
      return "degraded";
    case "processing":
      return "provisioning";
    default:
      return "info";
  }
}

function batchStatusDot(status: string): ResourceStatus {
  switch (status) {
    case "BATCH_STATUS_COMPLETED":
      return "healthy";
    case "BATCH_STATUS_FAILED":
      return "error";
    case "BATCH_STATUS_CANCELING":
    case "BATCH_STATUS_CANCELED":
      return "degraded";
    case "BATCH_STATUS_QUEUED":
    case "BATCH_STATUS_IN_PROGRESS":
      return "provisioning";
    default:
      return "info";
  }
}

function datasetStatusDot(status: string): ResourceStatus {
  switch (status) {
    case "validated":
      return "healthy";
    case "failed":
      return "error";
    case "skipped":
      return "degraded";
    case "queued":
    case "processing":
      return "provisioning";
    default:
      return "info";
  }
}

function keyValuesFrom(fields: Record<string, string | number | boolean>) {
  return Object.entries(fields).map(([key, value]) => ({ key, value: String(value) }));
}
