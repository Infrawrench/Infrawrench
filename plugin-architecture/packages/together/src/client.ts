import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
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
import {
  CostSetupError,
  base64ToBytes,
  bytesToBase64,
  joinSubtitle,
  jsonRestFetch,
  externalIdOf,
  formatBytes,
  withMetricsCapability,
  withAiCostTags,
} from "@infrawrench/plugin-base";
import { ManagedEndpointResourceType } from "./resources/managed-endpoint.js";

const API_BASE = "https://api.together.ai/v1";
/**
 * The v2 DMI operations carry a per-operation server override in Together's
 * OpenAPI document: `api.together.ai/v2`, NOT the global inference host
 * `api-inference.together.ai/v2`. Getting this wrong 404s.
 */
const API_BASE_V2 = "https://api.together.ai/v2";

/**
 * Text-to-speech models Together documents for `POST /v1/audio/speech`.
 * https://docs.together.ai/docs/text-to-speech
 */
const TTS_MODELS: Array<{ id: string; label: string; description: string }> = [
  {
    id: "cartesia/sonic",
    label: "Cartesia Sonic",
    description: "Text-to-speech · voice cloning catalogue",
  },
  {
    id: "hexgrad/Kokoro-82M",
    label: "Kokoro 82M",
    description: "Text-to-speech · 54 voices, mixable",
  },
  {
    id: "canopylabs/orpheus-3b-0.1-ft",
    label: "Orpheus 3B",
    description: "Text-to-speech · expressive, 8 voices",
  },
];

/**
 * The only model `POST /v1/audio/transcriptions` documents in its enum.
 * https://docs.together.ai/docs/speech-to-text
 */
const STT_MODEL = "openai/whisper-large-v3";

const SPEECH_MODEL_IDS = new Set([...TTS_MODELS.map((model) => model.id), STT_MODEL]);

/**
 * Fallback voice lists, used when `GET /v1/voices` is unavailable. Kokoro and
 * Orpheus publish fixed rosters; Cartesia does not, which is exactly why the
 * live call is preferred.
 * https://docs.together.ai/docs/text-to-speech
 */
const FALLBACK_VOICES: Record<string, string[]> = {
  "canopylabs/orpheus-3b-0.1-ft": ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"],
  "hexgrad/Kokoro-82M": [
    "af_heart",
    "af_alloy",
    "af_aoede",
    "af_bella",
    "af_jessica",
    "af_kore",
    "af_nicole",
    "af_nova",
    "af_river",
    "af_sarah",
    "af_sky",
    "am_adam",
    "am_echo",
    "am_eric",
    "am_fenrir",
    "am_liam",
    "am_michael",
    "am_onyx",
    "am_puck",
    "am_santa",
    "bf_alice",
    "bf_emma",
    "bf_isabella",
    "bf_lily",
    "bm_daniel",
    "bm_fable",
    "bm_george",
    "bm_lewis",
    "jf_alpha",
    "jf_gongitsune",
    "jf_nezumi",
    "jf_tebukuro",
    "jm_kumo",
    "zf_xiaobei",
    "zf_xiaoni",
    "zf_xiaoxiao",
    "zf_xiaoyi",
    "zm_yunjian",
    "zm_yunxi",
    "zm_yunxia",
    "zm_yunyang",
    "ef_dora",
    "em_alex",
    "em_santa",
    "ff_siwis",
    "hf_alpha",
    "hf_beta",
    "hm_omega",
    "hm_psi",
    "if_sara",
    "im_nicola",
    "pf_dora",
    "pm_alex",
    "pm_santa",
  ],
};

const DEFAULT_TTS_MODEL = "hexgrad/Kokoro-82M";
const DEFAULT_TTS_VOICE = "af_heart";

/**
 * Together accepts a 500 MB binary upload on `/v1/audio/transcriptions`, but
 * the Speech tab base64-encodes the clip through ordinary JSON, so we advertise
 * a much lower ceiling and let the host reject oversized files before encoding.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wire shapes: mirrored from https://docs.together.ai/openapi.yaml (2.0.0)
// ---------------------------------------------------------------------------

interface WhoAmI {
  api_key_id?: string;
  project_id?: string;
  project_name?: string;
  project_slug?: string;
  organization_id?: string;
  organization_name?: string;
  user_id?: string;
}

interface TogetherModel {
  id: string;
  object?: string;
  created?: number;
  type?: string;
  display_name?: string;
  organization?: string;
  link?: string;
  license?: string;
  context_length?: number;
  pricing?: {
    base?: number;
    finetune?: number;
    hourly?: number;
    input?: number;
    output?: number;
    cached_input?: number;
  } | null;
}

interface FineTuneJob {
  id?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  model?: string;
  /** Wire name. The Python SDK aliases this to `output_name`; the API does not. */
  model_output_name?: string;
  training_file?: string;
  validation_file?: string;
  training_type?: { type?: string; lora_r?: number } | null;
  n_epochs?: number;
  batch_size?: number | string;
  learning_rate?: number;
  token_count?: number;
  total_price?: number;
  progress?: number;
  wandb_url?: string;
  epochs_completed?: number;
}

interface TogetherFile {
  id?: string;
  object?: string;
  created_at?: number;
  filename?: string;
  bytes?: number;
  purpose?: string;
  FileType?: string;
  /** Undocumented in the OpenAPI spec but still emitted; the Python SDK maps it. */
  LineCount?: number;
  processing_status?: string;
  validation_report?: { valid?: boolean; nlines?: number; error?: string } | null;
}

/** `GET /v1/endpoints` items are narrower than `GET /v1/endpoints/{id}`. */
interface ListEndpoint {
  id?: string;
  object?: string;
  name?: string;
  model?: string;
  type?: string;
  owner?: string;
  state?: string;
  created_at?: string;
}

interface DedicatedEndpoint extends ListEndpoint {
  display_name?: string;
  hardware?: string;
  autoscaling?: { min_replicas?: number; max_replicas?: number } | null;
}

interface TogetherHardware {
  object?: string;
  id?: string;
  pricing?: { cents_per_minute?: number } | null;
  specs?: {
    gpu_type?: string;
    gpu_link?: string;
    gpu_memory?: number;
    gpu_count?: number;
  } | null;
  availability?: { status?: string } | null;
  updated_at?: string;
}

interface BatchJob {
  id?: string;
  user_id?: string;
  input_file_id?: string;
  file_size_bytes?: number;
  status?: string;
  job_deadline?: string;
  created_at?: string;
  endpoint?: string;
  progress?: number;
  model_id?: string;
  output_file_id?: string;
  error_file_id?: string;
  error?: string;
  completed_at?: string;
}

interface EvaluationJob {
  /** There is no `id` on this object: `workflow_id` is the identifier. */
  workflow_id?: string;
  type?: string;
  owner_id?: string;
  status?: string;
  parameters?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  results?: unknown;
}

/** v2 Dedicated Managed Inference endpoint. camelCase, unlike everything in v1. */
interface DmiEndpoint {
  name?: string;
  id?: string;
  projectId?: string;
  createdAt?: string;
  updatedAt?: string;
  etag?: string;
  deployments?: unknown[];
  trafficSplit?: Array<{ deploymentId?: string; weight?: number }>;
  visibility?: string;
  endpointType?: string;
  activeRolloutId?: string;
}

interface DmiDeployment {
  id?: string;
  name?: string;
  state?: string;
}

/** v2 list envelope. Note the snake_case cursor in an otherwise camelCase body. */
interface DmiListResponse<T> {
  data?: T[];
  object?: string;
  next_cursor?: string | null;
}

interface VoiceCatalogEntry {
  model?: string;
  voices?: Array<{ id?: string; name?: string }>;
}

interface TranscriptionWord {
  word?: string;
  start?: number;
  end?: number;
  speaker_id?: string;
}

interface TranscriptionResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ id?: number; start?: number; end?: number; text?: string }>;
  words?: TranscriptionWord[];
  speaker_segments?: Array<{
    speaker_id?: string;
    start?: number;
    end?: number;
    text?: string;
    id?: number;
  }>;
}

/**
 * `GET /v1/billing/usage`. Every money and quantity value is a decimal
 * string, and `product_name` is a display name Together may rename.
 * https://docs.together.ai/reference/billing-usage
 */
interface BillingUsageLineItem {
  product_name?: string;
  quantity?: string;
  unit_price?: string;
  cost?: string;
  pricing_dimensions?: Record<string, string> | null;
  attributes?: Record<string, string> | null;
}

interface BillingUsageWindow {
  /** `YYYY-MM-DD`, UTC, for both granularities. */
  date?: string;
  start_time?: string;
  end_time?: string;
  line_items?: BillingUsageLineItem[];
}

interface BillingUsageReport {
  object?: string;
  organization_id?: string;
  billing_period?: string;
  currency?: string;
  data?: BillingUsageWindow[];
  next_cursor?: string | null;
}

/**
 * `GET /v2/projects/{projectId}/endpoints/{id}/analytics`. Counts are int64
 * and therefore strings on the wire; rates, percentiles and percentages are
 * numbers. https://docs.together.ai/reference/dmi/endpoints-analytics
 */
interface DmiEndpointMetrics {
  requestMetrics?: {
    totalRequests?: string;
    successfulRequests?: string;
    failedRequests?: string;
    requestsPerSecond?: number;
    requestsByStatusCode?: Record<string, string>;
  } | null;
  latencyMetrics?: {
    ttftP50Ms?: number;
    ttftP90Ms?: number;
    ttftP99Ms?: number;
    latencyP50Ms?: number;
    latencyP90Ms?: number;
    latencyP99Ms?: number;
    itlP50Ms?: number;
    itlP90Ms?: number;
    itlP99Ms?: number;
  } | null;
  throughputMetrics?: {
    tokensPerSecond?: number;
    requestsPerSecond?: number;
    avgBatchSize?: number;
    avgBatchDepth?: number;
  } | null;
  /** `errorRate` is a percentage in [0, 100], not a fraction. */
  errorMetrics?: { errorRate?: number; errorsByType?: Record<string, string> } | null;
  resourceUtilization?: {
    cpuUtilization?: number;
    gpuUtilization?: number;
    memoryUtilization?: number;
    gpuMemoryUtilization?: number;
    networkBandwidthMbps?: number;
  } | null;
  tokenMetrics?: {
    totalInputTokens?: string;
    totalOutputTokens?: string;
    avgInputTokens?: number;
    avgOutputTokens?: number;
  } | null;
}

interface DmiAnalytics {
  endpointId?: string;
  timeRange?: { startTime?: string; endTime?: string } | null;
  metrics?: DmiEndpointMetrics | null;
  /** Only present with `includeTimeSeries=true`. Metric names are not enumerated. */
  timeSeries?: Array<{ timestamp?: string; values?: Record<string, number> }>;
}

/**
 * `DE.EndpointEvent`, from `GET /v2/projects/{projectId}/endpoints/{id}/events`:
 * endpoint and deployment lifecycle events, newest first.
 * https://docs.together.ai/reference/dmi/endpoints-list-events
 */
interface DmiEndpointEvent {
  id?: string;
  createdAt?: string;
  level?: string;
  type?: string;
  message?: string;
  source?: string;
  sourceKind?: string;
  deploymentId?: string;
  subjectId?: string;
  name?: string;
  oldReplicas?: number;
  newReplicas?: number;
  status?: string;
  reason?: string;
  containerName?: string;
  logExcerpt?: string;
}

/** `GPUClusterInfo`, from `/v1/compute/clusters`. */
interface GpuCluster {
  cluster_id?: string;
  cluster_name?: string;
  cluster_type?: string;
  region?: string;
  gpu_type?: string;
  status?: string;
  num_gpus?: number;
  num_reserved_gpus?: number;
  num_capacity_pool_gpus?: number;
  desired_preemptible_gpus?: number;
  allocated_preemptible_gpus?: number;
  num_cpu_workers?: number;
  billing_type?: string;
  cuda_version?: string;
  nvidia_driver_version?: string;
  /** Never mapped onto the listing: served only through `resolveOutput`. */
  kube_config?: string;
  duration_hours?: number;
  reservation_start_time?: string;
  reservation_end_time?: string;
  created_at?: string;
  volumes?: Array<{ volume_id?: string; volume_name?: string; size_tib?: number; status?: string }>;
  control_plane_nodes?: GpuClusterNode[];
  gpu_worker_nodes?: GpuClusterNode[];
}

interface GpuClusterNode {
  node_id?: string;
  status?: string;
  host_name?: string;
  num_cpu_cores?: number;
  num_gpus?: number;
  memory_gib?: number;
}

/** `GET /v1/compute/regions`. */
interface ComputeRegion {
  name?: string;
  supported_instance_types?: string[];
  driver_versions?: Array<{
    id?: string;
    cuda_version?: string;
    nvidia_driver_version?: string;
    os?: string;
  }>;
}

/** `/v1/compute/clusters/storage/volumes`. The object carries no region. */
interface SharedVolume {
  volume_id?: string;
  volume_name?: string;
  size_tib?: number;
  status?: string;
}

/** `GET /v1/fine-tunes/{id}/events`. */
interface FineTuneEvent {
  created_at?: string;
  level?: string | null;
  message?: string;
  type?: string;
  step?: number;
}

/** `GET /v1/fine-tunes/{id}/checkpoints`. */
interface FineTuneCheckpoint {
  step?: number;
  created_at?: string;
  path?: string;
  checkpoint_type?: string;
  object_name?: string;
}

/** Shape stashed under the `__workers__` resolved output of a GPU cluster. */
interface StashedNode {
  host: string;
  status: string;
  gpus: number | null;
  cpus: number | null;
  memoryGib: number | null;
}

/** Shape stashed under the `__volumes__` resolved output of a GPU cluster. */
interface StashedVolume {
  id: string;
  name: string;
  sizeTib: number | null;
  status: string;
}

/** Shape stashed under the `__voices__` resolved output. */
interface StashedVoice {
  model: string;
  value: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
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
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** `GET /v1/endpoints` reports six states; create/update accept only two of them. */
function mapEndpointState(state: string | undefined): { status: ResourceStatus; label: string } {
  switch (state) {
    case "STARTED":
      return { status: "healthy", label: "Started" };
    case "STARTING":
    case "PENDING":
      return { status: "provisioning", label: titleCase(state) };
    case "STOPPING":
      return { status: "degraded", label: "Stopping" };
    case "STOPPED":
      return { status: "info", label: "Stopped" };
    case "ERROR":
      return { status: "error", label: "Error" };
    default:
      return { status: "info", label: state ? titleCase(state) : "Unknown" };
  }
}

/** Nine-value fine-tune status enum. */
function mapFineTuneStatus(status: string | undefined): { status: ResourceStatus; label: string } {
  switch (status) {
    case "completed":
      return { status: "healthy", label: "Completed" };
    case "running":
    case "compressing":
    case "uploading":
      return { status: "provisioning", label: titleCase(status) };
    case "pending":
    case "queued":
      return { status: "provisioning", label: titleCase(status) };
    case "cancel_requested":
      return { status: "degraded", label: "Cancel Requested" };
    case "cancelled":
      return { status: "unknown", label: "Cancelled" };
    case "error":
      return { status: "error", label: "Error" };
    default:
      return { status: "info", label: status ? titleCase(status) : "Unknown" };
  }
}

function mapBatchStatus(status: string | undefined): { status: ResourceStatus; label: string } {
  switch (status) {
    case "COMPLETED":
      return { status: "healthy", label: "Completed" };
    case "IN_PROGRESS":
    case "VALIDATING":
      return { status: "provisioning", label: titleCase(status) };
    case "FAILED":
      return { status: "error", label: "Failed" };
    case "EXPIRED":
      return { status: "degraded", label: "Expired" };
    case "CANCELLED":
      return { status: "unknown", label: "Cancelled" };
    default:
      return { status: "info", label: status ? titleCase(status) : "Unknown" };
  }
}

function mapEvaluationStatus(status: string | undefined): {
  status: ResourceStatus;
  label: string;
} {
  switch (status) {
    case "completed":
      return { status: "healthy", label: "Completed" };
    case "running":
    case "queued":
    case "pending":
      return { status: "provisioning", label: titleCase(status) };
    case "error":
      return { status: "error", label: "Error" };
    case "user_error":
      return { status: "error", label: "User Error" };
    default:
      return { status: "info", label: status ? titleCase(status) : "Unknown" };
  }
}

/** `GPUClusterInfo.status`, an eleven-value enum. */
function mapClusterStatus(status: string | undefined): { status: ResourceStatus; label: string } {
  switch (status) {
    case "Ready":
      return { status: "healthy", label: "Ready" };
    case "WaitingForControlPlaneNodes":
    case "WaitingForDataPlaneNodes":
    case "WaitingForSubnet":
    case "WaitingForSharedVolume":
    case "InstallingDrivers":
    case "RunningAcceptanceTests":
      return { status: "provisioning", label: splitPascal(status) };
    case "Paused":
    case "OnDemandComputePaused":
      return { status: "info", label: splitPascal(status) };
    case "Degraded":
      return { status: "degraded", label: "Degraded" };
    case "Deleting":
      return { status: "degraded", label: "Deleting" };
    default:
      return { status: "info", label: status ? splitPascal(status) : "Unknown" };
  }
}

/** `GPUClustersSharedVolume.status`. `bound` means attached to a cluster. */
function mapVolumeStatus(status: string | undefined): { status: ResourceStatus; label: string } {
  switch (status) {
    case "available":
    case "bound":
      return { status: "healthy", label: titleCase(status) };
    case "scheduled":
    case "provisioning":
      return { status: "provisioning", label: titleCase(status) };
    case "deleting":
      return { status: "degraded", label: "Deleting" };
    case "failed":
    case "access_revoked":
      return { status: "error", label: titleCase(status) };
    default:
      return { status: "unknown", label: status ? titleCase(status) : "Unknown" };
  }
}

/** `WaitingForControlPlaneNodes` → `Waiting For Control Plane Nodes`. */
function splitPascal(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Cluster GPU enum → a readable label: `H100_SXM` → `H100 SXM`. */
function gpuTypeLabel(value: string): string {
  return value.replace(/_/g, " ");
}

/** The `gpu_type` enum documented on `GPUClusterCreateRequest`. */
const CLUSTER_GPU_TYPES = [
  "H100_SXM",
  "H200_SXM",
  "B200_SXM",
  "B300_SXM",
  "H100_SXM_INF",
  "L40_PCIE",
  "RTX_6000_PCI",
];

/** Billing usage amounts and analytics token totals are decimal strings. */
function decimal(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Every `YYYY-MM` touched by an inclusive `YYYY-MM-DD` range. */
function monthsInRange(fromDate: string, toDate: string): string[] {
  const months: string[] = [];
  let year = Number(fromDate.slice(0, 4));
  let month = Number(fromDate.slice(5, 7));
  const lastYear = Number(toDate.slice(0, 4));
  const lastMonth = Number(toDate.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * Analytics buckets come in `1m`, `1h` or `1d`. Pick the finest that keeps a
 * chart to a few hundred points.
 */
function analyticsGranularity(spanMs: number): "1m" | "1h" | "1d" {
  if (spanMs <= 6 * 60 * 60 * 1000) return "1m";
  if (spanMs <= 14 * 24 * 60 * 60 * 1000) return "1h";
  return "1d";
}

/**
 * Labels and units for the analytics time-series keys. The spec leaves the
 * keys open (`additionalProperties: number`); these are the documented
 * aggregate names, and anything else is labelled from its own name.
 */
const ANALYTICS_SERIES: Record<string, { label: string; unit?: string }> = {
  requestsPerSecond: { label: "Requests / s", unit: "req/s" },
  tokensPerSecond: { label: "Tokens / s", unit: "tokens/s" },
  totalRequests: { label: "Requests", unit: "requests" },
  successfulRequests: { label: "Successful Requests", unit: "requests" },
  failedRequests: { label: "Failed Requests", unit: "requests" },
  errorRate: { label: "Error Rate", unit: "%" },
  ttftP50Ms: { label: "TTFT p50", unit: "ms" },
  ttftP90Ms: { label: "TTFT p90", unit: "ms" },
  ttftP99Ms: { label: "TTFT p99", unit: "ms" },
  latencyP50Ms: { label: "Latency p50", unit: "ms" },
  latencyP90Ms: { label: "Latency p90", unit: "ms" },
  latencyP99Ms: { label: "Latency p99", unit: "ms" },
  itlP50Ms: { label: "Inter-token Latency p50", unit: "ms" },
  itlP90Ms: { label: "Inter-token Latency p90", unit: "ms" },
  itlP99Ms: { label: "Inter-token Latency p99", unit: "ms" },
  cpuUtilization: { label: "CPU Utilization", unit: "%" },
  gpuUtilization: { label: "GPU Utilization", unit: "%" },
  memoryUtilization: { label: "Memory Utilization", unit: "%" },
  gpuMemoryUtilization: { label: "GPU Memory Utilization", unit: "%" },
  networkBandwidthMbps: { label: "Network Bandwidth", unit: "Mbps" },
  avgBatchSize: { label: "Average Batch Size" },
  avgBatchDepth: { label: "Average Batch Depth" },
  totalInputTokens: { label: "Input Tokens", unit: "tokens" },
  totalOutputTokens: { label: "Output Tokens", unit: "tokens" },
  avgInputTokens: { label: "Average Input Tokens", unit: "tokens" },
  avgOutputTokens: { label: "Average Output Tokens", unit: "tokens" },
};

function analyticsSeriesMeta(key: string): { label: string; unit?: string } {
  const known = ANALYTICS_SERIES[key];
  if (known) return known;
  const label = titleCase(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  if (/Ms$/.test(key)) return { label: label.replace(/ Ms$/, ""), unit: "ms" };
  if (/(Utilization|Rate)$/.test(key)) return { label, unit: "%" };
  return { label };
}

/**
 * One event as a log line: time, level, type, source, then the message and
 * whichever typed detail the event type populates.
 */
function formatEndpointEvent(event: DmiEndpointEvent): string {
  const level = (event.level ?? "").replace(/^LEVEL_/, "") || "INFO";
  const details: string[] = [];
  if (event.deploymentId) details.push(`deployment=${event.deploymentId}`);
  if (event.name) details.push(`name=${event.name}`);
  if (event.oldReplicas != null || event.newReplicas != null) {
    details.push(`replicas=${event.oldReplicas ?? "?"}->${event.newReplicas ?? "?"}`);
  }
  if (event.subjectId) details.push(`subject=${event.subjectId}`);
  if (event.status) details.push(`status=${event.status}`);
  if (event.reason) details.push(`reason=${event.reason}`);
  if (event.containerName) details.push(`container=${event.containerName}`);
  const head = [
    event.createdAt ?? "",
    level.padEnd(5),
    event.type ?? "",
    event.source ? `[${event.source}]` : "",
    event.message ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const line = details.length ? `${head} (${details.join(", ")})` : head;
  // A pod event can carry a short crash or OOM excerpt; indent it under the line.
  const excerpt = event.logExcerpt?.trim();
  return excerpt
    ? `${line}\n${excerpt
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")}`
    : line;
}

function formatMs(value: number | undefined): string {
  return value == null ? "" : `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

function formatPercent(value: number | undefined): string {
  return value == null ? "" : `${value.toFixed(1)}%`;
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

/** Best-effort extension for the multipart filename Whisper sees. */
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

/**
 * Together AI plugin client. One instance per account (per API key).
 *
 * Spend comes from `GET /v1/billing/usage` (beta, enabled per organization;
 * a 404 means it is not switched on yet). There is still **no key-management
 * API**: keys are created and revoked in the Together dashboard only.
 * https://docs.together.ai/reference/billing-usage
 * https://docs.together.ai/reference/whoami
 */
export class TogetherClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;
  private whoamiCache: WhoAmI | null = null;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Together plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private async request<T>(url: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Together",
      url,
      errorPath: url.startsWith(API_BASE) ? url.slice(API_BASE.length) || "/" : url,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(`${API_BASE}${path}`, options);
  }

  /**
   * `GET /v1/whoami` validates the key and hands back the project the key
   * belongs to. The v2 DMI paths need `project_id`, so we discover it here
   * instead of asking the user to paste it.
   * https://docs.together.ai/reference/whoami
   */
  private async whoami(): Promise<WhoAmI> {
    if (this.whoamiCache) return this.whoamiCache;
    const identity = await this.fetch<WhoAmI>("/whoami");
    this.whoamiCache = identity;
    return identity;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model": {
        const models = await this.fetchModels();
        return models.map((model) => this.mapModel(model, accountId));
      }
      case "fine-tune": {
        // `{ data: [...] }`. No pagination params documented on this route.
        const data = await this.fetch<{ data?: FineTuneJob[] }>("/fine-tunes");
        return (data.data ?? []).map((job) => this.mapFineTune(job, accountId));
      }
      case "file": {
        const data = await this.fetch<{ data?: TogetherFile[] }>("/files");
        return (data.data ?? []).map((file) => this.mapFile(file, accountId));
      }
      case "endpoint": {
        // v1 lists are a flat `{ object, data }` with NO pagination params at all.
        const data = await this.fetch<{ data?: ListEndpoint[] }>("/endpoints");
        return (data.data ?? []).map((endpoint) => this.mapEndpoint(endpoint, accountId));
      }
      case "managed-endpoint":
        return this.listManagedEndpoints(accountId);
      case "hardware": {
        const data = await this.fetch<{ data?: TogetherHardware[] }>("/hardware");
        return (data.data ?? []).map((hardware) => this.mapHardware(hardware, accountId));
      }
      case "batch": {
        // Bare array, not a `{ data }` envelope: the one v1 list that differs.
        const batches = await this.fetch<BatchJob[]>("/batches");
        return (Array.isArray(batches) ? batches : []).map((batch) =>
          this.mapBatch(batch, accountId),
        );
      }
      case "gpu-cluster": {
        // `{ clusters: [...] }`, no pagination params.
        // https://docs.together.ai/reference/clusters-list
        const data = await this.fetch<{ clusters?: GpuCluster[] }>("/compute/clusters");
        return (data.clusters ?? []).map((cluster) => this.mapCluster(cluster, accountId));
      }
      case "shared-volume": {
        // `{ volumes: [...] }`. https://docs.together.ai/reference/clusters_storages-list
        const data = await this.fetch<{ volumes?: SharedVolume[] }>(
          "/compute/clusters/storage/volumes",
        );
        return (data.volumes ?? []).map((volume) => this.mapVolume(volume, accountId));
      }
      case "evaluation": {
        // Path is `/evaluation`, singular. Also a bare array.
        const evaluations = await this.fetch<EvaluationJob[]>("/evaluation?limit=100");
        return (Array.isArray(evaluations) ? evaluations : []).map((evaluation) =>
          this.mapEvaluation(evaluation, accountId),
        );
      }
      default:
        throw new Error(`Together plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * `GET /v1/models` answers a bare array (no envelope, no pagination).
   *
   * Together's `type` enum has no audio member, so the documented speech models
   * can be missing from the catalogue response. We union them in when absent so
   * the Speech tab always has a resource to hang off; anything Together did
   * return keeps its own metadata untouched.
   */
  private async fetchModels(): Promise<TogetherModel[]> {
    const models = await this.fetch<TogetherModel[]>("/models");
    const list = Array.isArray(models) ? [...models] : [];
    const present = new Set(list.map((model) => model.id));
    for (const id of SPEECH_MODEL_IDS) {
      if (!present.has(id)) {
        const known = TTS_MODELS.find((model) => model.id === id);
        list.push({
          id,
          type: "audio",
          ...(known ? { display_name: known.label } : { display_name: "Whisper Large v3" }),
          ...(id.includes("/") ? { organization: id.split("/")[0] ?? "" } : {}),
        });
      }
    }
    return list;
  }

  /**
   * v2 Dedicated Managed Inference. Unlike every v1 list, this one paginates:
   * `limit` + `after`, with the next cursor in `next_cursor` (null at the end).
   * The project id comes from `/v1/whoami`.
   */
  private async listManagedEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const { project_id: projectId } = await this.whoami();
    if (!projectId) return [];
    const endpoints: DmiEndpoint[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const cursor = after ? `&after=${encodeURIComponent(after)}` : "";
      const data = await this.request<DmiListResponse<DmiEndpoint>>(
        `${API_BASE_V2}/projects/${encodeURIComponent(projectId)}/endpoints?limit=100${cursor}`,
      );
      endpoints.push(...(data.data ?? []));
      if (!data.next_cursor) break;
      after = data.next_cursor;
    }
    return endpoints.map((endpoint) => this.mapManagedEndpoint(endpoint, accountId));
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapModel(model: TogetherModel, accountId: string): ResourceInstance {
    const name = model.display_name ?? model.id;
    const createdAt = unixToIso(model.created) || nowIso();
    const pricing = model.pricing ?? {};
    return {
      id: `${accountId}:model:${model.id}`,
      pluginId: "together",
      resourceTypeId: "model",
      accountId,
      displayName: name,
      fields: {
        name,
        modelId: model.id,
        ...(model.type ? { type: model.type } : {}),
        ...(model.organization ? { organization: model.organization } : {}),
        ...(model.context_length != null ? { contextLength: model.context_length } : {}),
        ...(model.license ? { license: model.license } : {}),
        ...(model.link ? { link: model.link } : {}),
        ...(pricing.input != null ? { inputPrice: pricing.input } : {}),
        ...(pricing.output != null ? { outputPrice: pricing.output } : {}),
        ...(pricing.hourly != null ? { hourlyPrice: pricing.hourly } : {}),
        ...(pricing.finetune != null ? { finetunePrice: pricing.finetune } : {}),
        createdAt,
      },
      resolvedOutputs: {
        modelId: model.id,
        modelName: name,
        modelType: model.type ?? "",
      },
      secretStates: [],
      externalId: model.id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapFineTune(job: FineTuneJob, accountId: string): ResourceInstance {
    const id = job.id ?? "";
    const createdAt = job.created_at ?? nowIso();
    const training = job.training_type ?? {};
    return {
      id: `${accountId}:fine-tune:${id}`,
      pluginId: "together",
      resourceTypeId: "fine-tune",
      accountId,
      displayName: job.model_output_name ?? id,
      fields: {
        jobId: id,
        ...(job.status ? { status: job.status } : {}),
        ...(job.model ? { baseModel: job.model } : {}),
        ...(job.model_output_name ? { outputName: job.model_output_name } : {}),
        ...(job.training_file ? { trainingFile: job.training_file } : {}),
        ...(job.validation_file ? { validationFile: job.validation_file } : {}),
        ...(training.type ? { trainingType: training.type } : {}),
        ...(training.lora_r != null ? { loraRank: training.lora_r } : {}),
        ...(job.n_epochs != null ? { epochs: job.n_epochs } : {}),
        ...(job.batch_size != null && !Number.isNaN(Number(job.batch_size))
          ? { batchSize: Number(job.batch_size) }
          : {}),
        ...(job.learning_rate != null ? { learningRate: job.learning_rate } : {}),
        ...(job.token_count != null ? { tokenCount: job.token_count } : {}),
        ...(job.total_price != null ? { totalPrice: job.total_price } : {}),
        createdAt,
        ...(job.updated_at ? { updatedAt: job.updated_at } : {}),
      },
      resolvedOutputs: {
        jobId: id,
        outputName: job.model_output_name ?? "",
        status: job.status ?? "",
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: job.updated_at ?? createdAt,
    };
  }

  private mapFile(file: TogetherFile, accountId: string): ResourceInstance {
    const id = file.id ?? "";
    const createdAt = unixToIso(file.created_at) || nowIso();
    const report = file.validation_report ?? {};
    // `LineCount` is undocumented; `validation_report.nlines` is the documented
    // equivalent. Prefer whichever is present.
    const lines = file.LineCount ?? report.nlines;
    return {
      id: `${accountId}:file:${id}`,
      pluginId: "together",
      resourceTypeId: "file",
      accountId,
      displayName: file.filename ?? id,
      fields: {
        filename: file.filename ?? id,
        fileId: id,
        ...(file.purpose ? { purpose: file.purpose } : {}),
        ...(file.FileType ? { fileType: file.FileType } : {}),
        ...(file.bytes != null ? { bytes: file.bytes } : {}),
        ...(lines != null ? { lineCount: lines } : {}),
        ...(file.processing_status ? { processingStatus: file.processing_status } : {}),
        ...(report.error ? { validationError: report.error } : {}),
        createdAt,
      },
      resolvedOutputs: { fileId: id, filename: file.filename ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapEndpoint(endpoint: DedicatedEndpoint, accountId: string): ResourceInstance {
    const id = endpoint.id ?? "";
    const createdAt = endpoint.created_at ?? nowIso();
    const autoscaling = endpoint.autoscaling ?? {};
    const displayName = endpoint.display_name ?? endpoint.name ?? id;
    return {
      id: `${accountId}:endpoint:${id}`,
      pluginId: "together",
      resourceTypeId: "endpoint",
      accountId,
      displayName,
      fields: {
        displayName,
        endpointId: id,
        ...(endpoint.name ? { name: endpoint.name } : {}),
        model: endpoint.model ?? "",
        ...(endpoint.hardware ? { hardware: endpoint.hardware } : {}),
        ...(endpoint.state ? { state: endpoint.state } : {}),
        ...(autoscaling.min_replicas != null ? { minReplicas: autoscaling.min_replicas } : {}),
        ...(autoscaling.max_replicas != null ? { maxReplicas: autoscaling.max_replicas } : {}),
        ...(endpoint.type ? { type: endpoint.type } : {}),
        ...(endpoint.owner ? { owner: endpoint.owner } : {}),
        createdAt,
      },
      resolvedOutputs: {
        endpointId: id,
        endpointName: endpoint.name ?? "",
        baseUrl: API_BASE,
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapManagedEndpoint(endpoint: DmiEndpoint, accountId: string): ResourceInstance {
    const id = endpoint.id ?? "";
    const createdAt = endpoint.createdAt ?? nowIso();
    return {
      id: `${accountId}:managed-endpoint:${id}`,
      pluginId: "together",
      resourceTypeId: "managed-endpoint",
      accountId,
      displayName: endpoint.name ?? id,
      fields: {
        name: endpoint.name ?? id,
        endpointId: id,
        ...(endpoint.projectId ? { projectId: endpoint.projectId } : {}),
        ...(endpoint.endpointType ? { endpointType: endpoint.endpointType } : {}),
        ...(endpoint.visibility ? { visibility: endpoint.visibility } : {}),
        deploymentCount: endpoint.deployments?.length ?? 0,
        ...(endpoint.etag ? { etag: endpoint.etag } : {}),
        createdAt,
        ...(endpoint.updatedAt ? { updatedAt: endpoint.updatedAt } : {}),
      },
      resolvedOutputs: { endpointId: id, endpointName: endpoint.name ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: endpoint.updatedAt ?? createdAt,
    };
  }

  private mapCluster(cluster: GpuCluster, accountId: string): ResourceInstance {
    const id = cluster.cluster_id ?? "";
    const createdAt = cluster.created_at ?? nowIso();
    const name = cluster.cluster_name ?? id;
    const volumes: StashedVolume[] = (cluster.volumes ?? []).map((volume) => ({
      id: volume.volume_id ?? "",
      name: volume.volume_name ?? volume.volume_id ?? "",
      sizeTib: volume.size_tib ?? null,
      status: volume.status ?? "",
    }));
    const workers: StashedNode[] = (cluster.gpu_worker_nodes ?? []).map((node) => ({
      host: node.host_name ?? node.node_id ?? "",
      status: node.status ?? "",
      gpus: node.num_gpus ?? null,
      cpus: node.num_cpu_cores ?? null,
      memoryGib: node.memory_gib ?? null,
    }));
    return {
      id: `${accountId}:gpu-cluster:${id}`,
      pluginId: "together",
      resourceTypeId: "gpu-cluster",
      accountId,
      displayName: name,
      fields: {
        clusterName: name,
        clusterId: id,
        ...(cluster.status ? { status: cluster.status } : {}),
        ...(cluster.cluster_type ? { clusterType: cluster.cluster_type } : {}),
        ...(cluster.region ? { region: cluster.region } : {}),
        ...(cluster.gpu_type ? { gpuType: cluster.gpu_type } : {}),
        ...(cluster.num_gpus != null ? { numGpus: cluster.num_gpus } : {}),
        ...(cluster.num_reserved_gpus != null
          ? { numReservedGpus: cluster.num_reserved_gpus }
          : {}),
        ...(cluster.desired_preemptible_gpus != null
          ? { desiredPreemptibleGpus: cluster.desired_preemptible_gpus }
          : {}),
        ...(cluster.allocated_preemptible_gpus != null
          ? { allocatedPreemptibleGpus: cluster.allocated_preemptible_gpus }
          : {}),
        ...(cluster.billing_type ? { billingType: cluster.billing_type } : {}),
        ...(cluster.cuda_version ? { cudaVersion: cluster.cuda_version } : {}),
        ...(cluster.nvidia_driver_version
          ? { nvidiaDriverVersion: cluster.nvidia_driver_version }
          : {}),
        ...(cluster.num_cpu_workers != null ? { numCpuWorkers: cluster.num_cpu_workers } : {}),
        gpuWorkerCount: cluster.gpu_worker_nodes?.length ?? 0,
        controlPlaneCount: cluster.control_plane_nodes?.length ?? 0,
        ...(volumes[0]?.id ? { volumeId: volumes[0].id } : {}),
        ...(cluster.reservation_start_time
          ? { reservationStartTime: cluster.reservation_start_time }
          : {}),
        ...(cluster.reservation_end_time
          ? { reservationEndTime: cluster.reservation_end_time }
          : {}),
        createdAt,
      },
      // `kube_config` is deliberately absent: `resolveOutput` fetches it on
      // demand so the credential is never written alongside the listing.
      resolvedOutputs: {
        clusterId: id,
        clusterName: name,
        region: cluster.region ?? "",
        __workers__: JSON.stringify(workers),
        __volumes__: JSON.stringify(volumes),
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapVolume(volume: SharedVolume, accountId: string): ResourceInstance {
    const id = volume.volume_id ?? "";
    const name = volume.volume_name ?? id;
    // The volume object carries no timestamps at all.
    const now = nowIso();
    return {
      id: `${accountId}:shared-volume:${id}`,
      pluginId: "together",
      resourceTypeId: "shared-volume",
      accountId,
      displayName: name,
      fields: {
        volumeName: name,
        volumeId: id,
        ...(volume.size_tib != null ? { sizeTib: volume.size_tib } : {}),
        ...(volume.status ? { status: volume.status } : {}),
      },
      resolvedOutputs: { volumeId: id, volumeName: name },
      secretStates: [],
      externalId: id,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapHardware(hardware: TogetherHardware, accountId: string): ResourceInstance {
    const id = hardware.id ?? "";
    const specs = hardware.specs ?? {};
    const createdAt = hardware.updated_at ?? nowIso();
    return {
      id: `${accountId}:hardware:${id}`,
      pluginId: "together",
      resourceTypeId: "hardware",
      accountId,
      displayName: id,
      fields: {
        hardwareId: id,
        ...(specs.gpu_type ? { gpuType: specs.gpu_type } : {}),
        ...(specs.gpu_count != null ? { gpuCount: specs.gpu_count } : {}),
        ...(specs.gpu_memory != null ? { gpuMemoryGb: specs.gpu_memory } : {}),
        ...(specs.gpu_link ? { gpuLink: specs.gpu_link } : {}),
        ...(hardware.pricing?.cents_per_minute != null
          ? { centsPerMinute: hardware.pricing.cents_per_minute }
          : {}),
        // `availability` is only populated when `?model=` is supplied.
        ...(hardware.availability?.status ? { availability: hardware.availability.status } : {}),
        ...(hardware.updated_at ? { updatedAt: hardware.updated_at } : {}),
      },
      resolvedOutputs: { hardwareId: id, gpuType: specs.gpu_type ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapBatch(batch: BatchJob, accountId: string): ResourceInstance {
    const id = batch.id ?? "";
    const createdAt = batch.created_at ?? nowIso();
    return {
      id: `${accountId}:batch:${id}`,
      pluginId: "together",
      resourceTypeId: "batch",
      accountId,
      displayName: batch.model_id ? `${batch.model_id} · ${id.slice(0, 8)}` : id,
      fields: {
        batchId: id,
        ...(batch.status ? { status: batch.status } : {}),
        ...(batch.model_id ? { model: batch.model_id } : {}),
        ...(batch.endpoint ? { endpoint: batch.endpoint } : {}),
        ...(batch.input_file_id ? { inputFileId: batch.input_file_id } : {}),
        ...(batch.output_file_id ? { outputFileId: batch.output_file_id } : {}),
        ...(batch.error_file_id ? { errorFileId: batch.error_file_id } : {}),
        ...(batch.file_size_bytes != null ? { fileSizeBytes: batch.file_size_bytes } : {}),
        // Together reports this on a 0–100 scale, not 0–1.
        ...(batch.progress != null ? { progress: batch.progress } : {}),
        ...(batch.job_deadline ? { jobDeadline: batch.job_deadline } : {}),
        ...(batch.error ? { error: batch.error } : {}),
        createdAt,
        ...(batch.completed_at ? { completedAt: batch.completed_at } : {}),
      },
      resolvedOutputs: { batchId: id, outputFileId: batch.output_file_id ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: batch.completed_at ?? createdAt,
    };
  }

  private mapEvaluation(evaluation: EvaluationJob, accountId: string): ResourceInstance {
    const id = evaluation.workflow_id ?? "";
    const createdAt = evaluation.created_at ?? nowIso();
    const parameters = evaluation.parameters ?? {};
    const model = typeof parameters["model"] === "string" ? (parameters["model"] as string) : "";
    const judge =
      typeof parameters["judge_model"] === "string" ? (parameters["judge_model"] as string) : "";
    return {
      id: `${accountId}:evaluation:${id}`,
      pluginId: "together",
      resourceTypeId: "evaluation",
      accountId,
      displayName: evaluation.type ? `${titleCase(evaluation.type)} · ${id}` : id,
      fields: {
        workflowId: id,
        ...(evaluation.status ? { status: evaluation.status } : {}),
        ...(evaluation.type ? { type: evaluation.type } : {}),
        ...(evaluation.owner_id ? { ownerId: evaluation.owner_id } : {}),
        ...(model ? { model } : {}),
        ...(judge ? { judgeModel: judge } : {}),
        ...(Object.keys(parameters).length ? { parameters: JSON.stringify(parameters) } : {}),
        createdAt,
        ...(evaluation.updated_at ? { updatedAt: evaluation.updated_at } : {}),
      },
      resolvedOutputs: { workflowId: id, status: evaluation.status ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: evaluation.updated_at ?? createdAt,
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
    switch (typeId) {
      case "endpoint": {
        // The by-id response is richer than the list item: it adds
        // display_name, hardware and autoscaling.
        const endpoint = await this.fetch<DedicatedEndpoint>(
          `/endpoints/${encodeURIComponent(externalId)}`,
        );
        return this.mapEndpoint(endpoint, accountId);
      }
      case "fine-tune": {
        const job = await this.fetch<FineTuneJob>(`/fine-tunes/${encodeURIComponent(externalId)}`);
        return this.mapFineTune(job, accountId);
      }
      case "file": {
        const file = await this.fetch<TogetherFile>(`/files/${encodeURIComponent(externalId)}`);
        return this.mapFile(file, accountId);
      }
      case "batch": {
        const batch = await this.fetch<BatchJob>(`/batches/${encodeURIComponent(externalId)}`);
        return this.mapBatch(batch, accountId);
      }
      case "evaluation": {
        const evaluation = await this.fetch<EvaluationJob>(
          `/evaluation/${encodeURIComponent(externalId)}`,
        );
        return this.mapEvaluation(evaluation, accountId);
      }
      case "gpu-cluster": {
        // https://docs.together.ai/reference/clusters-get
        const cluster = await this.fetch<GpuCluster>(
          `/compute/clusters/${encodeURIComponent(externalId)}`,
        );
        return this.mapCluster(cluster, accountId);
      }
      case "shared-volume": {
        // https://docs.together.ai/reference/clusters_storages-get
        const volume = await this.fetch<SharedVolume>(
          `/compute/clusters/storage/volumes/${encodeURIComponent(externalId)}`,
        );
        return this.mapVolume(volume, accountId);
      }
      case "model": {
        // There is no `GET /v1/models/{id}`: pick the entry out of the list.
        const models = await this.fetchModels();
        const raw = models.find((model) => model.id === externalId);
        if (!raw) throw new Error(`Together plugin: model ${externalId} not found`);
        const instance = this.mapModel(raw, accountId);
        // `renderDetail` is synchronous, so the Speech tab's voice picker is
        // fetched here and stashed under a `__`-prefixed resolved output.
        if (SPEECH_MODEL_IDS.has(externalId)) {
          const voices = await this.fetchVoices().catch((): StashedVoice[] => []);
          instance.resolvedOutputs["__voices__"] = JSON.stringify(voices);
        }
        return instance;
      }
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((resource) => resource.id === resourceId);
        if (!found) throw new Error(`Together plugin: resource ${typeId}/${externalId} not found`);
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "gpu-cluster" && outputKey === "kubeconfig") {
      const cluster = await this.fetch<GpuCluster>(
        `/compute/clusters/${encodeURIComponent(externalIdOf(resourceId))}`,
      );
      if (!cluster.kube_config) {
        throw new Error(
          "Together plugin: this cluster has no kubeconfig yet; it is issued once the control plane is ready",
        );
      }
      return cluster.kube_config;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Together plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "endpoint") {
      // `?dedicated=true` narrows the catalogue to models that can actually be
      // pinned to reserved hardware, so the picker can't offer an invalid one.
      const [models, hardware] = await Promise.all([
        this.fetch<TogetherModel[]>("/models?dedicated=true").catch((): TogetherModel[] => []),
        this.fetch<{ data?: TogetherHardware[] }>("/hardware").catch(
          (): { data?: TogetherHardware[] } => ({}),
        ),
      ]);
      const modelOptions = (Array.isArray(models) ? models : []).map((model) => ({
        id: model.id,
        label: model.display_name ? `${model.display_name} (${model.id})` : model.id,
      }));
      const hardwareOptions = (hardware.data ?? [])
        .filter((entry) => Boolean(entry.id))
        .map((entry) => {
          const specs = entry.specs ?? {};
          const price = entry.pricing?.cents_per_minute;
          const detail = [
            specs.gpu_count && specs.gpu_type ? `${specs.gpu_count}× ${specs.gpu_type}` : "",
            price != null ? `${price}¢/min` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return {
            id: entry.id ?? "",
            label: detail ? `${entry.id} (${detail})` : (entry.id ?? ""),
          };
        });

      return {
        fields: [
          {
            key: "display_name",
            label: "Display Name",
            kind: "text",
            required: true,
            description: "Human-readable name shown in the Together dashboard.",
            placeholder: "prod-llama-70b",
          },
          {
            key: "model",
            label: "Model",
            kind: "select",
            required: true,
            description: "Model served by this endpoint. Only dedicated-capable models are listed.",
            options: modelOptions,
            ...(modelOptions[0] ? { defaultValue: modelOptions[0].id } : {}),
          },
          {
            key: "hardware",
            label: "Hardware",
            kind: "select",
            required: true,
            description:
              "GPU configuration each replica runs on. Not every model fits every configuration.",
            options: hardwareOptions,
            ...(hardwareOptions[0] ? { defaultValue: hardwareOptions[0].id } : {}),
          },
          {
            key: "min_replicas",
            label: "Minimum Replicas",
            kind: "number",
            required: true,
            description:
              "Replicas kept running at all times. You pay for these whether idle or not.",
            defaultValue: "1",
            minValue: 0,
            stepValue: 1,
          },
          {
            key: "max_replicas",
            label: "Maximum Replicas",
            kind: "number",
            required: true,
            description: "Upper bound on autoscaling.",
            defaultValue: "1",
            minValue: 1,
            stepValue: 1,
          },
          {
            key: "inactive_timeout",
            label: "Idle Timeout (minutes)",
            kind: "number",
            required: false,
            description:
              "Stop the endpoint after this many minutes with no traffic. Leave blank or 0 to keep it running indefinitely.",
            minValue: 0,
            stepValue: 1,
          },
          {
            key: "state",
            label: "Start immediately",
            kind: "select",
            required: true,
            options: [
              { id: "STARTED", label: "Yes, start now" },
              { id: "STOPPED", label: "No, create stopped" },
            ],
            defaultValue: "STARTED",
          },
        ],
      };
    }

    if (typeId === "batch") {
      const [files, models] = await Promise.all([
        this.fetch<{ data?: TogetherFile[] }>("/files").catch(
          (): { data?: TogetherFile[] } => ({}),
        ),
        this.fetch<TogetherModel[]>("/models").catch((): TogetherModel[] => []),
      ]);
      const fileOptions = (files.data ?? [])
        .filter((file) => file.purpose === "batch-api" || !file.purpose)
        .map((file) => ({ id: file.id ?? "", label: file.filename ?? file.id ?? "" }));
      const modelOptions = (Array.isArray(models) ? models : [])
        .filter((model) => model.type === "chat" || model.type === "language")
        .map((model) => ({ id: model.id, label: model.display_name ?? model.id }));

      return {
        fields: [
          {
            key: "endpoint",
            label: "Endpoint",
            kind: "select",
            required: true,
            description: "Which inference route the batched requests target.",
            options: [
              { id: "/v1/chat/completions", label: "Chat completions" },
              { id: "/v1/audio/transcriptions", label: "Audio transcriptions" },
              { id: "/v1/audio/translations", label: "Audio translations" },
            ],
            defaultValue: "/v1/chat/completions",
          },
          {
            key: "input_file_id",
            label: "Input File",
            kind: "select",
            required: true,
            description: "An uploaded JSONL file, one request per line.",
            options: fileOptions,
            ...(fileOptions[0] ? { defaultValue: fileOptions[0].id } : {}),
          },
          {
            key: "model_id",
            label: "Model",
            kind: "select",
            required: false,
            description: "Overrides the model named inside the JSONL, when set.",
            options: modelOptions,
          },
        ],
      };
    }

    if (typeId === "gpu-cluster") return this.clusterCreateConfig();

    if (typeId === "shared-volume") {
      const regions = await this.fetchRegions().catch((): ComputeRegion[] => []);
      return {
        fields: [
          {
            key: "volume_name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "training-data",
          },
          this.regionField(regions, false),
          {
            key: "size_tib",
            label: "Size (TiB)",
            kind: "number",
            required: true,
            description: "Whole tebibytes. You can grow the volume later.",
            defaultValue: "1",
            minValue: 1,
            stepValue: 1,
          },
        ],
      };
    }

    throw new Error(`Together plugin: createResource not supported for type "${typeId}"`);
  }

  /**
   * `GET /v1/compute/regions`: each region's GPU types and the NVIDIA
   * driver/CUDA catalogue entries it offers.
   * https://docs.together.ai/reference/clusters-list-regions
   */
  private async fetchRegions(): Promise<ComputeRegion[]> {
    const data = await this.fetch<{ regions?: ComputeRegion[] }>("/compute/regions");
    return (data.regions ?? []).filter((region) => Boolean(region.name));
  }

  /**
   * A region picker built from `/compute/regions`. On the cluster form it is
   * narrowed by the chosen GPU type, because `supported_instance_types` holds
   * the same enum values the create body's `gpu_type` takes. Falls back to a
   * text box when the regions call fails, so the form still works.
   */
  private regionField(regions: ComputeRegion[], filterByGpu: boolean): CreateFieldConfig {
    if (!regions.length) {
      return {
        key: "region",
        label: "Region",
        kind: "text",
        required: true,
        description: "Together could not list regions just now; type one, e.g. us-central-8.",
      };
    }
    return {
      key: "region",
      label: "Region",
      kind: "region-picker",
      required: true,
      regions: regions.map((region) => ({
        id: region.name ?? "",
        label: region.name ?? "",
        ...(filterByGpu && region.supported_instance_types?.length
          ? { availableFor: region.supported_instance_types }
          : {}),
      })),
      ...(filterByGpu ? { filterByFieldKey: "gpu_type" } : {}),
      ...(regions[0]?.name ? { defaultValue: regions[0].name } : {}),
    };
  }

  /**
   * `POST /v1/compute/clusters`. The driver picker is one select per region,
   * each shown only while that region is chosen, so only catalogue entries
   * the chosen region offers can be submitted. It sends `nvidia_version_id`,
   * which the spec prefers over the legacy driver/CUDA pair.
   * https://docs.together.ai/reference/clusters-create
   */
  private async clusterCreateConfig(): Promise<CreateResourceConfig> {
    const [regions, volumes] = await Promise.all([
      this.fetchRegions().catch((): ComputeRegion[] => []),
      this.fetch<{ volumes?: SharedVolume[] }>("/compute/clusters/storage/volumes").catch(
        (): { volumes?: SharedVolume[] } => ({}),
      ),
    ]);
    const offered = new Set(regions.flatMap((region) => region.supported_instance_types ?? []));
    const gpuTypes = [
      ...CLUSTER_GPU_TYPES.filter((type) => !offered.size || offered.has(type)),
      ...[...offered].filter((type) => !CLUSTER_GPU_TYPES.includes(type)),
    ];
    const gpuOptions = gpuTypes.map((type) => {
      const where = regions
        .filter((region) => region.supported_instance_types?.includes(type))
        .map((region) => region.name ?? "");
      return {
        id: type,
        label: gpuTypeLabel(type),
        ...(where.length ? { description: where.join(", ") } : {}),
      };
    });

    const driverFields: CreateFieldConfig[] = regions.length
      ? regions.map((region) => {
          const options = (region.driver_versions ?? [])
            .filter((version) => Boolean(version.id))
            .map((version) => ({
              id: version.id ?? "",
              label: `Driver ${version.nvidia_driver_version ?? "?"} · CUDA ${version.cuda_version ?? "?"}`,
              ...(version.os ? { description: version.os } : {}),
            }));
          return {
            key: `nvidia_version_id@${region.name ?? ""}`,
            label: "NVIDIA Driver",
            kind: "select" as const,
            required: false,
            description: `Driver and CUDA combinations offered in ${region.name ?? "this region"}.`,
            options,
            ...(options.at(-1) ? { defaultValue: options.at(-1)?.id ?? "" } : {}),
            showWhen: { fieldKey: "region", fieldValue: region.name ?? "" },
          };
        })
      : [
          {
            key: "nvidia_driver_version",
            label: "NVIDIA Driver Version",
            kind: "text",
            required: true,
            placeholder: "570",
          },
          {
            key: "cuda_version",
            label: "CUDA Version",
            kind: "text",
            required: true,
            placeholder: "12.8",
          },
        ];

    const volumeOptions = [
      { id: "none", label: "No shared volume" },
      { id: "new", label: "Create a new volume" },
      ...(volumes.volumes ?? [])
        .filter((volume) => Boolean(volume.volume_id))
        .map((volume) => ({
          id: volume.volume_id ?? "",
          label: volume.volume_name ?? volume.volume_id ?? "",
          description: [
            volume.size_tib != null ? `${volume.size_tib} TiB` : "",
            volume.status ? titleCase(volume.status) : "",
          ]
            .filter(Boolean)
            .join(" · "),
        })),
    ];

    return {
      fields: [
        {
          key: "cluster_name",
          label: "Name",
          kind: "text",
          required: true,
          placeholder: "training-cluster",
        },
        {
          key: "gpu_type",
          label: "GPU Type",
          kind: "select",
          required: true,
          description: "The regions offering each type are listed under it.",
          options: gpuOptions,
          ...(gpuOptions[0] ? { defaultValue: gpuOptions[0].id } : {}),
        },
        this.regionField(regions, true),
        ...driverFields,
        {
          key: "num_gpus",
          label: "GPUs",
          kind: "number",
          required: true,
          description: "Allocated in whole nodes of 8.",
          defaultValue: "8",
          minValue: 8,
          stepValue: 8,
        },
        {
          key: "cluster_type",
          label: "Cluster Type",
          kind: "select",
          required: true,
          options: [
            { id: "KUBERNETES", label: "Kubernetes" },
            { id: "SLURM", label: "Slurm" },
          ],
          defaultValue: "KUBERNETES",
        },
        {
          key: "slurm_shm_size_gib",
          label: "Slurm Shared Memory (GiB)",
          kind: "number",
          required: false,
          description: "Shared memory per node. Together requires it for Slurm clusters.",
          defaultValue: "64",
          minValue: 1,
          stepValue: 1,
          showWhen: { fieldKey: "cluster_type", fieldValue: "SLURM" },
        },
        {
          key: "billing_type",
          label: "Billing",
          kind: "select",
          required: true,
          options: [
            {
              id: "ON_DEMAND",
              label: "On demand",
              description: "Yours until you delete it",
            },
            {
              id: "RESERVED",
              label: "Reserved",
              description: "Prepaid for a fixed number of days",
            },
            {
              id: "SCHEDULED_CAPACITY",
              label: "Scheduled capacity",
              description: "Reserved for a future time window",
            },
          ],
          defaultValue: "ON_DEMAND",
        },
        {
          key: "duration_days",
          label: "Reservation Length (days)",
          kind: "number",
          required: false,
          defaultValue: "30",
          minValue: 1,
          stepValue: 1,
          showWhen: { fieldKey: "billing_type", fieldValue: "RESERVED" },
        },
        {
          key: "reservation_start_time",
          label: "Reservation Start",
          kind: "datetime",
          required: false,
          showWhen: { fieldKey: "billing_type", fieldValue: "SCHEDULED_CAPACITY" },
        },
        {
          key: "reservation_end_time",
          label: "Reservation End",
          kind: "datetime",
          required: false,
          showWhen: { fieldKey: "billing_type", fieldValue: "SCHEDULED_CAPACITY" },
        },
        {
          key: "num_preemptible_gpus",
          label: "Preemptible GPUs",
          kind: "number",
          required: false,
          description:
            "Optional discounted GPUs that Together can reclaim when it needs the capacity. Multiples of 8.",
          minValue: 0,
          stepValue: 8,
        },
        {
          key: "shared_volume",
          label: "Shared Volume",
          kind: "select",
          required: true,
          description: "Volumes are regional: an existing one must be in the cluster's region.",
          options: volumeOptions,
          defaultValue: "none",
        },
        {
          key: "volume_name",
          label: "New Volume Name",
          kind: "text",
          required: false,
          showWhen: { fieldKey: "shared_volume", fieldValue: "new" },
        },
        {
          key: "volume_size_tib",
          label: "New Volume Size (TiB)",
          kind: "number",
          required: false,
          defaultValue: "1",
          minValue: 1,
          stepValue: 1,
          showWhen: { fieldKey: "shared_volume", fieldValue: "new" },
        },
      ],
    };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "endpoint") {
      // https://docs.together.ai/reference/createendpoint
      const timeout = Number.parseInt(fields["inactive_timeout"] ?? "", 10);
      const body: Record<string, unknown> = {
        model: fields["model"] ?? "",
        hardware: fields["hardware"] ?? "",
        autoscaling: {
          min_replicas: toInt(fields["min_replicas"], 1),
          max_replicas: toInt(fields["max_replicas"], 1),
        },
        ...(fields["display_name"] ? { display_name: fields["display_name"] } : {}),
        state: fields["state"] === "STOPPED" ? "STOPPED" : "STARTED",
        ...(Number.isFinite(timeout) && timeout > 0 ? { inactive_timeout: timeout } : {}),
      };
      const created = await this.fetch<DedicatedEndpoint>("/endpoints", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapEndpoint(created, accountId);
    }

    if (typeId === "batch") {
      // 201, and the body wraps the job: `{ job, warning }`.
      const body: Record<string, unknown> = {
        endpoint: fields["endpoint"] ?? "/v1/chat/completions",
        input_file_id: fields["input_file_id"] ?? "",
        ...(fields["model_id"] ? { model_id: fields["model_id"] } : {}),
      };
      // Typed as either shape: the wrapper, or (tolerated) the bare job.
      const created = await this.fetch<BatchJob & { job?: BatchJob; warning?: string }>(
        "/batches",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      const job: BatchJob = created.job ?? created;
      return this.mapBatch(job, accountId);
    }

    if (typeId === "gpu-cluster") {
      const created = await this.fetch<GpuCluster>("/compute/clusters", {
        method: "POST",
        body: JSON.stringify(buildClusterCreateBody(fields)),
      });
      return this.mapCluster(created, accountId);
    }

    if (typeId === "shared-volume") {
      // https://docs.together.ai/reference/clusters_storages-create
      const size = toInt(fields["size_tib"], 0);
      if (size < 1) throw new Error("Together plugin: a shared volume needs at least 1 TiB");
      const created = await this.fetch<SharedVolume>("/compute/clusters/storage/volumes", {
        method: "POST",
        body: JSON.stringify({
          volume_name: fields["volume_name"] ?? "",
          size_tib: size,
          region: fields["region"] ?? "",
        }),
      });
      return this.mapVolume(created, accountId);
    }

    throw new Error(`Together plugin: createResource not supported for type "${typeId}"`);
  }

  /**
   * `PATCH /v1/endpoints/{id}` accepts display_name, state, autoscaling and
   * inactive_timeout. Model and hardware cannot change after creation.
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "gpu-cluster") return this.updateCluster(resourceId, accountId, fields);
    if (typeId === "shared-volume") return this.updateVolume(resourceId, accountId, fields);
    if (typeId !== "endpoint") {
      throw new Error(`Together plugin: updateResource not supported for type "${typeId}"`);
    }
    const id = externalIdOf(resourceId);
    const current = await this.fetch<DedicatedEndpoint>(`/endpoints/${encodeURIComponent(id)}`);
    const body: Record<string, unknown> = {};
    if (fields["displayName"]) body["display_name"] = fields["displayName"];
    if (fields["state"]) {
      const wanted = fields["state"].toUpperCase();
      if (wanted !== "STARTED" && wanted !== "STOPPED") {
        throw new Error(
          `Together plugin: endpoint state can only be set to STARTED or STOPPED (got "${fields["state"]}")`,
        );
      }
      body["state"] = wanted;
    }
    if (fields["minReplicas"] !== undefined || fields["maxReplicas"] !== undefined) {
      const existing = current.autoscaling ?? {};
      body["autoscaling"] = {
        min_replicas: toInt(fields["minReplicas"], existing.min_replicas ?? 1),
        max_replicas: toInt(fields["maxReplicas"], existing.max_replicas ?? 1),
      };
    }
    if (Object.keys(body).length === 0) return this.mapEndpoint(current, accountId);
    const updated = await this.fetch<DedicatedEndpoint>(`/endpoints/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return this.mapEndpoint(updated, accountId);
  }

  /**
   * `PUT /v1/compute/clusters/{cluster_id}`. Every field is optional and an
   * omitted one keeps its current value, so only what the user changed is
   * sent. https://docs.together.ai/reference/clusters-update
   */
  private async updateCluster(
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const path = `/compute/clusters/${encodeURIComponent(id)}`;
    const current = await this.fetch<GpuCluster>(path);
    const body: Record<string, unknown> = {};
    const changedInt = (key: string, existing: number | undefined): number | undefined => {
      const raw = fields[key];
      if (raw === undefined || raw === "") return undefined;
      const value = toInt(raw, Number.NaN);
      if (!Number.isFinite(value)) {
        throw new Error(`Together plugin: "${key}" must be a whole number (got "${raw}")`);
      }
      return value === existing ? undefined : value;
    };

    const clusterType = fields["clusterType"]?.toUpperCase();
    if (clusterType && clusterType !== current.cluster_type) {
      if (clusterType !== "KUBERNETES" && clusterType !== "SLURM") {
        throw new Error(
          `Together plugin: cluster type must be KUBERNETES or SLURM (got "${fields["clusterType"]}")`,
        );
      }
      body["cluster_type"] = clusterType;
    }
    const numGpus = changedInt("numGpus", current.num_gpus);
    if (numGpus !== undefined) {
      assertMultipleOf8("GPU count", numGpus);
      body["num_gpus"] = numGpus;
    }
    const reserved = changedInt("numReservedGpus", current.num_reserved_gpus);
    if (reserved !== undefined) {
      if (current.billing_type !== "RESERVED") {
        throw new Error("Together plugin: reserved GPUs only apply to RESERVED clusters");
      }
      body["num_reserved_gpus"] = reserved;
    }
    const preemptible = changedInt("desiredPreemptibleGpus", current.desired_preemptible_gpus);
    if (preemptible !== undefined) {
      assertMultipleOf8("Preemptible GPU count", preemptible);
      body["num_preemptible_gpus"] = preemptible;
    }
    const endTime = fields["reservationEndTime"]?.trim();
    if (endTime && endTime !== current.reservation_end_time) {
      if (Number.isNaN(Date.parse(endTime))) {
        throw new Error(
          `Together plugin: reservation end must be an RFC 3339 timestamp (got "${endTime}")`,
        );
      }
      body["reservation_end_time"] = new Date(endTime).toISOString();
    }

    if (Object.keys(body).length === 0) return this.mapCluster(current, accountId);
    const updated = await this.fetch<GpuCluster>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return this.mapCluster(updated, accountId);
  }

  /**
   * `PUT /v1/compute/clusters/storage/volumes`: note the id travels in the
   * body, not the path. Size is the only mutable property.
   * https://docs.together.ai/reference/clusters_storages-update
   */
  private async updateVolume(
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const raw = fields["sizeTib"];
    if (raw === undefined || raw === "") {
      return this.getResource("shared-volume", resourceId, accountId);
    }
    const size = toInt(raw, 0);
    if (size < 1) throw new Error("Together plugin: a shared volume needs at least 1 TiB");
    const updated = await this.fetch<SharedVolume>("/compute/clusters/storage/volumes", {
      method: "PUT",
      body: JSON.stringify({ volume_id: id, size_tib: size }),
    });
    return this.mapVolume(updated, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (!externalId) throw new Error(`Together plugin: cannot parse resource id "${resourceId}"`);
    switch (typeId) {
      case "endpoint":
        // 204, no body.
        await this.fetch<unknown>(`/endpoints/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      case "file":
        await this.fetch<unknown>(`/files/${encodeURIComponent(externalId)}`, { method: "DELETE" });
        return;
      case "fine-tune":
        await this.fetch<unknown>(`/fine-tunes/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      case "managed-endpoint":
        await this.deleteManagedEndpoint(externalId);
        return;
      case "gpu-cluster":
        // https://docs.together.ai/reference/clusters-delete
        await this.fetch<unknown>(`/compute/clusters/${encodeURIComponent(externalId)}`, {
          method: "DELETE",
        });
        return;
      case "shared-volume":
        // Fails while the volume is attached to a cluster; Together's error
        // says so and is surfaced as-is.
        // https://docs.together.ai/reference/clusters_storages-delete
        await this.fetch<unknown>(
          `/compute/clusters/storage/volumes/${encodeURIComponent(externalId)}`,
          { method: "DELETE" },
        );
        return;
      default:
        throw new Error(`Together plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  /**
   * A v2 DMI endpoint cannot be deleted while it still has deployments:
   * Together's own docs say "delete its deployments first". The user asked to
   * delete the endpoint, so we do the cascade for them rather than surfacing a
   * 409 they'd have to decode.
   */
  private async deleteManagedEndpoint(endpointId: string): Promise<void> {
    const { project_id: projectId } = await this.whoami();
    if (!projectId) {
      throw new Error("Together plugin: could not resolve project id from /v1/whoami");
    }
    const base = `${API_BASE_V2}/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}`;
    const deployments = await this.request<DmiListResponse<DmiDeployment>>(
      `${base}/deployments?limit=500`,
    ).catch((): DmiListResponse<DmiDeployment> => ({}));
    for (const deployment of deployments.data ?? []) {
      if (!deployment.id) continue;
      await this.request<unknown>(`${base}/deployments/${encodeURIComponent(deployment.id)}`, {
        method: "DELETE",
      });
    }
    await this.request<unknown>(base, { method: "DELETE" });
  }

  /**
   * `POST /v1/fine-tunes/{id}/cancel` and `POST /v1/batches/{id}/cancel`.
   * Endpoints "start"/"stop" go through PATCH rather than a cancel route.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (actionId === "cancel") {
      if (typeId === "fine-tune") {
        await this.fetch<unknown>(`/fine-tunes/${encodeURIComponent(externalId)}/cancel`, {
          method: "POST",
        });
        return;
      }
      if (typeId === "batch") {
        await this.fetch<unknown>(`/batches/${encodeURIComponent(externalId)}/cancel`, {
          method: "POST",
        });
        return;
      }
      throw new Error(`Together plugin: cancel not supported for type "${typeId}"`);
    }
    if ((actionId === "start" || actionId === "stop") && typeId === "endpoint") {
      await this.updateResource(typeId, resourceId, accountId, {
        state: actionId === "start" ? "STARTED" : "STOPPED",
      });
      return;
    }
    throw new Error(`Together plugin: unknown action "${actionId}"`);
  }

  // -------------------------------------------------------------------------
  // Costs, metrics and detail enrichment
  // -------------------------------------------------------------------------

  /**
   * `GET /v1/billing/usage`, one month per request series at daily
   * granularity, following `next_cursor`. The route is beta and switched on
   * per organization: a 404 means "not enabled here", which is a setup step
   * for the user rather than a failure to retry.
   * https://docs.together.ai/reference/billing-usage
   */
  async fetchCostData(accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    // Normalized AI dimensions (`ai:provider`, and `ai:model` /
    // `ai:token_type` where the billing API says), so request logs can be
    // reconciled against this bill. See plugin-base `ai-requests.ts`.
    return withAiCostTags(await this.fetchUntaggedCostRows(accountId, range), () => ({
      provider: "together",
    }));
  }

  private async fetchUntaggedCostRows(
    _accountId: string,
    range: CostFetchRange,
  ): Promise<CostRow[]> {
    const merged = new Map<string, CostRow>();
    const currentMonth = new Date().toISOString().slice(0, 7);

    for (const month of monthsInRange(range.fromDate, range.toDate)) {
      if (month > currentMonth) break;
      let after: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const query =
          `?month=${month}&granularity=day&limit=1000` +
          (after ? `&after=${encodeURIComponent(after)}` : "");
        let report: BillingUsageReport;
        try {
          report = await this.fetch<BillingUsageReport>(`/billing/usage${query}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/API error 404/.test(message)) {
            throw new CostSetupError(
              "Together's billing usage API is in beta and has not been enabled for this organization yet. Ask Together support to turn it on; spend appears here on the next collection.",
              {
                label: "Request access",
                url: "https://portal.usepylon.com/together-ai/forms/support-request",
              },
            );
          }
          if (/API error 40[13]/.test(message)) {
            throw new CostSetupError(
              "Together refused the billing usage request for this API key. Use a key from a project in the organization you want to report on.",
              { label: "Together API keys", url: "https://api.together.ai/settings/api-keys" },
            );
          }
          throw error;
        }

        const currency = report.currency || "USD";
        for (const window of report.data ?? []) {
          const date = window.date || window.start_time?.slice(0, 10) || "";
          if (!date || date < range.fromDate || date > range.toDate) continue;
          for (const item of window.line_items ?? []) {
            const amount = decimal(item.cost);
            if (amount == null || amount === 0) continue;
            const row = costRowFor(date, currency, item);
            const key = costRowKey(row);
            const existing = merged.get(key);
            if (existing) existing.amount += amount;
            else merged.set(key, { ...row, amount });
          }
        }
        if (!report.next_cursor) break;
        after = report.next_cursor;
      }
    }
    return [...merged.values()];
  }

  /**
   * Managed endpoint analytics as time series: one series per metric name in
   * the buckets. https://docs.together.ai/reference/dmi/endpoints-analytics
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "managed-endpoint") return [];
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 24 * 60 * 60 * 1000;
    const analytics = await this.fetchAnalytics(externalIdOf(resourceId), startMs, endMs, true);

    const byKey = new Map<string, MetricSeries>();
    for (const bucket of analytics.timeSeries ?? []) {
      const timestamp = Date.parse(bucket.timestamp ?? "");
      if (!Number.isFinite(timestamp)) continue;
      for (const [key, value] of Object.entries(bucket.values ?? {})) {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        let series = byKey.get(key);
        if (!series) {
          const meta = analyticsSeriesMeta(key);
          series = { label: meta.label, ...(meta.unit ? { unit: meta.unit } : {}), points: [] };
          byKey.set(key, series);
        }
        series.points.push({ timestamp, value });
      }
    }
    for (const series of byKey.values()) series.points.sort((a, b) => a.timestamp - b.timestamp);
    return [...byKey.values()];
  }

  /**
   * The endpoint's event feed as a Logs tab: endpoint changes merged with
   * provisioning, scaling, readiness and rollout events from every deployment
   * under it. `GET /v2/projects/{projectId}/endpoints/{id}/events` answers
   * newest first, so the page is reversed into reading order.
   * https://docs.together.ai/reference/dmi/endpoints-list-events
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "managed-endpoint") {
      throw new Error(`Together plugin: logs not supported for type "${typeId}"`);
    }
    const { project_id: projectId } = await this.whoami();
    if (!projectId) {
      throw new Error("Together plugin: could not resolve project id from /v1/whoami");
    }
    // The API caps a page at 10000 events and defaults to 50.
    const limit = Math.min(Math.max(params.tailLines ?? 500, 1), 10000);
    const page = await this.request<DmiListResponse<DmiEndpointEvent>>(
      `${API_BASE_V2}/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(externalIdOf(resourceId))}/events?limit=${limit}`,
    );
    const lines = (page.data ?? []).map(formatEndpointEvent).reverse();
    return {
      text: lines.map((line) => `${line}\n`).join(""),
      containers: [],
      activeContainer: "",
    };
  }

  /** `GET /v2/projects/{projectId}/endpoints/{id}/analytics`. */
  private async fetchAnalytics(
    endpointId: string,
    startMs: number,
    endMs: number,
    includeTimeSeries: boolean,
  ): Promise<DmiAnalytics> {
    const { project_id: projectId } = await this.whoami();
    if (!projectId) {
      throw new Error("Together plugin: could not resolve project id from /v1/whoami");
    }
    const params = new URLSearchParams({
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    });
    if (includeTimeSeries) {
      params.set("includeTimeSeries", "true");
      params.set("granularity", analyticsGranularity(endMs - startMs));
    }
    return this.request<DmiAnalytics>(
      `${API_BASE_V2}/projects/${encodeURIComponent(projectId)}/endpoints/${encodeURIComponent(endpointId)}/analytics?${params.toString()}`,
    );
  }

  /**
   * Extra calls for the detail page only: the last 24 hours of analytics on a
   * managed endpoint, and the event log and checkpoints of a fine-tune. Each
   * is stashed under a `__`-prefixed resolved output for `renderDetail`.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const externalId = resource.externalId ?? externalIdOf(resource.id);
    if (resource.resourceTypeId === "managed-endpoint") {
      const endMs = Date.now();
      const analytics = await this.fetchAnalytics(
        externalId,
        endMs - 24 * 60 * 60 * 1000,
        endMs,
        false,
      ).catch((): DmiAnalytics | null => null);
      if (!analytics?.metrics) return resource;
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          __analytics__: JSON.stringify(analytics.metrics),
        },
      };
    }
    if (resource.resourceTypeId === "fine-tune") {
      // https://docs.together.ai/reference/get-fine-tunes-id-events
      // https://docs.together.ai/reference/get-fine-tunes-id-checkpoint
      const id = encodeURIComponent(externalId);
      const [events, checkpoints] = await Promise.all([
        this.fetch<{ data?: FineTuneEvent[] }>(`/fine-tunes/${id}/events`).catch(
          (): { data?: FineTuneEvent[] } => ({}),
        ),
        this.fetch<{ data?: FineTuneCheckpoint[] }>(`/fine-tunes/${id}/checkpoints`).catch(
          (): { data?: FineTuneCheckpoint[] } => ({}),
        ),
      ]);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          __events__: JSON.stringify(events.data ?? []),
          __checkpoints__: JSON.stringify(checkpoints.data ?? []),
        },
      };
    }
    return resource;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId).catch(
      (): ResourceInstance | null => null,
    );
    if (!resource) return [];
    const fields = resource.fields;
    const stats: DashboardStat[] = [];

    switch (resourceTypeId) {
      case "endpoint": {
        const mapped = mapEndpointState(String(fields["state"] ?? ""));
        stats.push({
          label: "State",
          value: mapped.label,
          variant:
            mapped.status === "healthy"
              ? "status-healthy"
              : mapped.status === "error"
                ? "status-error"
                : "default",
        });
        stats.push({
          label: "Replicas",
          value: `${fields["minReplicas"] ?? 0} – ${fields["maxReplicas"] ?? 0}`,
        });
        if (fields["hardware"]) {
          stats.push({ label: "Hardware", value: String(fields["hardware"]) });
        }
        break;
      }
      case "fine-tune": {
        const mapped = mapFineTuneStatus(String(fields["status"] ?? ""));
        stats.push({
          label: "Status",
          value: mapped.label,
          variant:
            mapped.status === "healthy"
              ? "status-healthy"
              : mapped.status === "error"
                ? "status-error"
                : "default",
        });
        if (fields["tokenCount"] != null) {
          stats.push({ label: "Tokens", value: formatNumber(Number(fields["tokenCount"])) });
        }
        if (fields["totalPrice"] != null) {
          stats.push({ label: "Price", value: `$${Number(fields["totalPrice"]).toFixed(2)}` });
        }
        break;
      }
      case "batch": {
        const mapped = mapBatchStatus(String(fields["status"] ?? ""));
        stats.push({
          label: "Status",
          value: mapped.label,
          variant:
            mapped.status === "healthy"
              ? "status-healthy"
              : mapped.status === "error"
                ? "status-error"
                : "default",
        });
        if (fields["progress"] != null) {
          stats.push({ label: "Progress", value: `${Number(fields["progress"]).toFixed(0)}%` });
        }
        break;
      }
      case "file": {
        if (fields["bytes"] != null) {
          stats.push({ label: "Size", value: formatBytes(Number(fields["bytes"])) });
        }
        if (fields["lineCount"] != null) {
          stats.push({ label: "Lines", value: formatNumber(Number(fields["lineCount"])) });
        }
        break;
      }
      case "model": {
        if (fields["contextLength"] != null) {
          stats.push({
            label: "Context",
            value: `${formatNumber(Number(fields["contextLength"]))} tokens`,
          });
        }
        if (fields["inputPrice"] != null) {
          stats.push({ label: "Input", value: `$${fields["inputPrice"]}/1M` });
        }
        if (fields["outputPrice"] != null) {
          stats.push({ label: "Output", value: `$${fields["outputPrice"]}/1M` });
        }
        break;
      }
      case "hardware": {
        if (fields["gpuType"]) {
          stats.push({
            label: "GPU",
            value: `${fields["gpuCount"] ?? 1}× ${String(fields["gpuType"])}`,
          });
        }
        if (fields["availability"]) {
          const availability = String(fields["availability"]);
          stats.push({
            label: "Availability",
            value: titleCase(availability),
            variant: availability === "available" ? "status-healthy" : "status-degraded",
          });
        }
        break;
      }
      case "evaluation": {
        const mapped = mapEvaluationStatus(String(fields["status"] ?? ""));
        stats.push({ label: "Status", value: mapped.label });
        if (fields["type"]) stats.push({ label: "Type", value: titleCase(String(fields["type"])) });
        break;
      }
      case "managed-endpoint": {
        stats.push({ label: "Deployments", value: String(fields["deploymentCount"] ?? 0) });
        const endMs = Date.now();
        const analytics = await this.fetchAnalytics(
          resource.externalId ?? externalIdOf(resourceId),
          endMs - 24 * 60 * 60 * 1000,
          endMs,
          false,
        ).catch((): DmiAnalytics | null => null);
        const metrics = analytics?.metrics;
        const total = decimal(metrics?.requestMetrics?.totalRequests);
        if (total != null) stats.push({ label: "Requests (24h)", value: formatNumber(total) });
        const errorRate = metrics?.errorMetrics?.errorRate;
        if (errorRate != null) {
          stats.push({
            label: "Error Rate",
            value: formatPercent(errorRate),
            variant:
              errorRate >= 5 ? "status-error" : errorRate > 0 ? "status-degraded" : "default",
          });
        }
        const p50 = metrics?.latencyMetrics?.latencyP50Ms;
        if (p50 != null) stats.push({ label: "Latency p50", value: formatMs(p50) });
        break;
      }
      case "gpu-cluster": {
        const mapped = mapClusterStatus(String(fields["status"] ?? ""));
        stats.push({
          label: "Status",
          value: mapped.label,
          variant:
            mapped.status === "healthy"
              ? "status-healthy"
              : mapped.status === "error" || mapped.status === "degraded"
                ? "status-degraded"
                : "default",
        });
        if (fields["numGpus"] != null) {
          stats.push({
            label: "GPUs",
            value: `${fields["numGpus"]}× ${gpuTypeLabel(String(fields["gpuType"] ?? ""))}`.trim(),
          });
        }
        if (fields["region"]) stats.push({ label: "Region", value: String(fields["region"]) });
        break;
      }
      case "shared-volume": {
        const mapped = mapVolumeStatus(String(fields["status"] ?? ""));
        stats.push({ label: "Status", value: mapped.label });
        if (fields["sizeTib"] != null) {
          stats.push({ label: "Size", value: `${fields["sizeTib"]} TiB` });
        }
        break;
      }
      default:
        break;
    }
    return stats;
  }

  // -------------------------------------------------------------------------
  // Speech tab
  // -------------------------------------------------------------------------

  /**
   * `GET /v1/voices` → `{ data: [{ model, voices: [{ id, name }] }] }`. Some of
   * Together's own samples show a flat `{ voices: [...] }`, so both are handled.
   * https://docs.together.ai/docs/text-to-speech
   */
  private async fetchVoices(): Promise<StashedVoice[]> {
    const raw = await this.fetch<{ data?: VoiceCatalogEntry[]; voices?: VoiceCatalogEntry[] }>(
      "/voices",
    );
    const entries = raw.data ?? raw.voices ?? [];
    const voices: StashedVoice[] = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const model = entry.model ?? "";
      for (const voice of entry.voices ?? []) {
        const name = voice.name ?? "";
        const id = voice.id ?? "";
        // Cartesia is the documented exception: its voices are addressed by id,
        // not by name ("Model strings are deprecated"). Everything else takes
        // the name, per the `voice` field description in the OpenAPI document.
        const value = model === "cartesia/sonic" ? id || name : name || id;
        if (!value) continue;
        voices.push({ model, value, label: name || id });
      }
    }
    if (voices.length) return voices;
    return fallbackVoices();
  }

  /**
   * `POST /v1/audio/speech`: JSON in, **raw audio bytes out** (the streaming
   * variant is SSE with base64 frames; we use the non-streaming path).
   * mp3 is requested explicitly so a browser `<audio>` element can play it.
   * https://docs.together.ai/reference/audio-speech
   *
   * NOTE: this goes through the global `fetch` rather than `jsonRestFetch`,
   * because that helper JSON-parses every response. Consequently it bypasses
   * bastion egress routing and the custom CA credential; every control-plane
   * call in this plugin still goes through the host and keeps both.
   */
  async synthesizeSpeech(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    if (typeId !== "model") {
      throw new Error(`Together plugin: synthesizeSpeech not supported for type "${typeId}"`);
    }
    const requested = payload.modelId || externalIdOf(resourceId);
    // The Speech tab shares one model picker between both halves, so a Whisper
    // selection can arrive here. Fall back to a real TTS model rather than
    // posting a transcription model to the synthesis route.
    const modelId = TTS_MODELS.some((model) => model.id === requested)
      ? requested
      : DEFAULT_TTS_MODEL;
    const voice = payload.voiceId || DEFAULT_TTS_VOICE;

    const started = Date.now();
    const response = await fetch(`${API_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        model: modelId,
        input: payload.text,
        voice,
        response_format: "mp3",
      }),
    });
    // Branch on status BEFORE touching the body: errors come back as JSON
    // where the success path is binary.
    if (!response.ok) {
      throw new Error(
        `Together API error ${response.status} for /audio/speech: ${await response.text()}`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const elapsedMs = Date.now() - started;

    return {
      audioBase64: bytesToBase64(bytes),
      mimeType: "audio/mpeg",
      fileName: `together-${voice}-${Date.now()}.mp3`,
      summary: [
        `${formatNumber(payload.text.length)} characters`,
        modelId,
        voice,
        `${(elapsedMs / 1000).toFixed(1)}s`,
        `${(bytes.byteLength / 1024).toFixed(0)} KB mp3`,
      ].join(" · "),
      characters: payload.text.length,
    };
  }

  /**
   * `POST /v1/audio/transcriptions`: `multipart/form-data`. We request
   * `verbose_json` with word granularity and `diarize=true` so the transcript
   * comes back with per-word timings *and* speaker labels.
   * https://docs.together.ai/reference/audio-transcriptions
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
    if (typeId !== "model") {
      throw new Error(`Together plugin: transcribeAudio not supported for type "${typeId}"`);
    }

    // `payload.mimeType` is whatever MediaRecorder produced:
    // `audio/webm;codecs=opus` on Chromium, `audio/mp4` on Safari. Forward it
    // verbatim; Whisper accepts both and we must not transcode.
    const bytes = base64ToBytes(payload.audioBase64);
    const fileName = payload.fileName ?? `clip.${extensionForMime(payload.mimeType)}`;

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: payload.mimeType }), fileName);
    form.append("model", STT_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities", "word");
    form.append("diarize", "true");
    form.append(
      "language",
      payload.language && payload.language !== "auto" ? payload.language : "auto",
    );

    const started = Date.now();
    const response = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: "POST",
      // No Content-Type: `fetch` sets it along with the multipart boundary.
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      body: form,
    });
    if (!response.ok) {
      // A 413 comes back as text/html, not JSON, so read it as text either way.
      throw new Error(
        `Together API error ${response.status} for /audio/transcriptions: ${await response.text()}`,
      );
    }
    const elapsedMs = Date.now() - started;
    const data = (await response.json()) as TranscriptionResponse;

    const words: TranscriptWord[] = (data.words ?? [])
      .filter((word) => Boolean(word.word))
      .map((word) => ({
        text: word.word ?? "",
        ...(word.start != null ? { start: word.start } : {}),
        ...(word.end != null ? { end: word.end } : {}),
        ...(word.speaker_id ? { speaker: word.speaker_id } : {}),
      }));

    const speakers = new Set(
      (data.speaker_segments ?? []).map((segment) => segment.speaker_id ?? "").filter(Boolean),
    );
    const summaryParts = [STT_MODEL];
    if (data.duration != null) summaryParts.push(`${data.duration.toFixed(1)}s audio`);
    if (data.language) summaryParts.push(data.language);
    if (speakers.size)
      summaryParts.push(`${speakers.size} speaker${speakers.size === 1 ? "" : "s"}`);
    summaryParts.push(`${(elapsedMs / 1000).toFixed(1)}s round-trip`);

    return {
      text: data.text ?? "",
      summary: summaryParts.join(" · "),
      ...(data.language ? { language: data.language } : {}),
      ...(data.duration != null ? { durationSeconds: data.duration } : {}),
      ...(words.length ? { words } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      this.renderDetailBody(resource),
      [ManagedEndpointResourceType],
      resource.resourceTypeId,
    );
  }

  private renderDetailBody(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "model":
        return this.renderModelDetail(resource);
      case "endpoint":
        return this.renderEndpointDetail(resource);
      case "managed-endpoint":
        return this.renderManagedEndpointDetail(resource);
      case "fine-tune":
        return this.renderFineTuneDetail(resource);
      case "file":
        return this.renderFileDetail(resource);
      case "batch":
        return this.renderBatchDetail(resource);
      case "evaluation":
        return this.renderEvaluationDetail(resource);
      case "hardware":
        return this.renderHardwareDetail(resource);
      case "gpu-cluster":
        return this.renderClusterDetail(resource);
      case "shared-volume":
        return this.renderVolumeDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;
    switch (resource.resourceTypeId) {
      case "endpoint": {
        const mapped = mapEndpointState(String(fields["state"] ?? ""));
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "fine-tune": {
        const mapped = mapFineTuneStatus(String(fields["status"] ?? ""));
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "batch": {
        const mapped = mapBatchStatus(String(fields["status"] ?? ""));
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "evaluation": {
        const mapped = mapEvaluationStatus(String(fields["status"] ?? ""));
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "model": {
        const type = String(fields["type"] ?? "");
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "info",
            ...(type ? { label: titleCase(type) } : {}),
          },
        };
      }
      case "hardware": {
        const availability = String(fields["availability"] ?? "");
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: availability === "available" ? "healthy" : "info",
            ...(availability ? { label: titleCase(availability) } : {}),
          },
        };
      }
      case "file": {
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "info",
            label: formatBytes(Number(fields["bytes"] ?? 0)),
          },
        };
      }
      case "gpu-cluster": {
        const mapped = mapClusterStatus(String(fields["status"] ?? ""));
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "shared-volume": {
        const mapped = mapVolumeStatus(String(fields["status"] ?? ""));
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
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

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const modelId = String(fields["modelId"] ?? resource.externalId ?? "");
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Model ID", value: modelId, copyable: true },
              { key: "Name", value: String(fields["name"] ?? resource.displayName) },
              ...(fields["type"]
                ? [{ key: "Type", value: titleCase(String(fields["type"])) }]
                : []),
              ...(fields["organization"]
                ? [{ key: "Organization", value: String(fields["organization"]) }]
                : []),
              ...(fields["contextLength"] != null
                ? [
                    {
                      key: "Context Length",
                      value: `${formatNumber(Number(fields["contextLength"]))} tokens`,
                    },
                  ]
                : []),
              ...(fields["license"] ? [{ key: "License", value: String(fields["license"]) }] : []),
            ],
          },
        ],
      },
    ];

    const priceItems = (
      [
        ["Input (per 1M tokens)", "inputPrice"],
        ["Output (per 1M tokens)", "outputPrice"],
        ["Dedicated (per hour)", "hourlyPrice"],
        ["Fine-tuning", "finetunePrice"],
      ] as const
    )
      .filter(([, key]) => fields[key] != null)
      .map(([label, key]) => ({ key: label, value: `$${fields[key]}` }));
    if (priceItems.length) {
      sections.push({
        kind: "section",
        title: "List Pricing",
        children: [
          { kind: "key-value-list", items: priceItems },
          {
            kind: "text",
            content:
              "These are Together's published rates, not your spend. Actual charges come from Together's billing usage API and appear in Costs once it is enabled for your organization.",
            variant: "muted",
          },
        ],
      });
    }

    if (fields["link"]) {
      sections.push({
        kind: "section",
        title: "Links",
        children: [{ kind: "link", label: "Model card", url: String(fields["link"]) }],
      });
    }

    const isSpeechModel = SPEECH_MODEL_IDS.has(modelId);
    return {
      title: resource.displayName,
      subtitle: `Together model · ${modelId}`,
      status: { kind: "status-dot", status: "info", label: "Available" },
      sections,
      ...(isSpeechModel
        ? {
            speechPanel: this.buildSpeechPanel(
              modelId,
              parseJsonStash<StashedVoice>(resource.resolvedOutputs["__voices__"]),
            ),
          }
        : {}),
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  /**
   * One shared model picker drives both halves of the Speech tab, so it carries
   * Together's three TTS models followed by Whisper; `synthesizeSpeech` and
   * `transcribeAudio` each coerce the selection to something their route
   * accepts. Voices are narrowed to whichever TTS model is currently selected
   * where the catalogue tells us which model they belong to.
   */
  private buildSpeechPanel(modelId: string, voices: StashedVoice[]): SpeechPanelCapability {
    const activeTtsModel = TTS_MODELS.some((model) => model.id === modelId)
      ? modelId
      : DEFAULT_TTS_MODEL;
    const scoped = voices.filter((voice) => !voice.model || voice.model === activeTtsModel);
    const pool = scoped.length ? scoped : voices.length ? voices : fallbackVoices();

    const voiceOptions: SpeechPanelOption[] = pool.map((voice) => ({
      id: voice.value,
      label: voice.label,
      ...(voice.model && voice.model !== activeTtsModel ? { description: voice.model } : {}),
    }));

    const modelOptions: SpeechPanelOption[] = [
      ...TTS_MODELS.map((model) => ({
        id: model.id,
        label: model.label,
        description: model.description,
      })),
      {
        id: STT_MODEL,
        label: "Whisper Large v3",
        description: "Speech-to-text · the only model Together's transcription route accepts",
      },
    ];

    const defaultVoice =
      voiceOptions.find((voice) => voice.id === DEFAULT_TTS_VOICE)?.id ?? voiceOptions[0]?.id ?? "";

    return {
      modes: ["tts", "stt"],
      subtitle: `Together text-to-speech and Whisper transcription · ${activeTtsModel}`,
      helpText:
        "Both halves bill your Together account at published rates. Transcription always runs on openai/whisper-large-v3 with speaker labels, regardless of the model picker.",
      ...(voiceOptions.length ? { voices: voiceOptions } : {}),
      ...(defaultVoice ? { defaultVoice } : {}),
      voiceLabel: "Voice",
      defaultText: "The quick brown fox jumps over the lazy dog.",
      synthesizeLabel: "Synthesize",
      models: modelOptions,
      defaultModel: activeTtsModel,
      modelLabel: "Model",
      languages: [
        { id: "auto", label: "Auto-detect" },
        { id: "en", label: "English" },
        { id: "es", label: "Spanish" },
        { id: "fr", label: "French" },
        { id: "de", label: "German" },
        { id: "it", label: "Italian" },
        { id: "pt", label: "Portuguese" },
        { id: "nl", label: "Dutch" },
        { id: "pl", label: "Polish" },
        { id: "hi", label: "Hindi" },
        { id: "ja", label: "Japanese" },
        { id: "ko", label: "Korean" },
        { id: "zh", label: "Chinese" },
        { id: "ar", label: "Arabic" },
      ],
      defaultLanguage: "auto",
      languageLabel: "Transcription language",
      acceptedAudioTypes: [
        "audio/wav",
        "audio/mpeg",
        "audio/mp4",
        "audio/webm",
        "audio/flac",
        "audio/ogg",
        "audio/aac",
        ".wav",
        ".mp3",
        ".m4a",
        ".webm",
        ".flac",
        ".ogg",
        ".opus",
        ".aac",
      ],
      maxAudioBytes: MAX_AUDIO_BYTES,
      transcribeLabel: "Transcribe",
    };
  }

  private renderEndpointDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapEndpointState(String(fields["state"] ?? ""));
    const endpointName = String(fields["name"] ?? resource.resolvedOutputs["endpointName"] ?? "");
    const running = String(fields["state"] ?? "") === "STARTED";

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Dedicated endpoint", fields["model"]),
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Endpoint",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Endpoint ID", value: String(fields["endpointId"] ?? ""), copyable: true },
                ...(endpointName
                  ? [{ key: "Endpoint Name", value: endpointName, copyable: true }]
                  : []),
                { key: "Model", value: String(fields["model"] ?? "") },
                ...(fields["hardware"]
                  ? [{ key: "Hardware", value: String(fields["hardware"]) }]
                  : []),
                { key: "State", value: mapped.label },
                ...(fields["type"]
                  ? [{ key: "Type", value: titleCase(String(fields["type"])) }]
                  : []),
                ...(fields["owner"] ? [{ key: "Owner", value: String(fields["owner"]) }] : []),
                ...(fields["createdAt"]
                  ? [{ key: "Created", value: String(fields["createdAt"]) }]
                  : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Autoscaling",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Min Replicas", value: String(fields["minReplicas"] ?? "—") },
                { key: "Max Replicas", value: String(fields["maxReplicas"] ?? "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Calling this endpoint",
          children: [
            {
              kind: "text",
              content: `POST ${API_BASE}/chat/completions  {"model": "${endpointName || String(fields["model"] ?? "")}"}`,
              variant: "mono",
              copyable: true,
            },
          ],
        },
      ],
      headerActions: [
        running
          ? {
              kind: "action",
              label: "Stop",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "stop",
                confirmMessage:
                  "Stop this endpoint? In-flight requests fail and the next request pays a cold start.",
                successMessage: "Stopping endpoint.",
              },
            }
          : {
              kind: "action",
              label: "Start",
              action: {
                type: "plugin-action",
                actionId: "start",
                successMessage: "Starting endpoint.",
              },
            },
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderManagedEndpointDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const deployments = Number(fields["deploymentCount"] ?? 0);
    return {
      // The endpoint's lifecycle event feed; see `getLogs`.
      logs: { defaultTailLines: 500 },
      title: resource.displayName,
      subtitle: "Dedicated Managed Inference endpoint (v2)",
      status: {
        kind: "status-dot",
        status: deployments > 0 ? "healthy" : "info",
        label: `${deployments} deployment${deployments === 1 ? "" : "s"}`,
      },
      sections: [
        {
          kind: "section",
          title: "Endpoint",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: String(fields["name"] ?? ""), copyable: true },
                { key: "Endpoint ID", value: String(fields["endpointId"] ?? ""), copyable: true },
                ...(fields["projectId"]
                  ? [{ key: "Project ID", value: String(fields["projectId"]), copyable: true }]
                  : []),
                ...(fields["endpointType"]
                  ? [{ key: "Type", value: titleCase(String(fields["endpointType"])) }]
                  : []),
                ...(fields["visibility"]
                  ? [{ key: "Visibility", value: titleCase(String(fields["visibility"])) }]
                  : []),
                { key: "Deployments", value: String(deployments) },
                ...(fields["etag"] ? [{ key: "ETag", value: String(fields["etag"]) }] : []),
                ...(fields["createdAt"]
                  ? [{ key: "Created", value: String(fields["createdAt"]) }]
                  : []),
                ...(fields["updatedAt"]
                  ? [{ key: "Updated", value: String(fields["updatedAt"]) }]
                  : []),
              ],
            },
          ],
        },
        ...this.renderAnalyticsSections(resource),
        {
          kind: "section",
          title: "Deleting this endpoint",
          children: [
            {
              kind: "text",
              content:
                "Deleting removes the endpoint's deployments first, then the endpoint and its traffic split.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  /** The 24-hour aggregate stashed by `enrichDetail`; nothing if it failed. */
  private renderAnalyticsSections(resource: ResourceInstance): SectionNode[] {
    const raw = resource.resolvedOutputs["__analytics__"];
    if (!raw) return [];
    let metrics: DmiEndpointMetrics;
    try {
      metrics = JSON.parse(raw) as DmiEndpointMetrics;
    } catch {
      return [];
    }
    const items = (pairs: Array<[string, string]>) =>
      pairs.filter(([, value]) => value !== "").map(([key, value]) => ({ key, value }));
    const count = (value: string | undefined) => {
      const parsed = decimal(value);
      return parsed == null ? "" : formatNumber(parsed);
    };
    const rate = (value: number | undefined) => (value == null ? "" : value.toFixed(2));
    const requests = metrics.requestMetrics ?? {};
    const latency = metrics.latencyMetrics ?? {};
    const throughput = metrics.throughputMetrics ?? {};
    const utilization = metrics.resourceUtilization ?? {};
    const tokens = metrics.tokenMetrics ?? {};
    const percentiles = (p50?: number, p90?: number, p99?: number) =>
      [p50, p90, p99].some((value) => value != null)
        ? [formatMs(p50), formatMs(p90), formatMs(p99)].map((value) => value || "n/a").join(" / ")
        : "";

    const groups: Array<[string, Array<{ key: string; value: string }>]> = [
      [
        "Traffic (last 24 hours)",
        items([
          ["Requests", count(requests.totalRequests)],
          ["Successful", count(requests.successfulRequests)],
          ["Failed", count(requests.failedRequests)],
          ["Error Rate", formatPercent(metrics.errorMetrics?.errorRate)],
          ["Requests / s", rate(requests.requestsPerSecond ?? throughput.requestsPerSecond)],
          ["Tokens / s", rate(throughput.tokensPerSecond)],
          ["Average Batch Size", rate(throughput.avgBatchSize)],
        ]),
      ],
      [
        "Latency (p50 / p90 / p99)",
        items([
          [
            "Time to First Token",
            percentiles(latency.ttftP50Ms, latency.ttftP90Ms, latency.ttftP99Ms),
          ],
          [
            "End to End",
            percentiles(latency.latencyP50Ms, latency.latencyP90Ms, latency.latencyP99Ms),
          ],
          ["Inter-token", percentiles(latency.itlP50Ms, latency.itlP90Ms, latency.itlP99Ms)],
        ]),
      ],
      [
        "Utilization",
        items([
          ["GPU", formatPercent(utilization.gpuUtilization)],
          ["GPU Memory", formatPercent(utilization.gpuMemoryUtilization)],
          ["CPU", formatPercent(utilization.cpuUtilization)],
          ["Memory", formatPercent(utilization.memoryUtilization)],
          [
            "Network",
            utilization.networkBandwidthMbps == null
              ? ""
              : `${utilization.networkBandwidthMbps.toFixed(1)} Mbps`,
          ],
        ]),
      ],
      [
        "Tokens",
        items([
          ["Input", count(tokens.totalInputTokens)],
          ["Output", count(tokens.totalOutputTokens)],
          ["Average Input / Request", rate(tokens.avgInputTokens)],
          ["Average Output / Request", rate(tokens.avgOutputTokens)],
        ]),
      ],
    ];
    return groups
      .filter(([, list]) => list.length)
      .map(([title, list]) => ({
        kind: "section" as const,
        title,
        children: [{ kind: "key-value-list" as const, items: list }],
      }));
  }

  private renderClusterDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapClusterStatus(String(fields["status"] ?? ""));
    const text = (key: string) =>
      fields[key] != null && fields[key] !== "" ? String(fields[key]) : "";
    const kv = (pairs: Array<[string, string, boolean?]>) =>
      pairs
        .filter(([, value]) => value !== "")
        .map(([key, value, copyable]) => ({ key, value, ...(copyable ? { copyable: true } : {}) }));

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Cluster",
        children: [
          {
            kind: "key-value-list",
            items: kv([
              ["Cluster ID", text("clusterId"), true],
              ["Name", text("clusterName")],
              ["Status", mapped.label],
              ["Type", text("clusterType") ? titleCase(text("clusterType")) : ""],
              ["Region", text("region")],
              ["Billing", text("billingType") ? titleCase(text("billingType")) : ""],
              ["Created", text("createdAt")],
            ]),
          },
        ],
      },
      {
        kind: "section",
        title: "Capacity",
        children: [
          {
            kind: "key-value-list",
            items: kv([
              ["GPU Type", text("gpuType") ? gpuTypeLabel(text("gpuType")) : ""],
              ["GPUs", text("numGpus")],
              ["Reserved GPUs", text("numReservedGpus")],
              ["Preemptible GPUs (requested)", text("desiredPreemptibleGpus")],
              ["Preemptible GPUs (allocated)", text("allocatedPreemptibleGpus")],
              ["GPU Worker Nodes", text("gpuWorkerCount")],
              ["CPU Worker Nodes", text("numCpuWorkers")],
              ["Control Plane Nodes", text("controlPlaneCount")],
            ]),
          },
        ],
      },
      {
        kind: "section",
        title: "Software",
        children: [
          {
            kind: "key-value-list",
            items: kv([
              ["NVIDIA Driver", text("nvidiaDriverVersion")],
              ["CUDA", text("cudaVersion")],
            ]),
          },
        ],
      },
    ];

    if (text("reservationStartTime") || text("reservationEndTime")) {
      sections.push({
        kind: "section",
        title: "Reservation",
        children: [
          {
            kind: "key-value-list",
            items: kv([
              ["Starts", text("reservationStartTime")],
              ["Ends", text("reservationEndTime")],
            ]),
          },
        ],
      });
    }

    const workers = parseJsonStash<StashedNode>(resource.resolvedOutputs["__workers__"]);
    if (workers.length) {
      sections.push({
        kind: "section",
        title: "GPU Worker Nodes",
        children: [
          {
            kind: "table",
            emphasizeFirstColumn: true,
            columns: [
              { key: "host", label: "Host", mono: true },
              { key: "status", label: "Status" },
              { key: "gpus", label: "GPUs", width: "narrow" },
              { key: "cpus", label: "CPU Cores", width: "narrow" },
              { key: "memory", label: "Memory", width: "narrow" },
            ],
            rows: workers.map((node) => ({
              cells: {
                host: node.host,
                status: node.status ? splitPascal(node.status) : "",
                gpus: node.gpus != null ? String(node.gpus) : "",
                cpus: node.cpus != null ? String(node.cpus) : "",
                memory: node.memoryGib != null ? `${node.memoryGib} GiB` : "",
              },
            })),
          },
        ],
      });
    }

    const volumes = parseJsonStash<StashedVolume>(resource.resolvedOutputs["__volumes__"]);
    if (volumes.length) {
      sections.push({
        kind: "section",
        title: "Shared Volumes",
        children: [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Name" },
              { key: "id", label: "Volume ID", mono: true },
              { key: "size", label: "Size", width: "narrow" },
              { key: "status", label: "Status" },
            ],
            rows: volumes.map((volume) => ({
              cells: {
                name: volume.name,
                id: volume.id,
                size: volume.sizeTib != null ? `${volume.sizeTib} TiB` : "",
                status: volume.status ? titleCase(volume.status) : "",
              },
            })),
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("GPU cluster", fields["region"]),
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderVolumeDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapVolumeStatus(String(fields["status"] ?? ""));
    return {
      title: resource.displayName,
      subtitle: "Shared volume",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Volume",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Volume ID", value: String(fields["volumeId"] ?? ""), copyable: true },
                { key: "Name", value: String(fields["volumeName"] ?? resource.displayName) },
                ...(fields["sizeTib"] != null
                  ? [{ key: "Size", value: `${fields["sizeTib"]} TiB` }]
                  : []),
                { key: "Status", value: mapped.label },
              ],
            },
            {
              kind: "text",
              content:
                "Together refuses to delete a volume that is still attached to a cluster, so delete the cluster using it first.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFineTuneDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapFineTuneStatus(String(fields["status"] ?? ""));
    const cancellable = ["pending", "queued", "running", "compressing", "uploading"].includes(
      String(fields["status"] ?? ""),
    );
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Job",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Job ID", value: String(fields["jobId"] ?? ""), copyable: true },
              { key: "Status", value: mapped.label },
              ...(fields["baseModel"]
                ? [{ key: "Base Model", value: String(fields["baseModel"]) }]
                : []),
              ...(fields["outputName"]
                ? [{ key: "Output Model", value: String(fields["outputName"]), copyable: true }]
                : []),
              ...(fields["trainingFile"]
                ? [{ key: "Training File", value: String(fields["trainingFile"]), copyable: true }]
                : []),
              ...(fields["validationFile"]
                ? [{ key: "Validation File", value: String(fields["validationFile"]) }]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Hyperparameters",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(fields["trainingType"]
                ? [{ key: "Training Type", value: titleCase(String(fields["trainingType"])) }]
                : []),
              ...(fields["loraRank"] != null
                ? [{ key: "LoRA Rank", value: String(fields["loraRank"]) }]
                : []),
              ...(fields["epochs"] != null
                ? [{ key: "Epochs", value: String(fields["epochs"]) }]
                : []),
              ...(fields["batchSize"] != null
                ? [{ key: "Batch Size", value: String(fields["batchSize"]) }]
                : []),
              ...(fields["learningRate"] != null
                ? [{ key: "Learning Rate", value: String(fields["learningRate"]) }]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Billing",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(fields["tokenCount"] != null
                ? [{ key: "Tokens Processed", value: formatNumber(Number(fields["tokenCount"])) }]
                : []),
              ...(fields["totalPrice"] != null
                ? [{ key: "Job Price", value: `$${Number(fields["totalPrice"]).toFixed(2)}` }]
                : []),
            ],
          },
          {
            kind: "text",
            content:
              "This is the price of this single job, reported by the fine-tuning API. Account-wide spend, fine-tuning included, is in Costs.",
            variant: "muted",
          },
        ],
      },
    ];

    const checkpoints = parseJsonStash<FineTuneCheckpoint>(
      resource.resolvedOutputs["__checkpoints__"],
    );
    if (checkpoints.length) {
      sections.push({
        kind: "section",
        title: "Checkpoints",
        children: [
          {
            kind: "table",
            columns: [
              { key: "step", label: "Step", width: "narrow" },
              { key: "type", label: "Checkpoint" },
              { key: "name", label: "Model Name", mono: true, width: "wide" },
              { key: "created", label: "Created" },
            ],
            rows: checkpoints.map((checkpoint) => ({
              cells: {
                step: checkpoint.step != null ? String(checkpoint.step) : "",
                type: checkpoint.checkpoint_type ?? "",
                name: checkpoint.object_name ?? checkpoint.path ?? "",
                created: checkpoint.created_at ?? "",
              },
            })),
          },
        ],
      });
    }

    // Newest first, capped: a long job logs an event per checkpoint and epoch.
    const events = parseJsonStash<FineTuneEvent>(resource.resolvedOutputs["__events__"])
      .slice()
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .slice(0, 50);
    if (events.length) {
      sections.push({
        kind: "section",
        title: "Events",
        children: [
          {
            kind: "table",
            columns: [
              { key: "time", label: "Time" },
              { key: "level", label: "Level", width: "narrow" },
              { key: "type", label: "Event" },
              { key: "message", label: "Message", width: "wide" },
            ],
            rows: events.map((event) => ({
              cells: {
                time: event.created_at ?? "",
                level: event.level ? titleCase(event.level.replace(/^legacy_i?/, "")) : "",
                type: event.type ? titleCase(event.type) : "",
                message: event.message ?? "",
              },
            })),
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: "Fine-tuning job",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      headerActions: [
        ...(cancellable
          ? [
              {
                kind: "action" as const,
                label: "Cancel",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage:
                    "Cancel this fine-tuning job? Progress is lost and you are billed for the tokens already processed.",
                  successMessage: "Cancellation requested.",
                },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const children: SchemaNode[] = [
      {
        kind: "key-value-list",
        items: [
          { key: "File ID", value: String(fields["fileId"] ?? ""), copyable: true },
          { key: "Filename", value: String(fields["filename"] ?? resource.displayName) },
          ...(fields["purpose"] ? [{ key: "Purpose", value: String(fields["purpose"]) }] : []),
          ...(fields["fileType"] ? [{ key: "Format", value: String(fields["fileType"]) }] : []),
          ...(fields["bytes"] != null
            ? [{ key: "Size", value: formatBytes(Number(fields["bytes"])) }]
            : []),
          ...(fields["lineCount"] != null
            ? [{ key: "Lines", value: formatNumber(Number(fields["lineCount"])) }]
            : []),
          ...(fields["processingStatus"]
            ? [{ key: "Processing Status", value: titleCase(String(fields["processingStatus"])) }]
            : []),
          ...(fields["createdAt"] ? [{ key: "Uploaded", value: String(fields["createdAt"]) }] : []),
        ],
      },
    ];
    if (fields["validationError"]) {
      children.push({
        kind: "text",
        content: String(fields["validationError"]),
        variant: "mono",
      });
    }
    return {
      title: resource.displayName,
      subtitle: "Uploaded dataset",
      status: {
        kind: "status-dot",
        status: fields["validationError"] ? "error" : "info",
        label: formatBytes(Number(fields["bytes"] ?? 0)),
      },
      sections: [{ kind: "section", title: "File", children }],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderBatchDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapBatchStatus(String(fields["status"] ?? ""));
    const cancellable = ["VALIDATING", "IN_PROGRESS"].includes(String(fields["status"] ?? ""));
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Batch",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Batch ID", value: String(fields["batchId"] ?? ""), copyable: true },
              { key: "Status", value: mapped.label },
              ...(fields["endpoint"]
                ? [{ key: "Endpoint", value: String(fields["endpoint"]) }]
                : []),
              ...(fields["model"] ? [{ key: "Model", value: String(fields["model"]) }] : []),
              ...(fields["progress"] != null
                ? // Together reports progress on a 0–100 scale.
                  [{ key: "Progress", value: `${Number(fields["progress"]).toFixed(0)}%` }]
                : []),
              ...(fields["jobDeadline"]
                ? [{ key: "Deadline", value: String(fields["jobDeadline"]) }]
                : []),
              ...(fields["createdAt"]
                ? [{ key: "Created", value: String(fields["createdAt"]) }]
                : []),
              ...(fields["completedAt"]
                ? [{ key: "Completed", value: String(fields["completedAt"]) }]
                : []),
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
              ...(fields["inputFileId"]
                ? [{ key: "Input File", value: String(fields["inputFileId"]), copyable: true }]
                : []),
              ...(fields["outputFileId"]
                ? [{ key: "Output File", value: String(fields["outputFileId"]), copyable: true }]
                : []),
              ...(fields["errorFileId"]
                ? [{ key: "Error File", value: String(fields["errorFileId"]), copyable: true }]
                : []),
              ...(fields["fileSizeBytes"] != null
                ? [{ key: "Input Size", value: formatBytes(Number(fields["fileSizeBytes"])) }]
                : []),
            ],
          },
        ],
      },
    ];
    if (fields["error"]) {
      sections.push({
        kind: "section",
        title: "Error",
        children: [{ kind: "text", content: String(fields["error"]), variant: "mono" }],
      });
    }
    return {
      title: resource.displayName,
      subtitle: "Batch job",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      headerActions: [
        ...(cancellable
          ? [
              {
                kind: "action" as const,
                label: "Cancel",
                variant: "danger" as const,
                action: {
                  type: "plugin-action" as const,
                  actionId: "cancel",
                  confirmMessage: "Cancel this batch job? Completed rows are still billed.",
                  successMessage: "Cancellation requested.",
                },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderEvaluationDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapEvaluationStatus(String(fields["status"] ?? ""));
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Evaluation",
        children: [
          {
            kind: "key-value-list",
            items: [
              // The identifier is `workflow_id`; there is no `id` on this object.
              { key: "Workflow ID", value: String(fields["workflowId"] ?? ""), copyable: true },
              { key: "Status", value: mapped.label },
              ...(fields["type"]
                ? [{ key: "Type", value: titleCase(String(fields["type"])) }]
                : []),
              ...(fields["model"] ? [{ key: "Model", value: String(fields["model"]) }] : []),
              ...(fields["judgeModel"]
                ? [{ key: "Judge Model", value: String(fields["judgeModel"]) }]
                : []),
              ...(fields["ownerId"] ? [{ key: "Owner", value: String(fields["ownerId"]) }] : []),
              ...(fields["createdAt"]
                ? [{ key: "Created", value: String(fields["createdAt"]) }]
                : []),
              ...(fields["updatedAt"]
                ? [{ key: "Updated", value: String(fields["updatedAt"]) }]
                : []),
            ],
          },
        ],
      },
    ];
    if (fields["parameters"]) {
      sections.push({
        kind: "section",
        title: "Parameters",
        children: [
          { kind: "text", content: String(fields["parameters"]), variant: "mono", copyable: true },
        ],
      });
    }
    return {
      title: resource.displayName,
      subtitle: "Evaluation job",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderHardwareDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const cents = fields["centsPerMinute"];
    const availability = String(fields["availability"] ?? "");
    const children: SchemaNode[] = [
      {
        kind: "key-value-list",
        items: [
          { key: "Hardware ID", value: String(fields["hardwareId"] ?? ""), copyable: true },
          ...(fields["gpuType"] ? [{ key: "GPU Type", value: String(fields["gpuType"]) }] : []),
          ...(fields["gpuCount"] != null
            ? [{ key: "GPU Count", value: String(fields["gpuCount"]) }]
            : []),
          ...(fields["gpuMemoryGb"] != null
            ? [{ key: "GPU Memory", value: `${fields["gpuMemoryGb"]} GB` }]
            : []),
          ...(fields["gpuLink"] ? [{ key: "Interconnect", value: String(fields["gpuLink"]) }] : []),
          ...(cents != null
            ? [
                {
                  key: "Price",
                  value: `${cents}¢/minute (≈ $${((Number(cents) / 100) * 60).toFixed(2)}/hour)`,
                },
              ]
            : []),
          ...(availability ? [{ key: "Availability", value: titleCase(availability) }] : []),
          ...(fields["updatedAt"] ? [{ key: "Updated", value: String(fields["updatedAt"]) }] : []),
        ],
      },
    ];
    if (!availability) {
      children.push({
        kind: "text",
        // Together only fills `availability` when the request names a model.
        content:
          "Availability is only reported when the hardware list is queried for a specific model, so it is blank here. Together shows live availability on the create-endpoint form.",
        variant: "muted",
      });
    }
    return {
      title: resource.displayName,
      subtitle: "GPU configuration",
      status: {
        kind: "status-dot",
        status: availability === "available" ? "healthy" : "info",
        ...(availability ? { label: titleCase(availability) } : {}),
      },
      sections: [{ kind: "section", title: "Hardware", children }],
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

/** Documented Kokoro + Orpheus rosters, used when `GET /v1/voices` is unavailable. */
function fallbackVoices(): StashedVoice[] {
  const voices: StashedVoice[] = [];
  for (const [model, names] of Object.entries(FALLBACK_VOICES)) {
    for (const name of names) voices.push({ model, value: name, label: name });
  }
  return voices;
}

function toInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assertMultipleOf8(label: string, value: number): void {
  if (value < 0 || value % 8 !== 0) {
    throw new Error(`Together plugin: ${label} must be a multiple of 8 (got ${value})`);
  }
}

/**
 * Turn the cluster create form into a `GPUClusterCreateRequest`. Validates
 * the conditional requirements the spec states in prose (Slurm shared
 * memory, the scheduled-capacity window, the driver selector) so they fail
 * here with a readable message instead of as a 400.
 * https://docs.together.ai/reference/clusters-create
 */
export function buildClusterCreateBody(fields: Record<string, string>): Record<string, unknown> {
  const region = fields["region"] ?? "";
  const numGpus = toInt(fields["num_gpus"], 8);
  assertMultipleOf8("GPU count", numGpus);
  if (numGpus < 8) throw new Error("Together plugin: a cluster needs at least 8 GPUs");
  const clusterType = fields["cluster_type"] === "SLURM" ? "SLURM" : "KUBERNETES";
  const billingType = ["RESERVED", "SCHEDULED_CAPACITY"].includes(fields["billing_type"] ?? "")
    ? (fields["billing_type"] as string)
    : "ON_DEMAND";

  const body: Record<string, unknown> = {
    cluster_name: fields["cluster_name"] ?? "",
    region,
    gpu_type: fields["gpu_type"] ?? "",
    num_gpus: numGpus,
    cluster_type: clusterType,
    billing_type: billingType,
  };

  const versionId = fields[`nvidia_version_id@${region}`];
  if (versionId) {
    body["nvidia_version_id"] = versionId;
  } else if (fields["nvidia_driver_version"] && fields["cuda_version"]) {
    body["nvidia_driver_version"] = fields["nvidia_driver_version"];
    body["cuda_version"] = fields["cuda_version"];
  } else {
    throw new Error(`Together plugin: pick an NVIDIA driver offered in ${region || "the region"}`);
  }

  if (clusterType === "SLURM") {
    const shm = toInt(fields["slurm_shm_size_gib"], 0);
    if (shm < 1) throw new Error("Together plugin: Slurm clusters need a shared memory size");
    body["slurm_shm_size_gib"] = shm;
  }

  if (billingType === "RESERVED") {
    const days = toInt(fields["duration_days"], 0);
    if (days < 1) throw new Error("Together plugin: reserved clusters need a duration in days");
    body["duration_days"] = days;
  }
  if (billingType === "SCHEDULED_CAPACITY") {
    const start = fields["reservation_start_time"];
    const end = fields["reservation_end_time"];
    if (!start || !end) {
      throw new Error("Together plugin: scheduled capacity needs a reservation start and end");
    }
    body["reservation_start_time"] = start;
    body["reservation_end_time"] = end;
  }

  const preemptible = toInt(fields["num_preemptible_gpus"], 0);
  if (preemptible > 0) {
    assertMultipleOf8("Preemptible GPU count", preemptible);
    body["num_preemptible_gpus"] = preemptible;
  }

  const volume = fields["shared_volume"] ?? "none";
  if (volume === "new") {
    const size = toInt(fields["volume_size_tib"], 0);
    if (!fields["volume_name"] || size < 1) {
      throw new Error(
        "Together plugin: a new shared volume needs a name and a size of 1 TiB or more",
      );
    }
    body["shared_volume"] = { volume_name: fields["volume_name"], size_tib: size, region };
  } else if (volume && volume !== "none") {
    body["volume_id"] = volume;
  }

  return body;
}

/**
 * One line item → one cost row. `product_name` is the service. The spec
 * leaves `pricing_dimensions` and `attributes` open per product, so every
 * key is kept as a tag, and a model named in either becomes the resource.
 */
function costRowFor(date: string, currency: string, item: BillingUsageLineItem): CostRow {
  const dimensions = item.pricing_dimensions ?? {};
  const attributes = item.attributes ?? {};
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...dimensions, ...attributes })) {
    if (typeof value === "string" && value) tags[key] = value;
  }
  const resource = attributes["model"] || dimensions["model"] || "";
  return {
    date,
    ...(item.product_name ? { service: item.product_name } : {}),
    ...(resource ? { resourceId: resource } : {}),
    ...(Object.keys(tags).length ? { tags } : {}),
    currency,
    amount: 0,
  };
}

function costRowKey(row: CostRow): string {
  const tags = Object.entries(row.tags ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return [row.date, row.service ?? "", row.resourceId ?? "", tags, row.currency].join("|");
}
