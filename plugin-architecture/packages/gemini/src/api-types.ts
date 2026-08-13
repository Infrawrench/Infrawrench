/**
 * Wire types for the Gemini API on **AI Studio**
 * (`https://generativelanguage.googleapis.com/v1beta`).
 *
 * This is not Vertex AI. Auth is the `x-goog-api-key` header — the legacy
 * `?key=` query parameter still works, but the header keeps the key out of
 * URLs and request logs.
 *
 * ⚠️ **There is no admin API, no usage API, no quota API and no billing API on
 * this host.** The live discovery document has zero occurrences of `billing`,
 * `apiKeys`, `admin` or `rateLimit`. Spend and quota live in the AI Studio UI
 * (and, underneath, in Google Cloud against the backing project, which needs
 * OAuth rather than an AI Studio key). The only in-API cost signal is the
 * per-response `usageMetadata` token count.
 *
 * Pagination is Google-standard everywhere: `pageSize` / `pageToken` →
 * `nextPageToken`. The page-size defaults and caps differ per collection and
 * are noted on each type.
 *
 * Shapes below are transcribed from the live discovery document
 * (`$discovery/rest?version=v1beta`) plus ai.google.dev.
 */

// -----------------------------------------------------------------------------
// Models — https://ai.google.dev/api/models
// -----------------------------------------------------------------------------

/** The complete `Model` schema. There are no other fields. */
export interface GeminiModel {
  name?: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  /** Marks models that emit reasoning tokens. */
  thinking?: boolean;
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
}

/** `pageSize` default 50, max 1000. */
export interface ListModelsResponse {
  models?: GeminiModel[];
  nextPageToken?: string;
}

// -----------------------------------------------------------------------------
// Tuned models — verified via the v1beta discovery document
// -----------------------------------------------------------------------------

/** `STATE_UNSPECIFIED | CREATING | ACTIVE | FAILED` — only four, no DELETING. */
type TunedModelState = "STATE_UNSPECIFIED" | "CREATING" | "ACTIVE" | "FAILED";

export interface TunedModel {
  name?: string;
  displayName?: string;
  description?: string;
  state?: TunedModelState;
  createTime?: string;
  updateTime?: string;
  baseModel?: string;
  tunedModelSource?: { tunedModel?: string; baseModel?: string };
  temperature?: number;
  topP?: number;
  topK?: number;
  readerProjectNumbers?: string[];
  tuningTask?: {
    startTime?: string;
    completeTime?: string;
    snapshots?: unknown[];
    hyperparameters?: {
      epochCount?: number;
      batchSize?: number;
      learningRate?: number;
      learningRateMultiplier?: number;
    };
  };
}

/** ⚠️ `pageSize` defaults to **10** here (max 1000), unlike `models`. */
export interface ListTunedModelsResponse {
  tunedModels?: TunedModel[];
  nextPageToken?: string;
}

// -----------------------------------------------------------------------------
// Files — https://ai.google.dev/api/files
// -----------------------------------------------------------------------------

type FileState = "STATE_UNSPECIFIED" | "PROCESSING" | "ACTIVE" | "FAILED";
type FileSource = "SOURCE_UNSPECIFIED" | "UPLOADED" | "GENERATED" | "REGISTERED";

export interface GeminiFile {
  name?: string;
  displayName?: string;
  mimeType?: string;
  /** int64 as a string. */
  sizeBytes?: string;
  createTime?: string;
  updateTime?: string;
  expirationTime?: string;
  /** base64-encoded bytes. */
  sha256Hash?: string;
  uri?: string;
  downloadUri?: string;
  state?: FileState;
  source?: FileSource;
  error?: RpcStatus;
  videoMetadata?: { videoDuration?: string };
}

/** ⚠️ `pageSize` defaults to 10 and caps at **100** for files. */
export interface ListFilesResponse {
  files?: GeminiFile[];
  nextPageToken?: string;
}

// -----------------------------------------------------------------------------
// Cached contents — https://ai.google.dev/api/caching
// -----------------------------------------------------------------------------

export interface CachedContent {
  name?: string;
  displayName?: string;
  model?: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  /** google.protobuf.Duration, e.g. "3.5s". */
  ttl?: string;
  usageMetadata?: { totalTokenCount?: number };
}

/** `pageSize` is coerced down to 1000. */
export interface ListCachedContentsResponse {
  cachedContents?: CachedContent[];
  nextPageToken?: string;
}

// -----------------------------------------------------------------------------
// Batches — https://ai.google.dev/api/batch-mode
// -----------------------------------------------------------------------------

/**
 * ⚠️ Batches is an **Operations** API. `GET /v1beta/batches` returns
 * `ListOperationsResponse` whose key is `operations[]` — not `batches[]` — and
 * each entry is a long-running `Operation` whose `metadata` holds the actual
 * `GenerateContentBatch`.
 */
export interface Operation {
  name?: string;
  done?: boolean;
  error?: RpcStatus;
  response?: Record<string, unknown>;
  metadata?: GenerateContentBatch;
}

export interface ListOperationsResponse {
  operations?: Operation[];
  nextPageToken?: string;
  unreachable?: string[];
}

/** The full documented `BatchState` enum. */
type BatchState =
  | "BATCH_STATE_UNSPECIFIED"
  | "BATCH_STATE_PENDING"
  | "BATCH_STATE_RUNNING"
  | "BATCH_STATE_SUCCEEDED"
  | "BATCH_STATE_FAILED"
  | "BATCH_STATE_CANCELLED"
  | "BATCH_STATE_EXPIRED";

interface GenerateContentBatch {
  name?: string;
  displayName?: string;
  model?: string;
  state?: BatchState;
  createTime?: string;
  updateTime?: string;
  endTime?: string;
  /** int64 as a string. */
  priority?: string;
  inputConfig?: { fileName?: string; requests?: unknown };
  output?: { responsesFile?: string; inlinedResponses?: unknown };
  /** All counts are int64 rendered as strings. */
  batchStats?: {
    requestCount?: string;
    successfulRequestCount?: string;
    failedRequestCount?: string;
    pendingRequestCount?: string;
  };
}

// -----------------------------------------------------------------------------
// File Search — https://ai.google.dev/api/file-search
// -----------------------------------------------------------------------------

export interface FileSearchStore {
  name?: string;
  displayName?: string;
  embeddingModel?: string;
  createTime?: string;
  updateTime?: string;
  /** int64 as strings. */
  activeDocumentsCount?: string;
  pendingDocumentsCount?: string;
  failedDocumentsCount?: string;
  sizeBytes?: string;
}

/** ⚠️ `pageSize` defaults to 10 and caps at **20** for stores and documents. */
export interface ListFileSearchStoresResponse {
  fileSearchStores?: FileSearchStore[];
  nextPageToken?: string;
}

/**
 * ⚠️ Documents use a different state-enum prefix from Files:
 * `STATE_PENDING` / `STATE_ACTIVE` / `STATE_FAILED`.
 */
type DocumentState = "STATE_UNSPECIFIED" | "STATE_PENDING" | "STATE_ACTIVE" | "STATE_FAILED";

export interface FileSearchDocument {
  name?: string;
  displayName?: string;
  mimeType?: string;
  sizeBytes?: string;
  state?: DocumentState;
  createTime?: string;
  updateTime?: string;
  customMetadata?: Array<{
    key?: string;
    stringValue?: string;
    numericValue?: number;
    stringListValue?: { values?: string[] };
  }>;
}

export interface ListFileSearchDocumentsResponse {
  documents?: FileSearchDocument[];
  nextPageToken?: string;
}

// -----------------------------------------------------------------------------
// Interactions (TTS) — https://ai.google.dev/api/interactions-api
// -----------------------------------------------------------------------------

/**
 * ⚠️ The Interactions API is **not** in the v1beta discovery document — it is
 * a separately hand-documented surface, though the route is live. Everything
 * below comes from ai.google.dev prose and the official code samples.
 *
 * `speech_config` is an **array** of speaker configs; a single-voice request
 * sends one entry.
 */
export interface InteractionRequest {
  model: string;
  input: string;
  response_format: { type: "audio" | "text" };
  generation_config?: {
    speech_config?: Array<{ voice?: string; speaker?: string; language?: string }>;
  };
}

/**
 * The base64 audio arrives at `interaction.output_audio.data`.
 *
 * `mime_type` is an enum that includes `audio/l16` — raw 16-bit linear PCM —
 * alongside real containers like `audio/wav` and `audio/mp3`. Gemini's TTS
 * models emit **headerless PCM at 24 000 Hz, mono, 16-bit**, which no browser
 * `<audio>` element can play, so the client reads `mime_type`, `sample_rate`
 * and `channels` at runtime and wraps the bytes in a WAV header itself when
 * the payload has no container.
 */
interface AudioContent {
  data?: string;
  mime_type?: string;
  sample_rate?: number;
  channels?: number;
}

export interface InteractionResponse {
  interaction?: {
    id?: string;
    status?: string;
    model?: string;
    created?: string;
    updated?: string;
    output_audio?: AudioContent;
    steps?: Array<{
      content?: Array<{ type?: string; data?: string; mime_type?: string; text?: string }>;
    }>;
    usage?: {
      total_input_tokens?: number;
      total_output_tokens?: number;
      total_tokens?: number;
    };
  };
}

// -----------------------------------------------------------------------------
// generateContent (STT) — https://ai.google.dev/api/generate-content
// -----------------------------------------------------------------------------

export interface GenerateContentRequest {
  contents: Array<{
    role?: string;
    parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }>;
  }>;
  generationConfig?: { temperature?: number; responseModalities?: string[] };
}

export interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }>; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
}

// -----------------------------------------------------------------------------

/** `google.rpc.Status`. */
interface RpcStatus {
  code?: number;
  message?: string;
  details?: unknown[];
}
