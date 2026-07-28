/**
 * Wire types for the Cohere Platform API.
 *
 * Base URL is `https://api.cohere.com` — *not* `api.cohere.ai`, which only
 * survives on stale pages. Auth is `Authorization: Bearer <key>`, plus the
 * optional `X-Client-Name` header Cohere asks integrators to set.
 *
 * Note the version split: **management endpoints are still `/v1/`**. Only the
 * inference surface (chat, embed, rerank, transcriptions) and the newer
 * batches API live on `/v2/`. Do not "modernise" the `/v1/` paths below — the
 * `/v2/` equivalents do not exist.
 *
 * Every shape here is transcribed from the OpenAPI fragments Cohere serves by
 * appending `.md` to a reference URL.
 */

/** `POST /v1/check-api-key` — https://docs.cohere.com/reference/check-api-key */
export interface CheckApiKeyResponse {
  valid: boolean;
  organization_id?: string;
  owner_id?: string;
}

/**
 * `GET /v1/models` — https://docs.cohere.com/reference/list-models
 *
 * No property on `GetModelResponse` is marked required.
 *
 * `features` is spec'd as a bare `array of string` with **no enum**, so it is
 * modelled as an open set — do not switch on specific values.
 *
 * `supports_vision` is deliberately absent: it does not appear in the
 * documented schema, so this plugin does not depend on it.
 */
export interface CohereModel {
  name?: string;
  endpoints?: CompatibleEndpoint[];
  finetuned?: boolean;
  context_length?: number;
  tokenizer_url?: string;
  features?: string[];
  default_endpoints?: CompatibleEndpoint[];
  /** Deprecated models stay listed; pickers must filter on this. */
  is_deprecated?: boolean;
  sampling_defaults?: {
    temperature?: number;
    k?: number;
    p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens_per_doc?: number;
  };
}

/**
 * The complete `CompatibleEndpoint` enum. Note there is **no** `transcribe` or
 * `audio` member despite `/v2/audio/transcriptions` existing — the speech
 * model is not discoverable through the endpoint filter.
 */
export type CompatibleEndpoint =
  | "chat"
  | "embed"
  | "classify"
  | "summarize"
  | "rerank"
  | "rate"
  | "generate";

export interface ListModelsResponse {
  models?: CohereModel[];
  /** Empty string (not absent) signals the end of the list. */
  next_page_token?: string;
}

/**
 * `GET /v1/datasets` — https://docs.cohere.com/reference/list-datasets
 *
 * ⚠️ This endpoint's query parameters are camelCase (`datasetType`,
 * `validationStatus`) while its response fields are snake_case.
 * Row counts and byte sizes are per-part, not top-level.
 */
export interface CohereDatasetPart {
  name?: string;
  url?: string;
  index?: number;
  size_bytes?: number;
  num_rows?: number;
  samples?: string[];
}

export interface CohereDataset {
  id?: string;
  name?: string;
  dataset_type?: string;
  validation_status?: string;
  validation_error?: string;
  validation_warnings?: string[];
  created_at?: string;
  updated_at?: string;
  schema?: string;
  required_fields?: string[];
  preserve_fields?: string[];
  dataset_parts?: CohereDatasetPart[];
  parse_info?: { separator?: string; delimiter?: string };
  metrics?: {
    finetune_dataset_metrics?: {
      trainable_token_count?: number;
      train_size_bytes?: number;
      eval_size_bytes?: number;
      num_train_examples?: number;
      num_eval_examples?: number;
    };
  };
}

export interface ListDatasetsResponse {
  datasets?: CohereDataset[];
}

/**
 * `GET /v1/datasets/usage` — https://docs.cohere.com/reference/get-dataset-usage
 * Total bytes of dataset storage used by the organization, against a 10 GB cap.
 * This is the *only* aggregate usage number Cohere exposes over the API — it
 * measures storage, not tokens and not spend.
 */
export interface DatasetUsageResponse {
  organization_usage?: number;
}

/**
 * `GET /v1/finetuning/finetuned-models` —
 * https://docs.cohere.com/reference/listfinetunedmodels
 *
 * ⚠️ The whole fine-tuning group is filed under "Deprecated" in Cohere's API
 * index, and fine-tuning for command / command-light / command-r / classify /
 * rerank was retired on 2025-09-15. The endpoints still respond, so this
 * plugin still lists what an account has; it just doesn't offer creation.
 */
export interface CohereFinetunedModel {
  id?: string;
  name?: string;
  creator_id?: string;
  organization_id?: string;
  status?: FinetunedModelStatus;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  /** Marked deprecated in Cohere's own field description. */
  last_used?: string;
  settings?: {
    base_model?: { name?: string; version?: string; base_type?: string; strategy?: string };
    dataset_id?: string;
    hyperparameters?: Record<string, unknown>;
    multi_label?: boolean;
    wandb?: { project?: string; entity?: string; api_key?: string };
  };
}

/** All nine documented values. */
export type FinetunedModelStatus =
  | "STATUS_UNSPECIFIED"
  | "STATUS_FINETUNING"
  | "STATUS_DEPLOYING_API"
  | "STATUS_READY"
  | "STATUS_FAILED"
  | "STATUS_DELETED"
  | "STATUS_TEMPORARILY_OFFLINE"
  | "STATUS_PAUSED"
  | "STATUS_QUEUED";

export interface ListFinetunedModelsResponse {
  finetuned_models?: CohereFinetunedModel[];
  /** Empty string (not absent) signals the end of the list. */
  next_page_token?: string;
  total_size?: number;
}

/** `GET /v1/finetuning/finetuned-models/{id}/events` */
export interface FinetunedModelEvent {
  user_id?: string;
  status?: FinetunedModelStatus;
  created_at?: string;
}

export interface ListEventsResponse {
  events?: FinetunedModelEvent[];
  next_page_token?: string;
  total_size?: number;
}

/**
 * `GET /v1/finetuning/finetuned-models/{id}/training-step-metrics`
 * ⚠️ The path is `training-step-metrics`, not `metrics`, and the response key
 * is `step_metrics`.
 */
export interface TrainingStepMetric {
  created_at?: string;
  step_number?: number;
  metrics?: Record<string, number>;
}

export interface ListTrainingStepMetricsResponse {
  step_metrics?: TrainingStepMetric[];
  next_page_token?: string;
}

/**
 * `GET /v1/embed-jobs` — https://docs.cohere.com/reference/list-embed-jobs
 * ⚠️ This endpoint documents **no** query parameters at all — no pagination.
 */
export interface CohereEmbedJob {
  job_id?: string;
  name?: string;
  status?: EmbedJobStatus;
  created_at?: string;
  input_dataset_id?: string;
  output_dataset_id?: string;
  model?: string;
  truncate?: "START" | "END";
  meta?: ApiMeta;
}

export type EmbedJobStatus = "processing" | "complete" | "cancelling" | "cancelled" | "failed";

export interface ListEmbedJobsResponse {
  embed_jobs?: CohereEmbedJob[];
}

/** `GET /v2/batches` — https://docs.cohere.com/reference/list-batches */
export interface CohereBatch {
  id?: string;
  name?: string;
  creator_id?: string;
  org_id?: string;
  status?: BatchStatus;
  created_at?: string;
  updated_at?: string;
  input_dataset_id?: string;
  output_dataset_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  model?: string;
  num_records?: number;
  num_successful_records?: number;
  num_failed_records?: number;
  status_reason?: string;
}

export type BatchStatus =
  | "BATCH_STATUS_UNSPECIFIED"
  | "BATCH_STATUS_QUEUED"
  | "BATCH_STATUS_IN_PROGRESS"
  | "BATCH_STATUS_CANCELING"
  | "BATCH_STATUS_COMPLETED"
  | "BATCH_STATUS_FAILED"
  | "BATCH_STATUS_CANCELED";

export interface ListBatchesResponse {
  batches?: CohereBatch[];
  next_page_token?: string;
}

export interface ApiMeta {
  api_version?: { version?: string; is_deprecated?: boolean; is_experimental?: boolean };
  billed_units?: Record<string, number>;
  tokens?: Record<string, number>;
  warnings?: string[];
}

/**
 * `POST /v2/audio/transcriptions` — https://docs.cohere.com/reference/create-audio-transcription
 *
 * The documented response body is **exactly** `{ text }`, with `text`
 * required. There is no duration, no detected language, no segments, and no
 * usage block — so the Speech panel leaves `words`, `durationSeconds` and
 * `confidence` unset rather than fabricating them.
 */
export interface TranscriptionResponse {
  text: string;
}
