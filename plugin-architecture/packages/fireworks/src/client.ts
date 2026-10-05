import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceCreateResult,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  CostSetupError,
  jsonRestFetch,
  externalIdOf,
  withAiCostTags,
} from "@infrawrench/plugin-base";
import {
  formatAuditLogEntry,
  histogramQuantile,
  parsePromText,
  sumSamples,
  type AuditLogEntry,
  type PromSample,
} from "./observability.js";

const HOST = "https://api.fireworks.ai";
/** The account is encoded in the model string on this plane, not in the path. */
const INFERENCE_BASE = `${HOST}/inference/v1`;

/** `pageSize` is clamped server-side at 200; anything larger is silently coerced. */
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

/** `GET /billingUsage` refuses a window wider than 31 days. */
const MAX_USAGE_WINDOW_DAYS = 31;

// ---------------------------------------------------------------------------
// Wire shapes: mirrored from https://docs.fireworks.ai/merged.openapi.yaml
// ---------------------------------------------------------------------------

/** Every control-plane list answers `{<plural>: [], nextPageToken, totalSize}`. */
type ListEnvelope<K extends string, T> = {
  [P in K]?: T[];
} & { nextPageToken?: string; totalSize?: number };

interface GatewayStatus {
  code?: string;
  message?: string;
}

interface ReplicaStats {
  pendingSchedulingReplicaCount?: number;
  downloadingModelReplicaCount?: number;
  initializingReplicaCount?: number;
  readyReplicaCount?: number;
  revocableReplicaCount?: number;
  effectiveReplicaCount?: number;
}

interface Deployment {
  name?: string;
  displayName?: string;
  description?: string;
  createTime?: string;
  expireTime?: string;
  state?: string;
  status?: GatewayStatus | null;
  minReplicaCount?: number;
  maxReplicaCount?: number;
  desiredReplicaCount?: number;
  replicaCount?: number;
  autoscalingPolicy?: {
    scaleUpWindow?: string;
    scaleDownWindow?: string;
    scaleToZeroWindow?: string;
  } | null;
  baseModel?: string;
  acceleratorType?: string;
  acceleratorCount?: number;
  precision?: string;
  region?: string;
  cluster?: string;
  replicaStats?: ReplicaStats | null;
}

interface Model {
  name?: string;
  displayName?: string;
  description?: string;
  createTime?: string;
  state?: string;
  status?: GatewayStatus | null;
  kind?: string;
  githubUrl?: string;
  huggingFaceUrl?: string;
  /** int64: arrives as a JSON string. */
  baseModelDetails?: { parameterCount?: string; modelType?: string } | null;
  peftDetails?: { baseModel?: string; r?: number } | null;
  public?: boolean;
  contextLength?: number;
  supportsImageInput?: boolean;
  supportsTools?: boolean;
  supportsLora?: boolean;
  supportsServerless?: boolean;
  deprecationDate?: { year?: number; month?: number; day?: number } | null;
}

interface Dataset {
  name?: string;
  displayName?: string;
  createTime?: string;
  state?: string;
  status?: GatewayStatus | null;
  /** int64: arrives as a JSON string. */
  exampleCount?: string | number;
  estimatedTokenCount?: string | number;
  averageTurnCount?: number;
  format?: string;
  createdBy?: string;
  userUploaded?: Record<string, never> | null;
  transformed?: unknown;
  splitted?: unknown;
  evaluationResult?: unknown;
}

interface DeployedModel {
  name?: string;
  displayName?: string;
  createTime?: string;
  model?: string;
  deployment?: string;
  default?: boolean;
  state?: string;
  serverless?: boolean;
  public?: boolean;
}

interface JobProgress {
  percent?: number;
  totalInputRequests?: number;
  successfullyProcessedRequests?: number;
  failedRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface BatchInferenceJob {
  name?: string;
  displayName?: string;
  createTime?: string;
  expireTime?: string;
  createdBy?: string;
  state?: string;
  status?: GatewayStatus | null;
  model?: string;
  inputDatasetId?: string;
  outputDatasetId?: string;
  jobProgress?: JobProgress | null;
  /** There is no `completionTime` on this object: the end stamp lives here. */
  lifecycle?: { validatedTime?: string; runStartTime?: string; endTime?: string } | null;
}

interface Money {
  currencyCode?: string;
  /** int64: arrives as a JSON string. */
  units?: string;
  nanos?: number;
}

interface SupervisedFineTuningJob {
  name?: string;
  displayName?: string;
  createTime?: string;
  /** Note: `completedTime`, not `completionTime`. */
  completedTime?: string;
  dataset?: string;
  evaluationDataset?: string;
  state?: string;
  status?: GatewayStatus | null;
  createdBy?: string;
  outputModel?: string;
  baseModel?: string;
  epochs?: number;
  learningRate?: number;
  loraRank?: number;
  batchSizeSamples?: number;
  jobProgress?: JobProgress | null;
  estimatedCost?: Money | null;
}

interface ApiKey {
  keyId?: string;
  displayName?: string;
  /** Only ever populated on the create response. */
  key?: string;
  createTime?: string;
  secure?: boolean;
  email?: string;
  prefix?: string;
  expireTime?: string;
}

interface User {
  name?: string;
  displayName?: string;
  email?: string;
  role?: string;
  state?: string;
  serviceAccount?: boolean;
  permissionPreset?: string;
  createTime?: string;
  updateTime?: string;
}

/** https://docs.fireworks.ai/api-reference/list-routers */
interface Router {
  name?: string;
  displayName?: string;
  createTime?: string;
  createdBy?: string;
  state?: string;
  status?: GatewayStatus | null;
  deployments?: string[];
  model?: string;
  /** Strategy is a oneof: exactly one of these empty marker objects is set. */
  weightedRandom?: Record<string, never> | null;
  evenLoad?: Record<string, never> | null;
  aliases?: string[];
  autoGenerated?: boolean;
  public?: boolean;
}

/** `gatewayBaseTrainingConfig`, shared by DPO and RFT jobs. */
interface TrainingConfig {
  outputModel?: string;
  baseModel?: string;
  learningRate?: number;
  loraRank?: number;
  epochs?: number;
  batchSizeSamples?: number;
}

interface LossConfig {
  method?: string;
  klBeta?: number;
}

/** https://docs.fireworks.ai/api-reference/list-dpo-jobs */
interface DpoJob {
  name?: string;
  displayName?: string;
  createTime?: string;
  completedTime?: string;
  dataset?: string;
  state?: string;
  status?: GatewayStatus | null;
  createdBy?: string;
  trainingConfig?: TrainingConfig | null;
  lossConfig?: LossConfig | null;
  wandbConfig?: { url?: string } | null;
}

interface RftJobProgress extends JobProgress {
  epoch?: number;
}

/** https://docs.fireworks.ai/api-reference/list-reinforcement-fine-tuning-jobs */
interface ReinforcementFineTuningJob extends DpoJob {
  evaluationDataset?: string;
  evaluator?: string;
  jobProgress?: RftJobProgress | null;
  nodeCount?: number;
}

/** https://docs.fireworks.ai/api-reference/list-evaluators */
interface Evaluator {
  name?: string;
  displayName?: string;
  description?: string;
  createTime?: string;
  createdBy?: string;
  updateTime?: string;
  state?: string;
  status?: GatewayStatus | null;
  entryPoint?: string;
  commitHash?: string;
  source?: { type?: string; githubRepositoryName?: string } | null;
  defaultDataset?: string;
}

/** https://docs.fireworks.ai/api-reference/list-evaluation-jobs */
interface EvaluationJob {
  name?: string;
  displayName?: string;
  createTime?: string;
  createdBy?: string;
  updateTime?: string;
  state?: string;
  status?: GatewayStatus | null;
  evaluator?: string;
  inputDataset?: string;
  outputDataset?: string;
  metrics?: Record<string, unknown> | null;
}

interface Secret {
  name?: string;
  keyName?: string;
}

interface Quota {
  name?: string;
  /** int64: arrives as a JSON string. */
  value?: string | number;
  maxValue?: string | number;
  usage?: number;
  updateTime?: string;
}

interface UsageCostRow {
  dimensions?: {
    startTime?: string;
    model?: string;
    user?: string;
    apiKeyId?: string;
    unknownModel?: boolean;
  } | null;
  subtotal?: Money | null;
}

interface UsageCostsResponse {
  rows?: UsageCostRow[];
  nextPageToken?: string;
  subtotal?: Money | null;
  attributionCompleteness?: string;
}

interface ServerlessUsage {
  modelName?: string;
  promptTokens?: string | number;
  completionTokens?: string | number;
  cachedPromptTokens?: string | number;
  startTime?: string;
  endTime?: string;
  group?: Record<string, string> | null;
  /**
   * Nano-USD (1e-9 USD). Deliberately unused: the spec states it is "0 when
   * absent (not free)" and only one upstream stamps an authoritative cost, so
   * it under-reports badly. Real money comes from `usageCosts:query`.
   */
  costNanoUsd?: number;
}

interface DedicatedUsage {
  deploymentId?: string;
  acceleratorType?: string;
  /** int64: arrives as a JSON string. */
  acceleratorSeconds?: string | number;
  startTime?: string;
  endTime?: string;
  baseModel?: string;
  group?: Record<string, string> | null;
}

interface BillingUsageResponse {
  serverlessCosts?: ServerlessUsage[];
  dedicatedCosts?: DedicatedUsage[];
  trainingCosts?: Array<{
    jobId?: string;
    acceleratorSeconds?: string | number;
    tokens?: string | number;
    startTime?: string;
    endTime?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `accounts/{acct}/deployments/{id}` → `{id}`. */
function lastSegment(name: string | undefined): string {
  if (!name) return "";
  const parts = name.split("/");
  return parts[parts.length - 1] ?? "";
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Current values for one deployment, from the recording rules documented at
 * https://docs.fireworks.ai/deployments/exporting-metrics. Latencies are ms,
 * rates per second, the `generator_*_fraction` gauges 0 to 1.
 */
interface LiveDeploymentMetrics {
  requestsPerSec?: number | undefined;
  errorsPerSec?: number | undefined;
  promptTokensPerSec?: number | undefined;
  cachedPromptPct?: number | undefined;
  ttftP50?: number | undefined;
  ttftP99?: number | undefined;
  e2eP50?: number | undefined;
  e2eP99?: number | undefined;
  perTokenP50?: number | undefined;
  generationQueueP50?: number | undefined;
  prefillP50?: number | undefined;
  prefillQueueP50?: number | undefined;
  concurrentRequests?: number | undefined;
  kvBlocksPct?: number | undefined;
  kvSlotsPct?: number | undefined;
}

function liveDeploymentMetrics(samples: PromSample[]): LiveDeploymentMetrics | null {
  if (samples.length === 0) return null;
  const q = (metric: string, quantile: number) =>
    histogramQuantile(samples, `${metric}_bucket:sum_by_deployment`, quantile);
  const mean = (name: string): number | undefined => {
    const values = samples.filter((s) => s.name === name).map((s) => s.value);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
  };
  const prompt = sumSamples(samples, "tokens_prompt_total:sum_by_deployment");
  const cached = sumSamples(samples, "tokens_cached_prompt_total:sum_by_deployment");
  const kvBlocks = mean("generator_kv_blocks_fraction:avg_by_deployment");
  const kvSlots = mean("generator_kv_slots_fraction:avg_by_deployment");
  const live: LiveDeploymentMetrics = {
    requestsPerSec: sumSamples(samples, "request_counter_total:sum_by_deployment"),
    errorsPerSec: sumSamples(samples, "requests_error_total:sum_by_deployment"),
    promptTokensPerSec: prompt,
    cachedPromptPct: prompt && cached !== undefined ? (100 * cached) / prompt : undefined,
    ttftP50: q("latency_to_first_token_ms", 0.5),
    ttftP99: q("latency_to_first_token_ms", 0.99),
    e2eP50: q("latency_overall_ms", 0.5),
    e2eP99: q("latency_overall_ms", 0.99),
    perTokenP50: q("latency_generation_per_token_ms", 0.5),
    generationQueueP50: q("latency_generation_queue_ms", 0.5),
    prefillP50: q("latency_prefill_ms", 0.5),
    prefillQueueP50: q("latency_prefill_queue_ms", 0.5),
    concurrentRequests: sumSamples(
      samples,
      "requests_coordinator_concurrent_count:avg_by_deployment",
    ),
    kvBlocksPct: kvBlocks === undefined ? undefined : kvBlocks * 100,
    kvSlotsPct: kvSlots === undefined ? undefined : kvSlots * 100,
  };
  // JSON drops the undefined keys, so only what was reported is stashed.
  return Object.values(live).some((v) => v !== undefined) ? live : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Fireworks returns every int64 field as a JSON string. */
function toNumber(value: string | number | undefined | null): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * google.type.Money → a plain float. `units` is the whole-currency part (an
 * int64 string) and `nanos` the 10^-9 fraction; both carry the same sign.
 */
function moneyToNumber(money: Money | null | undefined): number {
  if (!money) return 0;
  const units = toNumber(money.units) ?? 0;
  const nanos = money.nanos ?? 0;
  return units + nanos / 1e9;
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

/** `JOB_STATE_COMPLETED` → `Completed`; `NVIDIA_H100_80GB` → `Nvidia H100 80GB`. */
function prettyEnum(value: string | undefined, prefix?: string): string {
  if (!value) return "";
  let text = value;
  if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
  if (text.endsWith("UNSPECIFIED")) return "Unspecified";
  return titleCase(text);
}

function mapDeploymentState(state: string | undefined): {
  status: ResourceStatus;
  label: string;
} {
  switch (state) {
    case "READY":
      return { status: "healthy", label: "Ready" };
    case "CREATING":
    case "UPDATING":
      return { status: "provisioning", label: titleCase(state) };
    case "DELETING":
      return { status: "degraded", label: "Deleting" };
    case "DELETED":
      return { status: "unknown", label: "Deleted" };
    case "FAILED":
      return { status: "error", label: "Failed" };
    default:
      return { status: "info", label: prettyEnum(state, "STATE_") || "Unknown" };
  }
}

/** The 20-value `gatewayJobState` shared by batch, SFT, DPO and RFT jobs. */
function mapJobState(state: string | undefined): { status: ResourceStatus; label: string } {
  const short = (state ?? "").replace(/^JOB_STATE_/, "");
  switch (short) {
    case "COMPLETED":
      return { status: "healthy", label: "Completed" };
    case "RUNNING":
    case "CREATING":
    case "VALIDATING":
    case "PENDING":
    case "WRITING_RESULTS":
    case "RE_QUEUEING":
    case "CREATING_INPUT_DATASET":
      return { status: "provisioning", label: titleCase(short) };
    case "FAILED":
      return { status: "error", label: "Failed" };
    case "CANCELLED":
    case "CANCELLING":
    case "DELETED":
    case "ARCHIVED":
      return { status: "unknown", label: titleCase(short) };
    case "EXPIRED":
    case "EARLY_STOPPED":
    case "PAUSED":
    case "IDLE":
      return { status: "degraded", label: titleCase(short) };
    default:
      return { status: "info", label: prettyEnum(state, "JOB_STATE_") || "Unknown" };
  }
}

function mapReadyState(state: string | undefined): { status: ResourceStatus; label: string } {
  switch (state) {
    case "READY":
    case "DEPLOYED":
      return { status: "healthy", label: titleCase(state) };
    case "UPLOADING":
    case "DEPLOYING":
    case "UPDATING":
      return { status: "provisioning", label: titleCase(state) };
    case "UNDEPLOYING":
      return { status: "degraded", label: "Undeploying" };
    default:
      return { status: "info", label: prettyEnum(state, "STATE_") || "Unknown" };
  }
}

function mapEvaluatorState(state: string | undefined): { status: ResourceStatus; label: string } {
  switch (state) {
    case "ACTIVE":
      return { status: "healthy", label: "Active" };
    case "BUILDING":
      return { status: "provisioning", label: "Building" };
    case "BUILD_FAILED":
      return { status: "error", label: "Build failed" };
    default:
      return { status: "info", label: prettyEnum(state, "STATE_") || "Unknown" };
  }
}

/** Key/value rows for whichever of `keys` the resource actually carries. */
function kvItems(
  fields: Record<string, unknown>,
  keys: Array<[label: string, key: string, copyable?: boolean]>,
): Array<{ key: string; value: string; copyable?: boolean }> {
  const items: Array<{ key: string; value: string; copyable?: boolean }> = [];
  for (const [label, key, copyable] of keys) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    const text =
      typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : typeof value === "number"
          ? formatNumber(value)
          : String(value);
    items.push({ key: label, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return items;
}

function isoDate(value: string | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function addDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Fireworks AI plugin client. One instance per account.
 *
 * Fireworks has **two planes**. Inference lives at `/inference/v1` and encodes
 * the account inside the model string (`accounts/{id}/models/{model}`); the
 * control plane lives at `/v1/accounts/{account_id}/…` and requires the account
 * id in every single path. There is **no whoami endpoint** to discover that id,
 * which is why it is a required credential rather than something we look up.
 * https://docs.fireworks.ai/api-reference/introduction
 */
export class FireworksClient implements PluginClient {
  private readonly apiKey: string;
  private readonly accountId: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Fireworks plugin: missing apiKey credential");
    const accountId = credentials["accountId"];
    if (!accountId) {
      throw new Error(
        "Fireworks plugin: missing accountId credential; Fireworks has no whoami endpoint, so the account id must be supplied",
      );
    }
    this.apiKey = apiKey;
    this.accountId = accountId;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** Control-plane path, always rooted at `/v1/accounts/{account_id}`. */
  private accountPath(suffix: string): string {
    return `${HOST}/v1/accounts/${encodeURIComponent(this.accountId)}${suffix}`;
  }

  private async request<T>(url: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Fireworks",
      url,
      errorPath: url.startsWith(HOST) ? url.slice(HOST.length) : url,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  /**
   * A plain-text GET: the Prometheus exposition, or a signed log-file URL.
   * Signed URLs carry their own authorization, so the API key is only sent
   * to Fireworks' own host.
   */
  private async fetchText(url: string): Promise<string> {
    const headers: Record<string, string> = { Accept: "text/plain, */*" };
    if (url.startsWith(HOST)) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const label = url.startsWith(HOST) ? url.slice(HOST.length).split("?")[0] : "signed log URL";
    if (this.services?.http) {
      const result = await this.services.http.request({
        url,
        method: "GET",
        headers,
        ...(this.caCert && url.startsWith(HOST) ? { caCert: this.caCert } : {}),
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Fireworks API error ${result.status} for ${label}: ${result.body}`);
      }
      return result.body;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Fireworks API error ${res.status} for ${label}: ${await res.text()}`);
    }
    return res.text();
  }

  /**
   * Walk a `pageSize`/`pageToken` → `nextPageToken` collection. `pageSize` is
   * pinned to the documented maximum of 200; larger values are coerced anyway.
   */
  private async paginate<K extends string, T>(
    suffix: string,
    key: K,
    extraQuery = "",
  ): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const data = await this.request<ListEnvelope<K, T>>(
        this.accountPath(`${suffix}?pageSize=${PAGE_SIZE}${extraQuery}${token}`),
      );
      const list = data[key];
      if (Array.isArray(list)) items.push(...list);
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return items;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "deployment": {
        const items = await this.paginate<"deployments", Deployment>("/deployments", "deployments");
        return items.map((item) => this.mapDeployment(item, accountId));
      }
      case "model": {
        const items = await this.paginate<"models", Model>("/models", "models");
        return items.map((item) => this.mapModel(item, accountId));
      }
      case "dataset": {
        const items = await this.paginate<"datasets", Dataset>("/datasets", "datasets");
        return items.map((item) => this.mapDataset(item, accountId));
      }
      case "deployed-model": {
        const items = await this.paginate<"deployedModels", DeployedModel>(
          "/deployedModels",
          "deployedModels",
        );
        return items.map((item) => this.mapDeployedModel(item, accountId));
      }
      case "batch-inference-job": {
        const items = await this.paginate<"batchInferenceJobs", BatchInferenceJob>(
          "/batchInferenceJobs",
          "batchInferenceJobs",
        );
        return items.map((item) => this.mapBatchJob(item, accountId));
      }
      case "supervised-fine-tuning-job": {
        const items = await this.paginate<"supervisedFineTuningJobs", SupervisedFineTuningJob>(
          "/supervisedFineTuningJobs",
          "supervisedFineTuningJobs",
        );
        return items.map((item) => this.mapFineTuningJob(item, accountId));
      }
      case "secret": {
        const items = await this.paginate<"secrets", Secret>("/secrets", "secrets");
        return items.map((item) => this.mapSecret(item, accountId));
      }
      case "quota": {
        const items = await this.paginate<"quotas", Quota>("/quotas", "quotas");
        return items.map((item) => this.mapQuota(item, accountId));
      }
      case "api-key":
        return this.listApiKeys(accountId);
      case "router": {
        const items = await this.paginate<"routers", Router>("/routers", "routers");
        return items.map((item) => this.mapRouter(item, accountId));
      }
      case "dpo-job": {
        const items = await this.paginate<"dpoJobs", DpoJob>("/dpoJobs", "dpoJobs");
        return items.map((item) => this.mapDpoJob(item, accountId));
      }
      case "reinforcement-fine-tuning-job": {
        const items = await this.paginate<
          "reinforcementFineTuningJobs",
          ReinforcementFineTuningJob
        >("/reinforcementFineTuningJobs", "reinforcementFineTuningJobs");
        return items.map((item) => this.mapRftJob(item, accountId));
      }
      case "evaluator": {
        const items = await this.paginate<"evaluators", Evaluator>("/evaluators", "evaluators");
        return items.map((item) => this.mapEvaluator(item, accountId));
      }
      case "evaluation-job": {
        const items = await this.paginate<"evaluationJobs", EvaluationJob>(
          "/evaluationJobs",
          "evaluationJobs",
        );
        return items.map((item) => this.mapEvaluationJob(item, accountId));
      }
      case "user": {
        const items = await this.paginate<"users", User>("/users", "users");
        return items.map((item) => this.mapUser(item, accountId));
      }
      default:
        throw new Error(`Fireworks plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * `GET /v1/accounts/{aid}/users/{uid}/apiKeys`. Passing `-` as the user id
   * asks for every user's keys (and service accounts'), which is what an
   * account-level listing should show. Pagination on this route is a documented
   * TODO, so we do not rely on `nextPageToken` here.
   * https://docs.fireworks.ai/api-reference/list-api-keys
   */
  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.request<ListEnvelope<"apiKeys", ApiKey>>(
      this.accountPath(`/users/-/apiKeys?pageSize=${PAGE_SIZE}`),
    );
    return (data.apiKeys ?? []).map((key) => this.mapApiKey(key, accountId, "-"));
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapDeployment(deployment: Deployment, accountId: string): ResourceInstance {
    const id = lastSegment(deployment.name);
    const displayName = deployment.displayName || id;
    const createdAt = deployment.createTime ?? nowIso();
    const stats = deployment.replicaStats ?? {};
    return {
      id: `${accountId}:deployment:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "deployment",
      accountId,
      displayName,
      fields: {
        displayName,
        deploymentId: id,
        ...(deployment.baseModel ? { baseModel: deployment.baseModel } : {}),
        ...(deployment.state ? { state: deployment.state } : {}),
        ...(deployment.status?.message ? { statusMessage: deployment.status.message } : {}),
        ...(deployment.acceleratorType ? { acceleratorType: deployment.acceleratorType } : {}),
        ...(deployment.acceleratorCount != null
          ? { acceleratorCount: deployment.acceleratorCount }
          : {}),
        ...(deployment.replicaCount != null ? { replicaCount: deployment.replicaCount } : {}),
        ...(deployment.desiredReplicaCount != null
          ? { desiredReplicaCount: deployment.desiredReplicaCount }
          : {}),
        ...(deployment.minReplicaCount != null
          ? { minReplicaCount: deployment.minReplicaCount }
          : {}),
        ...(deployment.maxReplicaCount != null
          ? { maxReplicaCount: deployment.maxReplicaCount }
          : {}),
        ...(stats.readyReplicaCount != null ? { readyReplicaCount: stats.readyReplicaCount } : {}),
        ...(deployment.region ? { region: deployment.region } : {}),
        ...(deployment.precision ? { precision: deployment.precision } : {}),
        ...(deployment.autoscalingPolicy?.scaleToZeroWindow
          ? { scaleToZeroWindow: deployment.autoscalingPolicy.scaleToZeroWindow }
          : {}),
        createTime: createdAt,
        ...(deployment.expireTime ? { expireTime: deployment.expireTime } : {}),
      },
      resolvedOutputs: {
        deploymentName: deployment.name ?? "",
        deploymentId: id,
        baseModel: deployment.baseModel ?? "",
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapModel(model: Model, accountId: string): ResourceInstance {
    const id = lastSegment(model.name);
    const displayName = model.displayName || id;
    const createdAt = model.createTime ?? nowIso();
    const parameters = toNumber(model.baseModelDetails?.parameterCount);
    const deprecation = model.deprecationDate;
    return {
      id: `${accountId}:model:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "model",
      accountId,
      displayName,
      fields: {
        displayName,
        modelId: id,
        ...(model.kind ? { kind: model.kind } : {}),
        ...(model.state ? { state: model.state } : {}),
        ...(model.description ? { description: model.description } : {}),
        ...(model.contextLength != null ? { contextLength: model.contextLength } : {}),
        ...(parameters != null ? { parameterCount: formatNumber(parameters) } : {}),
        ...(model.public != null ? { public: model.public } : {}),
        ...(model.supportsServerless != null
          ? { supportsServerless: model.supportsServerless }
          : {}),
        ...(model.supportsLora != null ? { supportsLora: model.supportsLora } : {}),
        ...(model.supportsImageInput != null
          ? { supportsImageInput: model.supportsImageInput }
          : {}),
        ...(model.supportsTools != null ? { supportsTools: model.supportsTools } : {}),
        ...(model.huggingFaceUrl ? { huggingFaceUrl: model.huggingFaceUrl } : {}),
        ...(model.githubUrl ? { githubUrl: model.githubUrl } : {}),
        ...(deprecation?.year
          ? {
              deprecationDate: `${deprecation.year}-${String(deprecation.month ?? 1).padStart(2, "0")}-${String(deprecation.day ?? 1).padStart(2, "0")}`,
            }
          : {}),
        createTime: createdAt,
      },
      resolvedOutputs: {
        // The full resource name IS the inference `model` string.
        modelName: model.name ?? "",
        modelId: id,
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapDataset(dataset: Dataset, accountId: string): ResourceInstance {
    const id = lastSegment(dataset.name);
    const displayName = dataset.displayName || id;
    const createdAt = dataset.createTime ?? nowIso();
    // `userUploaded` / `transformed` / `splitted` / `evaluationResult` are
    // mutually-exclusive marker objects, not booleans: flatten to one label.
    const source = dataset.userUploaded
      ? "User uploaded"
      : dataset.transformed
        ? "Transformed"
        : dataset.splitted
          ? "Split"
          : dataset.evaluationResult
            ? "Evaluation result"
            : "";
    const examples = toNumber(dataset.exampleCount);
    const tokens = toNumber(dataset.estimatedTokenCount);
    return {
      id: `${accountId}:dataset:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "dataset",
      accountId,
      displayName,
      fields: {
        displayName,
        datasetId: id,
        ...(dataset.state ? { state: dataset.state } : {}),
        ...(dataset.status?.message ? { statusMessage: dataset.status.message } : {}),
        ...(examples != null ? { exampleCount: examples } : {}),
        ...(tokens != null ? { estimatedTokenCount: tokens } : {}),
        ...(dataset.averageTurnCount != null ? { averageTurnCount: dataset.averageTurnCount } : {}),
        ...(dataset.format ? { format: dataset.format } : {}),
        ...(source ? { source } : {}),
        ...(dataset.createdBy ? { createdBy: dataset.createdBy } : {}),
        createTime: createdAt,
      },
      resolvedOutputs: { datasetName: dataset.name ?? "", datasetId: id },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapDeployedModel(deployed: DeployedModel, accountId: string): ResourceInstance {
    const id = lastSegment(deployed.name);
    const displayName = deployed.displayName || id;
    const createdAt = deployed.createTime ?? nowIso();
    return {
      id: `${accountId}:deployed-model:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "deployed-model",
      accountId,
      displayName,
      fields: {
        displayName,
        deployedModelId: id,
        ...(deployed.model ? { model: deployed.model } : {}),
        ...(deployed.deployment ? { deployment: deployed.deployment } : {}),
        ...(deployed.state ? { state: deployed.state } : {}),
        ...(deployed.default != null ? { isDefault: deployed.default } : {}),
        ...(deployed.public != null ? { public: deployed.public } : {}),
        ...(deployed.serverless != null ? { serverless: deployed.serverless } : {}),
        createTime: createdAt,
      },
      resolvedOutputs: {
        deployedModelName: deployed.name ?? "",
        model: deployed.model ?? "",
      },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapBatchJob(job: BatchInferenceJob, accountId: string): ResourceInstance {
    const id = lastSegment(job.name);
    const displayName = job.displayName || id;
    const createdAt = job.createTime ?? nowIso();
    const progress = job.jobProgress ?? {};
    const lifecycle = job.lifecycle ?? {};
    return {
      id: `${accountId}:batch-inference-job:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "batch-inference-job",
      accountId,
      displayName,
      fields: {
        displayName,
        jobId: id,
        ...(job.state ? { state: job.state } : {}),
        ...(job.status?.message ? { statusMessage: job.status.message } : {}),
        ...(job.model ? { model: job.model } : {}),
        ...(job.inputDatasetId ? { inputDatasetId: job.inputDatasetId } : {}),
        ...(job.outputDatasetId ? { outputDatasetId: job.outputDatasetId } : {}),
        ...(progress.percent != null ? { progressPercent: progress.percent } : {}),
        ...(progress.totalInputRequests != null
          ? { totalInputRequests: progress.totalInputRequests }
          : {}),
        ...(progress.successfullyProcessedRequests != null
          ? { successfullyProcessedRequests: progress.successfullyProcessedRequests }
          : {}),
        ...(progress.failedRequests != null ? { failedRequests: progress.failedRequests } : {}),
        ...(job.createdBy ? { createdBy: job.createdBy } : {}),
        createTime: createdAt,
        ...(lifecycle.runStartTime ? { runStartTime: lifecycle.runStartTime } : {}),
        ...(lifecycle.endTime ? { endTime: lifecycle.endTime } : {}),
        ...(job.expireTime ? { expireTime: job.expireTime } : {}),
      },
      resolvedOutputs: { jobName: job.name ?? "", outputDatasetId: job.outputDatasetId ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: lifecycle.endTime ?? createdAt,
    };
  }

  private mapFineTuningJob(job: SupervisedFineTuningJob, accountId: string): ResourceInstance {
    const id = lastSegment(job.name);
    const displayName = job.displayName || job.outputModel || id;
    const createdAt = job.createTime ?? nowIso();
    const progress = job.jobProgress ?? {};
    const cost = moneyToNumber(job.estimatedCost);
    return {
      id: `${accountId}:supervised-fine-tuning-job:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "supervised-fine-tuning-job",
      accountId,
      displayName,
      fields: {
        displayName,
        jobId: id,
        ...(job.state ? { state: job.state } : {}),
        ...(job.status?.message ? { statusMessage: job.status.message } : {}),
        ...(job.baseModel ? { baseModel: job.baseModel } : {}),
        ...(job.dataset ? { dataset: job.dataset } : {}),
        ...(job.evaluationDataset ? { evaluationDataset: job.evaluationDataset } : {}),
        ...(job.outputModel ? { outputModel: job.outputModel } : {}),
        ...(job.epochs != null ? { epochs: job.epochs } : {}),
        ...(job.learningRate != null ? { learningRate: job.learningRate } : {}),
        ...(job.loraRank != null ? { loraRank: job.loraRank } : {}),
        ...(job.batchSizeSamples != null ? { batchSizeSamples: job.batchSizeSamples } : {}),
        ...(progress.percent != null ? { progressPercent: progress.percent } : {}),
        ...(cost ? { estimatedCost: cost } : {}),
        ...(job.createdBy ? { createdBy: job.createdBy } : {}),
        createTime: createdAt,
        ...(job.completedTime ? { completedTime: job.completedTime } : {}),
      },
      resolvedOutputs: { jobName: job.name ?? "", outputModel: job.outputModel ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: job.completedTime ?? createdAt,
    };
  }

  private mapApiKey(key: ApiKey, accountId: string, userId: string): ResourceInstance {
    // The identifier is `keyId`; `gatewayApiKey` has no `name` field.
    const id = key.keyId ?? "";
    const displayName = key.displayName || id;
    const createdAt = key.createTime ?? nowIso();
    return {
      id: `${accountId}:api-key:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "api-key",
      accountId,
      displayName,
      fields: {
        displayName,
        keyId: id,
        userId,
        ...(key.email ? { email: key.email } : {}),
        ...(key.prefix ? { prefix: key.prefix } : {}),
        ...(key.secure != null ? { secure: key.secure } : {}),
        ...(key.expireTime ? { expireTime: key.expireTime } : {}),
        createTime: createdAt,
      },
      resolvedOutputs: { keyId: id, prefix: key.prefix ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapSecret(secret: Secret, accountId: string): ResourceInstance {
    const id = lastSegment(secret.name);
    const createdAt = nowIso();
    return {
      id: `${accountId}:secret:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "secret",
      accountId,
      displayName: secret.keyName || id,
      fields: { keyName: secret.keyName ?? id, secretId: id },
      resolvedOutputs: { secretName: secret.name ?? "", keyName: secret.keyName ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapQuota(quota: Quota, accountId: string): ResourceInstance {
    // The quota id is itself `{accelerator}-{region}`, e.g. `h100-us-iowa-1`.
    const id = lastSegment(quota.name);
    const createdAt = quota.updateTime ?? nowIso();
    const value = toNumber(quota.value);
    const maxValue = toNumber(quota.maxValue);
    return {
      id: `${accountId}:quota:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "quota",
      accountId,
      displayName: id,
      fields: {
        quotaId: id,
        ...(value != null ? { value } : {}),
        ...(maxValue != null ? { maxValue } : {}),
        ...(quota.usage != null ? { usage: quota.usage } : {}),
        ...(quota.updateTime ? { updateTime: quota.updateTime } : {}),
      },
      resolvedOutputs: { quotaId: id, quotaName: quota.name ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  private mapRouter(router: Router, accountId: string): ResourceInstance {
    const id = lastSegment(router.name);
    const displayName = router.displayName || id;
    const createdAt = router.createTime ?? nowIso();
    const strategy = router.evenLoad ? "evenLoad" : router.weightedRandom ? "weightedRandom" : "";
    return {
      id: `${accountId}:router:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "router",
      accountId,
      displayName,
      fields: {
        displayName,
        routerId: id,
        ...(router.state ? { state: router.state } : {}),
        ...(router.status?.message ? { statusMessage: router.status.message } : {}),
        ...(router.model ? { model: router.model } : {}),
        ...(router.deployments?.length ? { deployments: router.deployments.join(", ") } : {}),
        ...(strategy ? { strategy } : {}),
        ...(router.public != null ? { public: router.public } : {}),
        ...(router.aliases?.length ? { aliases: router.aliases.join(", ") } : {}),
        ...(router.autoGenerated != null ? { autoGenerated: router.autoGenerated } : {}),
        ...(router.createdBy ? { createdBy: router.createdBy } : {}),
        createTime: createdAt,
      },
      resolvedOutputs: { routerName: router.name ?? "", routerId: id },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: createdAt,
    };
  }

  /** Fields DPO and RFT jobs share through `trainingConfig` / `lossConfig`. */
  private trainingFields(job: DpoJob): Record<string, string | number> {
    const config = job.trainingConfig ?? {};
    const loss = job.lossConfig ?? {};
    return {
      ...(job.state ? { state: job.state } : {}),
      ...(job.status?.message ? { statusMessage: job.status.message } : {}),
      ...(config.baseModel ? { baseModel: config.baseModel } : {}),
      ...(job.dataset ? { dataset: job.dataset } : {}),
      ...(config.outputModel ? { outputModel: config.outputModel } : {}),
      ...(loss.method && loss.method !== "METHOD_UNSPECIFIED" ? { lossMethod: loss.method } : {}),
      ...(config.epochs != null ? { epochs: config.epochs } : {}),
      ...(config.learningRate != null ? { learningRate: config.learningRate } : {}),
      ...(config.loraRank != null ? { loraRank: config.loraRank } : {}),
      ...(config.batchSizeSamples != null ? { batchSizeSamples: config.batchSizeSamples } : {}),
      ...(job.wandbConfig?.url ? { wandbUrl: job.wandbConfig.url } : {}),
      ...(job.createdBy ? { createdBy: job.createdBy } : {}),
      ...(job.completedTime ? { completedTime: job.completedTime } : {}),
    };
  }

  private mapDpoJob(job: DpoJob, accountId: string): ResourceInstance {
    const id = lastSegment(job.name);
    const outputModel = job.trainingConfig?.outputModel ?? "";
    const displayName = job.displayName || outputModel || id;
    const createdAt = job.createTime ?? nowIso();
    return {
      id: `${accountId}:dpo-job:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "dpo-job",
      accountId,
      displayName,
      fields: {
        displayName,
        jobId: id,
        ...this.trainingFields(job),
        ...(job.lossConfig?.klBeta != null ? { klBeta: job.lossConfig.klBeta } : {}),
        createTime: createdAt,
      },
      resolvedOutputs: { jobName: job.name ?? "", outputModel },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: job.completedTime ?? createdAt,
    };
  }

  private mapRftJob(job: ReinforcementFineTuningJob, accountId: string): ResourceInstance {
    const id = lastSegment(job.name);
    const outputModel = job.trainingConfig?.outputModel ?? "";
    const displayName = job.displayName || outputModel || id;
    const createdAt = job.createTime ?? nowIso();
    const progress = job.jobProgress ?? {};
    return {
      id: `${accountId}:reinforcement-fine-tuning-job:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "reinforcement-fine-tuning-job",
      accountId,
      displayName,
      fields: {
        displayName,
        jobId: id,
        ...this.trainingFields(job),
        ...(job.evaluator ? { evaluator: job.evaluator } : {}),
        ...(job.evaluationDataset ? { evaluationDataset: job.evaluationDataset } : {}),
        ...(progress.percent != null ? { progressPercent: progress.percent } : {}),
        ...(progress.epoch != null ? { epoch: progress.epoch } : {}),
        ...(toNumber(progress.inputTokens) != null
          ? { inputTokens: toNumber(progress.inputTokens) as number }
          : {}),
        ...(toNumber(progress.outputTokens) != null
          ? { outputTokens: toNumber(progress.outputTokens) as number }
          : {}),
        ...(job.nodeCount != null ? { nodeCount: job.nodeCount } : {}),
        createTime: createdAt,
      },
      resolvedOutputs: { jobName: job.name ?? "", outputModel },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: job.completedTime ?? createdAt,
    };
  }

  private mapEvaluator(evaluator: Evaluator, accountId: string): ResourceInstance {
    const id = lastSegment(evaluator.name);
    const displayName = evaluator.displayName || id;
    const createdAt = evaluator.createTime ?? nowIso();
    const sourceType = evaluator.source?.type;
    return {
      id: `${accountId}:evaluator:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "evaluator",
      accountId,
      displayName,
      fields: {
        displayName,
        evaluatorId: id,
        ...(evaluator.description ? { description: evaluator.description } : {}),
        ...(evaluator.state ? { state: evaluator.state } : {}),
        ...(evaluator.status?.message ? { statusMessage: evaluator.status.message } : {}),
        ...(evaluator.defaultDataset ? { defaultDataset: evaluator.defaultDataset } : {}),
        ...(evaluator.entryPoint ? { entryPoint: evaluator.entryPoint } : {}),
        ...(sourceType && sourceType !== "TYPE_UNSPECIFIED"
          ? { sourceType: prettyEnum(sourceType, "TYPE_") }
          : {}),
        ...(evaluator.source?.githubRepositoryName
          ? { githubRepository: evaluator.source.githubRepositoryName }
          : {}),
        ...(evaluator.commitHash ? { commitHash: evaluator.commitHash } : {}),
        ...(evaluator.createdBy ? { createdBy: evaluator.createdBy } : {}),
        createTime: createdAt,
        ...(evaluator.updateTime ? { updateTime: evaluator.updateTime } : {}),
      },
      resolvedOutputs: { evaluatorName: evaluator.name ?? "", evaluatorId: id },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: evaluator.updateTime ?? createdAt,
    };
  }

  private mapEvaluationJob(job: EvaluationJob, accountId: string): ResourceInstance {
    const id = lastSegment(job.name);
    const displayName = job.displayName || id;
    const createdAt = job.createTime ?? nowIso();
    const metrics = job.metrics && Object.keys(job.metrics).length ? job.metrics : null;
    return {
      id: `${accountId}:evaluation-job:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "evaluation-job",
      accountId,
      displayName,
      fields: {
        displayName,
        jobId: id,
        ...(job.state ? { state: job.state } : {}),
        ...(job.status?.message ? { statusMessage: job.status.message } : {}),
        ...(job.evaluator ? { evaluator: job.evaluator } : {}),
        ...(job.inputDataset ? { inputDataset: job.inputDataset } : {}),
        ...(job.outputDataset ? { outputDataset: job.outputDataset } : {}),
        ...(metrics ? { metrics: JSON.stringify(metrics) } : {}),
        ...(job.createdBy ? { createdBy: job.createdBy } : {}),
        createTime: createdAt,
        ...(job.updateTime ? { updateTime: job.updateTime } : {}),
      },
      resolvedOutputs: { jobName: job.name ?? "", outputDataset: job.outputDataset ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: job.updateTime ?? createdAt,
    };
  }

  private mapUser(user: User, accountId: string): ResourceInstance {
    const id = lastSegment(user.name);
    const displayName = user.displayName || user.email || id;
    const createdAt = user.createTime ?? nowIso();
    return {
      id: `${accountId}:user:${id}`,
      pluginId: "fireworks",
      resourceTypeId: "user",
      accountId,
      displayName,
      fields: {
        displayName,
        userId: id,
        ...(user.email ? { email: user.email } : {}),
        ...(user.role ? { role: user.role } : {}),
        ...(user.permissionPreset ? { permissionPreset: user.permissionPreset } : {}),
        ...(user.serviceAccount != null ? { serviceAccount: user.serviceAccount } : {}),
        ...(user.state ? { state: user.state } : {}),
        createTime: createdAt,
        ...(user.updateTime ? { updateTime: user.updateTime } : {}),
      },
      resolvedOutputs: { userName: user.name ?? "", email: user.email ?? "" },
      secretStates: [],
      externalId: id,
      createdAt,
      updatedAt: user.updateTime ?? createdAt,
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
    const encoded = encodeURIComponent(externalId);
    switch (typeId) {
      case "deployment":
        return this.mapDeployment(
          await this.request<Deployment>(this.accountPath(`/deployments/${encoded}`)),
          accountId,
        );
      case "model":
        return this.mapModel(
          await this.request<Model>(this.accountPath(`/models/${encoded}`)),
          accountId,
        );
      case "dataset":
        return this.mapDataset(
          await this.request<Dataset>(this.accountPath(`/datasets/${encoded}`)),
          accountId,
        );
      case "deployed-model":
        return this.mapDeployedModel(
          await this.request<DeployedModel>(this.accountPath(`/deployedModels/${encoded}`)),
          accountId,
        );
      case "batch-inference-job":
        return this.mapBatchJob(
          await this.request<BatchInferenceJob>(this.accountPath(`/batchInferenceJobs/${encoded}`)),
          accountId,
        );
      case "supervised-fine-tuning-job":
        return this.mapFineTuningJob(
          await this.request<SupervisedFineTuningJob>(
            this.accountPath(`/supervisedFineTuningJobs/${encoded}`),
          ),
          accountId,
        );
      case "secret":
        return this.mapSecret(
          await this.request<Secret>(this.accountPath(`/secrets/${encoded}`)),
          accountId,
        );
      case "quota":
        return this.mapQuota(
          await this.request<Quota>(this.accountPath(`/quotas/${encoded}`)),
          accountId,
        );
      case "router":
        return this.mapRouter(
          await this.request<Router>(this.accountPath(`/routers/${encoded}`)),
          accountId,
        );
      case "dpo-job":
        return this.mapDpoJob(
          await this.request<DpoJob>(this.accountPath(`/dpoJobs/${encoded}`)),
          accountId,
        );
      case "reinforcement-fine-tuning-job":
        return this.mapRftJob(
          await this.request<ReinforcementFineTuningJob>(
            this.accountPath(`/reinforcementFineTuningJobs/${encoded}`),
          ),
          accountId,
        );
      case "evaluator":
        return this.mapEvaluator(
          await this.request<Evaluator>(this.accountPath(`/evaluators/${encoded}`)),
          accountId,
        );
      case "evaluation-job":
        return this.mapEvaluationJob(
          await this.request<EvaluationJob>(this.accountPath(`/evaluationJobs/${encoded}`)),
          accountId,
        );
      case "user":
        return this.mapUser(
          await this.request<User>(this.accountPath(`/users/${encoded}`)),
          accountId,
        );
      default: {
        // API keys have no published get-by-id route over HTTP (the generated
        // spec path for it is malformed) so we re-read the list instead.
        const all = await this.listResources(typeId, accountId);
        const found = all.find((resource) => resource.id === resourceId);
        if (!found) {
          throw new Error(`Fireworks plugin: resource ${typeId}/${externalId} not found`);
        }
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
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Fireworks plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "api-key":
        return this.getApiKeyCreateConfig();
      case "router":
        return this.getRouterCreateConfig();
      case "user":
        return getUserCreateConfig();
      case "secret":
        return getSecretCreateConfig();
      default:
        throw new Error(`Fireworks plugin: createResource not supported for type "${typeId}"`);
    }
  }

  /**
   * Router form: deployments come from a multi-select over the account's own
   * deployments (full resource names), and the optional `model` from the base
   * models those deployments serve, so nothing has to be typed from memory.
   */
  private async getRouterCreateConfig(): Promise<CreateResourceConfig> {
    const deployments = await this.paginate<"deployments", Deployment>(
      "/deployments",
      "deployments",
    ).catch((): Deployment[] => []);
    const deploymentOptions = deployments
      .filter((deployment) => Boolean(deployment.name) && deployment.state !== "DELETED")
      .map((deployment) => ({
        id: String(deployment.name),
        label: deployment.displayName || lastSegment(deployment.name),
        ...(deployment.baseModel ? { description: deployment.baseModel } : {}),
        ...(deployment.region ? { category: prettyEnum(deployment.region, "REGION_") } : {}),
      }));
    const models = [
      ...new Set(deployments.map((deployment) => deployment.baseModel ?? "").filter(Boolean)),
    ];

    return {
      fields: [
        {
          key: "routerId",
          label: "Router ID",
          kind: "text",
          required: true,
          placeholder: "my-router",
          description:
            "Lowercase letters, digits and hyphens. Becomes `accounts/<account>/routers/<id>`, the model string you call.",
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: false,
        },
        {
          key: "deployments",
          label: "Deployments",
          kind: "policy-picker",
          required: true,
          policies: deploymentOptions,
          description:
            deploymentOptions.length > 0
              ? "The deployments this router spreads traffic across."
              : "No deployments found in this account: create one first.",
        },
        {
          key: "model",
          label: "Model",
          kind: "select",
          required: false,
          options: [
            { id: "", label: "None (required for multi-region routers)" },
            ...models.map((model) => ({ id: model, label: model })),
          ],
          defaultValue: "",
          description:
            "Only for routers whose deployments all sit in one region. Leave empty when they span regions.",
        },
        {
          key: "strategy",
          label: "Routing Strategy",
          kind: "select",
          required: true,
          options: [
            { id: "weightedRandom", label: "Weighted random (by replica count)" },
            { id: "evenLoad", label: "Even load per replica" },
          ],
          defaultValue: "weightedRandom",
        },
        {
          key: "public",
          label: "Visibility",
          kind: "select",
          required: true,
          options: [
            { id: "false", label: "Private (this account only)" },
            { id: "true", label: "Public (any account can query it)" },
          ],
          defaultValue: "false",
        },
      ],
    };
  }

  private async getApiKeyCreateConfig(): Promise<CreateResourceConfig> {
    const users = await this.paginate<"users", User>("/users", "users").catch((): User[] => []);
    const options = users
      .filter((user) => Boolean(user.name))
      .map((user) => ({
        id: lastSegment(user.name),
        label: user.email
          ? `${user.displayName || lastSegment(user.name)} (${user.email})`
          : user.displayName || lastSegment(user.name),
      }));

    return {
      fields: [
        {
          key: "userId",
          label: "Owner",
          kind: "select",
          required: true,
          description: "The user (or service account) the new key belongs to.",
          options,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
          description: "How the key is labelled in the Fireworks dashboard.",
          placeholder: "ci-pipeline",
          defaultValue: "default",
        },
        {
          key: "expireTime",
          label: "Expires",
          kind: "datetime",
          required: false,
          description: "Leave blank for a key that never expires.",
        },
      ],
    };
  }

  /**
   * `POST /v1/accounts/{aid}/users/{uid}/apiKeys` with the key nested under an
   * `apiKey` wrapper. The response is the only time the plaintext `key` is ever
   * returned, so it is stashed as a warning for the host to surface.
   * https://docs.fireworks.ai/api-reference/create-api-key
   */
  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateResult> {
    switch (typeId) {
      case "api-key":
        return this.createApiKey(accountId, fields);
      case "router":
        return { resource: await this.createRouter(accountId, fields), warnings: [] };
      case "user":
        return { resource: await this.createUser(accountId, fields), warnings: [] };
      case "secret":
        return { resource: await this.createSecret(accountId, fields), warnings: [] };
      default:
        throw new Error(`Fireworks plugin: createResource not supported for type "${typeId}"`);
    }
  }

  /**
   * `POST /v1/accounts/{aid}/routers?routerId=…`. The strategy is a oneof of
   * two empty marker objects.
   * https://docs.fireworks.ai/api-reference/create-router
   */
  private async createRouter(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const routerId = (fields["routerId"] ?? "").trim();
    if (!routerId) throw new Error("Fireworks plugin: a router id is required");
    const deployments = parseIdList(fields["deployments"]);
    if (deployments.length === 0) {
      throw new Error("Fireworks plugin: pick at least one deployment for the router");
    }
    const body = {
      ...(fields["displayName"] ? { displayName: fields["displayName"] } : {}),
      deployments,
      ...(fields["model"] ? { model: fields["model"] } : {}),
      ...strategyBody(fields["strategy"]),
      public: fields["public"] === "true",
    };
    const created = await this.request<Router>(
      this.accountPath(`/routers?routerId=${encodeURIComponent(routerId)}`),
      { method: "POST", body: JSON.stringify(body) },
    );
    return this.mapRouter(created, accountId);
  }

  /**
   * `POST /v1/accounts/{aid}/users`. `role` is the only required field.
   * https://docs.fireworks.ai/api-reference/create-user
   */
  private async createUser(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const role = fields["role"] ?? "";
    if (!role) throw new Error("Fireworks plugin: a role is required to create a user");
    const serviceAccount = fields["kind"] === "service-account";
    const email = (fields["email"] ?? "").trim();
    if (!serviceAccount && !email) {
      throw new Error("Fireworks plugin: an email is required to invite a user");
    }
    const body = {
      role,
      ...(email ? { email } : {}),
      ...(fields["displayName"] ? { displayName: fields["displayName"] } : {}),
      ...(serviceAccount ? { serviceAccount: true } : {}),
      ...(role === "custom" && fields["permissionPreset"]
        ? { permissionPreset: fields["permissionPreset"] }
        : {}),
    };
    const created = await this.request<User>(this.accountPath("/users"), {
      method: "POST",
      body: JSON.stringify(body),
    });
    return this.mapUser(created, accountId);
  }

  /**
   * `POST /v1/accounts/{aid}/secrets`. Both `name` and `keyName` are
   * required; the id in `name` is derived from the key name so the user only
   * types the name jobs reference.
   * https://docs.fireworks.ai/api-reference/create-secret
   */
  private async createSecret(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const keyName = (fields["keyName"] ?? "").trim();
    const value = fields["value"] ?? "";
    if (!keyName) throw new Error("Fireworks plugin: a key name is required");
    if (!value) throw new Error("Fireworks plugin: a secret value is required");
    const secretId = secretIdFor(keyName);
    const created = await this.request<Secret>(this.accountPath("/secrets"), {
      method: "POST",
      body: JSON.stringify({
        name: `accounts/${this.accountId}/secrets/${secretId}`,
        keyName,
        value,
      }),
    });
    return this.mapSecret(
      { name: created?.name ?? `accounts/${this.accountId}/secrets/${secretId}`, keyName },
      accountId,
    );
  }

  private async createApiKey(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceCreateResult> {
    const userId = fields["userId"] ?? "";
    if (!userId) throw new Error("Fireworks plugin: an owner is required to create an API key");
    const body = {
      apiKey: {
        displayName: fields["displayName"] || "default",
        ...(fields["expireTime"] ? { expireTime: fields["expireTime"] } : {}),
      },
    };
    const created = await this.request<ApiKey>(
      this.accountPath(`/users/${encodeURIComponent(userId)}/apiKeys`),
      { method: "POST", body: JSON.stringify(body) },
    );
    const resource = this.mapApiKey(created, accountId, userId);
    return {
      resource,
      warnings: created.key
        ? [
            {
              code: "plaintext-key-shown-once",
              message: `Copy this key now. Fireworks never shows it again: ${created.key}`,
            },
          ]
        : [],
    };
  }

  /**
   * Scaling is a **colon-suffix RPC**, not normal PATCH semantics:
   * `PATCH /v1/accounts/{aid}/deployments/{id}:scale` with `{"replicaCount": N}`.
   * Everything else about a deployment goes through the ordinary PATCH.
   * https://docs.fireworks.ai/api-reference/scale-deployment
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "deployment":
        break;
      case "router":
      case "evaluator":
      case "user":
      case "quota":
        await this.patchSimple(typeId, resourceId, accountId, fields);
        return this.getResource(typeId, resourceId, accountId);
      default:
        throw new Error(`Fireworks plugin: updateResource not supported for type "${typeId}"`);
    }
    const id = encodeURIComponent(externalIdOf(resourceId));

    if (fields["replicaCount"] !== undefined) {
      const replicaCount = Number.parseInt(fields["replicaCount"], 10);
      if (!Number.isFinite(replicaCount) || replicaCount < 0) {
        throw new Error("Fireworks plugin: replicaCount must be a non-negative integer");
      }
      // Note the `:scale` suffix: this is a custom method, so it does NOT
      // merge with the patch body below and must be sent on its own.
      await this.request<unknown>(this.accountPath(`/deployments/${id}:scale`), {
        method: "PATCH",
        body: JSON.stringify({ replicaCount }),
      });
    }

    const patch: Record<string, unknown> = {};
    if (fields["displayName"]) patch["displayName"] = fields["displayName"];
    if (fields["minReplicaCount"] !== undefined) {
      patch["minReplicaCount"] = Number.parseInt(fields["minReplicaCount"], 10);
    }
    if (fields["maxReplicaCount"] !== undefined) {
      patch["maxReplicaCount"] = Number.parseInt(fields["maxReplicaCount"], 10);
    }
    if (Object.keys(patch).length) {
      await this.request<unknown>(this.accountPath(`/deployments/${id}`), {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    }

    return this.getResource(typeId, resourceId, accountId);
  }

  /**
   * Ordinary PATCHes for routers, evaluators, users and quotas. Each body
   * carries only the fields the user changed.
   * https://docs.fireworks.ai/api-reference/update-router
   * https://docs.fireworks.ai/api-reference/update-evaluator
   * https://docs.fireworks.ai/api-reference/update-user
   * https://docs.fireworks.ai/api-reference/update-quota
   */
  private async patchSimple(
    typeId: "router" | "evaluator" | "user" | "quota",
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);
    const encoded = encodeURIComponent(externalId);
    const patch: Record<string, unknown> = {};
    let path = "";

    switch (typeId) {
      case "router": {
        const current = await this.getResource(typeId, resourceId, accountId);
        if (current.fields["autoGenerated"] === true) {
          throw new Error(
            "Fireworks plugin: this router was generated by Fireworks for a deployment and cannot be edited",
          );
        }
        // `router.name` must be populated on update.
        patch["name"] = `accounts/${this.accountId}/routers/${externalId}`;
        if (fields["displayName"] !== undefined) patch["displayName"] = fields["displayName"];
        if (fields["public"] !== undefined) patch["public"] = fields["public"] === "true";
        if (fields["strategy"]) Object.assign(patch, strategyBody(fields["strategy"]));
        path = `/routers/${encoded}`;
        break;
      }
      case "evaluator":
        if (fields["displayName"] !== undefined) patch["displayName"] = fields["displayName"];
        if (fields["description"] !== undefined) patch["description"] = fields["description"];
        path = `/evaluators/${encoded}`;
        break;
      case "user":
        if (fields["displayName"] !== undefined) patch["displayName"] = fields["displayName"];
        if (fields["role"]) patch["role"] = fields["role"];
        if (fields["permissionPreset"] !== undefined) {
          patch["permissionPreset"] = fields["permissionPreset"];
        }
        path = `/users/${encoded}`;
        break;
      case "quota": {
        if (fields["value"] === undefined) return;
        const value = Number.parseInt(fields["value"], 10);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error("Fireworks plugin: the enforced limit must be a non-negative integer");
        }
        // int64 travels as a JSON string.
        patch["value"] = String(value);
        path = `/quotas/${encoded}`;
        break;
      }
    }

    if (
      Object.keys(patch).length === 0 ||
      (typeId === "router" && Object.keys(patch).length === 1)
    ) {
      return;
    }
    await this.request<unknown>(this.accountPath(path), {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    if (!externalId) throw new Error(`Fireworks plugin: cannot parse resource id "${resourceId}"`);
    const encoded = encodeURIComponent(externalId);
    switch (typeId) {
      case "deployment":
        await this.request<unknown>(this.accountPath(`/deployments/${encoded}`), {
          method: "DELETE",
        });
        return;
      case "model":
        await this.request<unknown>(this.accountPath(`/models/${encoded}`), { method: "DELETE" });
        return;
      case "dataset":
        await this.request<unknown>(this.accountPath(`/datasets/${encoded}`), { method: "DELETE" });
        return;
      case "deployed-model":
        await this.request<unknown>(this.accountPath(`/deployedModels/${encoded}`), {
          method: "DELETE",
        });
        return;
      case "secret":
        await this.request<unknown>(this.accountPath(`/secrets/${encoded}`), { method: "DELETE" });
        return;
      case "batch-inference-job":
        await this.request<unknown>(this.accountPath(`/batchInferenceJobs/${encoded}`), {
          method: "DELETE",
        });
        return;
      case "supervised-fine-tuning-job":
        await this.request<unknown>(this.accountPath(`/supervisedFineTuningJobs/${encoded}`), {
          method: "DELETE",
        });
        return;
      case "router": {
        const current = await this.getResource(typeId, resourceId, _accountId).catch(
          (): ResourceInstance | null => null,
        );
        if (current?.fields["autoGenerated"] === true) {
          throw new Error(
            "Fireworks plugin: this router was generated by Fireworks for a deployment and is removed with it",
          );
        }
        await this.request<unknown>(this.accountPath(`/routers/${encoded}`), { method: "DELETE" });
        return;
      }
      case "dpo-job":
        await this.request<unknown>(this.accountPath(`/dpoJobs/${encoded}`), { method: "DELETE" });
        return;
      case "reinforcement-fine-tuning-job":
        await this.request<unknown>(this.accountPath(`/reinforcementFineTuningJobs/${encoded}`), {
          method: "DELETE",
        });
        return;
      case "evaluator":
        await this.request<unknown>(this.accountPath(`/evaluators/${encoded}`), {
          method: "DELETE",
        });
        return;
      case "evaluation-job":
        await this.request<unknown>(this.accountPath(`/evaluationJobs/${encoded}`), {
          method: "DELETE",
        });
        return;
      case "api-key": {
        // Deletion is a POST custom verb keyed on `keyId`, not an HTTP DELETE.
        const resource = await this.getResource(typeId, resourceId, _accountId).catch(
          (): ResourceInstance | null => null,
        );
        const userId = String(resource?.fields["userId"] ?? "-");
        await this.request<unknown>(
          this.accountPath(`/users/${encodeURIComponent(userId)}/apiKeys:delete`),
          { method: "POST", body: JSON.stringify({ keyId: externalId }) },
        );
        return;
      }
      default:
        throw new Error(`Fireworks plugin: deleteResource not supported for type "${typeId}"`);
    }
  }

  /**
   * `POST .../supervisedFineTuningJobs/{id}:cancel` and `:resume`,
   * `POST .../reinforcementFineTuningJobs/{id}:cancel` and `:resume`,
   * `POST .../dpoJobs/{id}:resume` (DPO has no cancel), and
   * `POST .../deployments/{id}:undelete`.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const encoded = encodeURIComponent(externalIdOf(resourceId));
    if (
      typeId === "supervised-fine-tuning-job" &&
      (actionId === "cancel" || actionId === "resume")
    ) {
      await this.request<unknown>(
        this.accountPath(`/supervisedFineTuningJobs/${encoded}:${actionId}`),
        { method: "POST" },
      );
      return;
    }
    if (
      typeId === "reinforcement-fine-tuning-job" &&
      (actionId === "cancel" || actionId === "resume")
    ) {
      await this.request<unknown>(
        this.accountPath(`/reinforcementFineTuningJobs/${encoded}:${actionId}`),
        { method: "POST" },
      );
      return;
    }
    if (typeId === "dpo-job" && actionId === "resume") {
      await this.request<unknown>(this.accountPath(`/dpoJobs/${encoded}:resume`), {
        method: "POST",
      });
      return;
    }
    if (typeId === "deployment" && actionId === "undelete") {
      await this.request<unknown>(this.accountPath(`/deployments/${encoded}:undelete`), {
        method: "POST",
      });
      return;
    }
    throw new Error(`Fireworks plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Costs and metrics
  // -------------------------------------------------------------------------

  /**
   * `POST /v1/accounts/{aid}/usageCosts:query`, grouped by DAY + MODEL (the
   * documented maximum is two dimensions, and HOUR/DAY are mutually exclusive).
   *
   * ⚠️ Do **not** use `billingUsage.costNanoUsd` for this: it is nano-USD but
   * the spec states it is "0 when absent (not free)" and only one upstream
   * currently stamps an authoritative cost, so it reads as near-zero spend.
   * `usageCosts:query` returns google.type.Money: real dollars.
   * https://docs.fireworks.ai/api-reference/query-usage-costs
   */
  async fetchCostData(accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    // Normalized AI dimensions (`ai:provider`, and `ai:model` /
    // `ai:token_type` where the billing API says), so request logs can be
    // reconciled against this bill. See plugin-base `ai-requests.ts`.
    return withAiCostTags(await this.fetchUntaggedCostRows(accountId, range), (row) => {
      return { provider: "fireworks", model: row.service || undefined };
    });
  }

  private async fetchUntaggedCostRows(
    _accountId: string,
    range: CostFetchRange,
  ): Promise<CostRow[]> {
    const rows: CostRow[] = [];
    // ACCOUNT scope needs account-admin rights; SELF works for any principal
    // but only covers that user's own spend. Try the fuller one first.
    let scope: "ACCOUNT" | "SELF" = "ACCOUNT";
    let attempted = false;

    for (
      let windowStart = range.fromDate;
      windowStart <= range.toDate;
      windowStart = addDays(windowStart, MAX_USAGE_WINDOW_DAYS)
    ) {
      const windowEndExclusive = minDate(
        addDays(windowStart, MAX_USAGE_WINDOW_DAYS),
        addDays(range.toDate, 1),
      );
      let pageToken: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const body = {
          startTime: `${windowStart}T00:00:00Z`,
          endTime: `${windowEndExclusive}T00:00:00Z`,
          scope,
          groupBy: ["DAY", "MODEL"],
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
        };
        let data: UsageCostsResponse;
        try {
          data = await this.request<UsageCostsResponse>(this.accountPath("/usageCosts:query"), {
            method: "POST",
            body: JSON.stringify(body),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!attempted && scope === "ACCOUNT" && /40[13]/.test(message)) {
            // Not an account admin: fall back to this principal's own spend
            // rather than reporting nothing.
            scope = "SELF";
            attempted = true;
            page -= 1;
            continue;
          }
          if (/40[13]/.test(message)) {
            throw new CostSetupError(
              "Fireworks refused the usage-cost query for this API key. Querying account-wide costs requires an account-administrator key; a plain inference key can only read its own usage.",
              { label: "Fireworks billing", url: "https://app.fireworks.ai/settings/billing" },
            );
          }
          throw error;
        }
        attempted = true;

        for (const row of data.rows ?? []) {
          const date = isoDate(row.dimensions?.startTime) || windowStart;
          const amount = moneyToNumber(row.subtotal);
          if (!amount) continue;
          const model = row.dimensions?.model;
          rows.push({
            date,
            ...(model ? { service: lastSegment(model) || model } : {}),
            currency: row.subtotal?.currencyCode || "USD",
            amount,
          });
        }
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
    }

    return rows;
  }

  /**
   * `GET /v1/accounts/{aid}/billingUsage`: daily buckets, split into
   * `serverlessCosts` / `dedicatedCosts` / `trainingCosts`. Used here for
   * consumption series (tokens, accelerator-seconds), not for money.
   * https://docs.fireworks.ai/api-reference/get-billing-usage
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const externalId = externalIdOf(resourceId);
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 14 * 24 * 60 * 60 * 1000;
    const start = new Date(startMs).toISOString().slice(0, 10);
    const end = new Date(endMs).toISOString().slice(0, 10);
    // The window is capped at 31 days by the API.
    const clampedStart = maxDate(start, addDays(end, -MAX_USAGE_WINDOW_DAYS + 1));

    const usageType = resourceTypeId === "deployment" ? "DEDICATED_DEPLOYMENT" : "SERVERLESS";
    const groupBy = resourceTypeId === "deployment" ? "deployment_name" : "model_name";
    const query =
      `?startTime=${clampedStart}T00:00:00Z&endTime=${addDays(end, 1)}T00:00:00Z` +
      `&usageType=${usageType}&groupBy=${groupBy}`;

    const data = await this.request<BillingUsageResponse>(
      this.accountPath(`/billingUsage${query}`),
    ).catch((): BillingUsageResponse => ({}));

    if (resourceTypeId === "deployment") {
      const points = (data.dedicatedCosts ?? [])
        .filter(
          (row) =>
            !row.deploymentId ||
            row.deploymentId === externalId ||
            lastSegment(row.deploymentId) === externalId,
        )
        .map((row) => ({
          timestamp: Date.parse(row.startTime ?? "") || startMs,
          value: toNumber(row.acceleratorSeconds) ?? 0,
        }))
        .filter((point) => Number.isFinite(point.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);
      return points.length ? [{ label: "Accelerator Seconds", unit: "seconds", points }] : [];
    }

    const rows = (data.serverlessCosts ?? []).filter((row) => {
      const model = row.modelName ?? row.group?.["model_name"] ?? "";
      return !model || lastSegment(model) === externalId || model === externalId;
    });
    const prompt = rows
      .map((row) => ({
        timestamp: Date.parse(row.startTime ?? "") || startMs,
        value: toNumber(row.promptTokens) ?? 0,
      }))
      .filter((point) => Number.isFinite(point.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);
    const completion = rows
      .map((row) => ({
        timestamp: Date.parse(row.startTime ?? "") || startMs,
        value: toNumber(row.completionTokens) ?? 0,
      }))
      .filter((point) => Number.isFinite(point.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);

    const series: MetricSeries[] = [];
    if (prompt.length) series.push({ label: "Prompt Tokens", unit: "tokens", points: prompt });
    if (completion.length) {
      series.push({ label: "Completion Tokens", unit: "tokens", points: completion });
    }
    return series;
  }

  // -------------------------------------------------------------------------
  // Logs and live metrics
  // -------------------------------------------------------------------------

  /**
   * Logs tabs:
   * - evaluation jobs: the execution log, via a short-lived signed URL from
   *   `GET …/evaluationJobs/{id}:getExecutionLogEndpoint`
   * - evaluators: the build log, via `GET …/evaluators/{id}:getBuildLogEndpoint`
   * - deployments and users: the account audit log (`GET …/auditLogs`),
   *   filtered to the deployment's resource name or the user's email
   * https://docs.fireworks.ai/api-reference/get-evaluation-job-log-endpoint
   * https://docs.fireworks.ai/api-reference/get-evaluator-build-log-endpoint
   * https://docs.fireworks.ai/api-reference/list-audit-logs
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const id = encodeURIComponent(externalIdOf(resourceId));
    const tail = params.tailLines && params.tailLines > 0 ? params.tailLines : 500;
    let lines: string[];
    switch (typeId) {
      case "evaluation-job": {
        const res = await this.request<{ executionLogSignedUri?: string }>(
          this.accountPath(`/evaluationJobs/${id}:getExecutionLogEndpoint`),
        );
        lines = res.executionLogSignedUri
          ? splitLines(await this.fetchText(res.executionLogSignedUri))
          : ["No execution log yet: the job has not started writing one."];
        break;
      }
      case "evaluator": {
        const res = await this.request<{ buildLogSignedUri?: string }>(
          this.accountPath(`/evaluators/${id}:getBuildLogEndpoint`),
        );
        lines = res.buildLogSignedUri
          ? splitLines(await this.fetchText(res.buildLogSignedUri))
          : ["No build log yet."];
        break;
      }
      case "deployment":
        lines = await this.auditLogLines(
          `resource:"deployments/${externalIdOf(resourceId)}"`,
          tail,
        );
        break;
      case "user": {
        const user = await this.getResource("user", resourceId, accountId);
        const email = String(user.fields["email"] ?? "");
        lines = email
          ? await this.auditLogLines(`email=${JSON.stringify(email)}`, tail)
          : ["This user has no email address, which is what the audit log is keyed by."];
        break;
      }
      default:
        throw new Error(`Fireworks plugin: logs not supported for type "${typeId}"`);
    }
    return {
      text: lines
        .slice(-tail)
        .map((line) => `${line}\n`)
        .join(""),
      containers: [],
      activeContainer: "",
    };
  }

  /**
   * Audit log entries matching an AIP-160 filter, oldest first. Pages can come
   * back empty with a `nextPageToken` while the scan catches up, so the walk
   * stops on the entry count or the page cap, never on a short page.
   */
  private async auditLogLines(filter: string, want: number): Promise<string[]> {
    const entries: AuditLogEntry[] = [];
    let pageToken: string | undefined;
    try {
      for (let page = 0; page < 10 && entries.length < want; page += 1) {
        const qs = new URLSearchParams({ pageSize: "200", filter });
        if (pageToken) qs.set("pageToken", pageToken);
        const data = await this.request<{ auditLogs?: AuditLogEntry[]; nextPageToken?: string }>(
          this.accountPath(`/auditLogs?${qs.toString()}`),
        );
        entries.push(...(data.auditLogs ?? []));
        if (!data.nextPageToken) break;
        pageToken = data.nextPageToken;
      }
    } catch (err) {
      if (/API error 403\b/.test(String((err as Error).message))) {
        return [
          "Fireworks refused the audit log request. Audit logs are only available on Enterprise accounts.",
        ];
      }
      throw err;
    }
    if (entries.length === 0) return ["No audit log entries in the last 30 days."];
    // Newest first on the wire; logs read oldest first.
    return entries.slice(0, want).reverse().map(formatAuditLogEntry);
  }

  /**
   * A deployment's current performance from the account's Prometheus
   * endpoint (`GET /v1/accounts/{id}/metrics`), stashed for `renderDetail`.
   * The endpoint serves pre-aggregated one-minute rates, not history, and is
   * limited to 6 requests a minute per account, so it is read once per detail
   * view and any failure (429, no dedicated traffic) just omits the section.
   * https://docs.fireworks.ai/deployments/exporting-metrics
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "deployment") return resource;
    const deploymentId = resource.externalId ?? externalIdOf(resource.id);
    let text: string;
    try {
      text = await this.fetchText(this.accountPath("/metrics"));
    } catch {
      return resource;
    }
    const samples = parsePromText(text).filter((s) => s.labels["deployment_id"] === deploymentId);
    const live = liveDeploymentMetrics(samples);
    if (!live) return resource;
    return {
      ...resource,
      resolvedOutputs: { ...resource.resolvedOutputs, __live__: JSON.stringify(live) },
    };
  }

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
      case "deployment": {
        const mapped = mapDeploymentState(String(fields["state"] ?? ""));
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
          value: `${fields["replicaCount"] ?? 0} / ${fields["maxReplicaCount"] ?? "—"}`,
        });
        if (fields["acceleratorType"]) {
          stats.push({
            label: "Accelerator",
            value: prettyEnum(String(fields["acceleratorType"]), "ACCELERATOR_TYPE_"),
          });
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
        if (fields["kind"]) {
          stats.push({ label: "Kind", value: prettyEnum(String(fields["kind"]), "KIND_") });
        }
        if (fields["parameterCount"]) {
          stats.push({ label: "Parameters", value: String(fields["parameterCount"]) });
        }
        break;
      }
      case "dataset": {
        if (fields["exampleCount"] != null) {
          stats.push({ label: "Examples", value: formatNumber(Number(fields["exampleCount"])) });
        }
        if (fields["state"]) {
          const mapped = mapReadyState(String(fields["state"]));
          stats.push({
            label: "State",
            value: mapped.label,
            variant: mapped.status === "healthy" ? "status-healthy" : "default",
          });
        }
        break;
      }
      case "batch-inference-job":
      case "supervised-fine-tuning-job":
      case "dpo-job":
      case "reinforcement-fine-tuning-job":
      case "evaluation-job": {
        const mapped = mapJobState(String(fields["state"] ?? ""));
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
        if (fields["progressPercent"] != null) {
          stats.push({
            label: "Progress",
            value: `${Number(fields["progressPercent"]).toFixed(0)}%`,
          });
        }
        if (fields["estimatedCost"] != null) {
          stats.push({
            label: "Estimated Cost",
            value: `$${Number(fields["estimatedCost"]).toFixed(2)}`,
          });
        }
        break;
      }
      case "router": {
        const mapped = mapDeploymentState(String(fields["state"] ?? ""));
        stats.push({ label: "State", value: mapped.label });
        const count = String(fields["deployments"] ?? "")
          .split(",")
          .filter((value) => value.trim()).length;
        stats.push({ label: "Deployments", value: String(count) });
        break;
      }
      case "evaluator": {
        const mapped = mapEvaluatorState(String(fields["state"] ?? ""));
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
        break;
      }
      case "user": {
        if (fields["role"]) stats.push({ label: "Role", value: String(fields["role"]) });
        break;
      }
      case "quota": {
        const used = Number(fields["usage"] ?? 0);
        const limit = Number(fields["value"] ?? 0);
        stats.push({
          label: "In Use",
          value: `${used} / ${limit}`,
          variant: limit > 0 && used / limit >= 0.9 ? "status-degraded" : "default",
        });
        break;
      }
      default:
        break;
    }
    return stats;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "deployment":
        return this.renderDeploymentDetail(resource);
      case "model":
        return this.renderModelDetail(resource);
      case "dataset":
        return this.renderDatasetDetail(resource);
      case "deployed-model":
        return this.renderDeployedModelDetail(resource);
      case "batch-inference-job":
        return this.renderBatchJobDetail(resource);
      case "supervised-fine-tuning-job":
        return this.renderFineTuningJobDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      case "secret":
        return this.renderSecretDetail(resource);
      case "quota":
        return this.renderQuotaDetail(resource);
      case "router":
        return this.renderRouterDetail(resource);
      case "dpo-job":
      case "reinforcement-fine-tuning-job":
        return this.renderTrainingJobDetail(resource);
      case "evaluator":
        return this.renderEvaluatorDetail(resource);
      case "evaluation-job":
        return this.renderEvaluationJobDetail(resource);
      case "user":
        return this.renderUserDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const fields = resource.fields;
    const state = String(fields["state"] ?? "");
    switch (resource.resourceTypeId) {
      case "deployment": {
        const mapped = mapDeploymentState(state);
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "batch-inference-job":
      case "supervised-fine-tuning-job":
      case "dpo-job":
      case "reinforcement-fine-tuning-job":
      case "evaluation-job": {
        const mapped = mapJobState(state);
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "router":
      case "user": {
        const mapped = mapDeploymentState(state);
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "evaluator": {
        const mapped = mapEvaluatorState(state);
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: mapped.status, label: mapped.label },
        };
      }
      case "model":
      case "dataset":
      case "deployed-model": {
        const mapped = mapReadyState(state);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: mapped.status,
            ...(mapped.label ? { label: mapped.label } : {}),
          },
        };
      }
      case "quota": {
        const used = Number(fields["usage"] ?? 0);
        const limit = Number(fields["value"] ?? 0);
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: limit > 0 && used / limit >= 0.9 ? "degraded" : "info",
            label: `${used} / ${limit}`,
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

  private renderDeploymentDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapDeploymentState(String(fields["state"] ?? ""));
    const modelString = String(resource.resolvedOutputs["baseModel"] ?? fields["baseModel"] ?? "");
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Deployment",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Deployment ID", value: String(fields["deploymentId"] ?? ""), copyable: true },
              { key: "State", value: mapped.label },
              ...(fields["statusMessage"]
                ? [{ key: "Status", value: String(fields["statusMessage"]) }]
                : []),
              ...(modelString ? [{ key: "Base Model", value: modelString, copyable: true }] : []),
              ...(fields["acceleratorType"]
                ? [
                    {
                      key: "Accelerator",
                      value: `${fields["acceleratorCount"] ?? 1}× ${prettyEnum(String(fields["acceleratorType"]), "ACCELERATOR_TYPE_")}`,
                    },
                  ]
                : []),
              ...(fields["precision"]
                ? [{ key: "Precision", value: prettyEnum(String(fields["precision"])) }]
                : []),
              ...(fields["region"]
                ? [{ key: "Region", value: prettyEnum(String(fields["region"]), "REGION_") }]
                : []),
              ...(fields["createTime"]
                ? [{ key: "Created", value: String(fields["createTime"]) }]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Replicas",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Running", value: String(fields["replicaCount"] ?? 0) },
              ...(fields["readyReplicaCount"] != null
                ? [{ key: "Ready", value: String(fields["readyReplicaCount"]) }]
                : []),
              ...(fields["desiredReplicaCount"] != null
                ? [{ key: "Desired", value: String(fields["desiredReplicaCount"]) }]
                : []),
              { key: "Min", value: String(fields["minReplicaCount"] ?? 0) },
              { key: "Max", value: String(fields["maxReplicaCount"] ?? "—") },
              ...(fields["scaleToZeroWindow"]
                ? [{ key: "Scale-to-zero After", value: String(fields["scaleToZeroWindow"]) }]
                : []),
            ],
          },
          {
            kind: "text",
            // Worth spelling out: this is not ordinary PATCH semantics.
            content:
              "Scaling goes through a dedicated RPC (`PATCH …/deployments/{id}:scale`), separate from editing the min/max window. Editing this resource sends whichever of the two the changed fields imply.",
            variant: "muted",
          },
        ],
      },
    ];

    if (modelString) {
      sections.push({
        kind: "section",
        title: "Calling this deployment",
        children: [
          {
            kind: "text",
            content: `POST ${INFERENCE_BASE}/chat/completions  {"model": "${modelString}"}`,
            variant: "mono",
            copyable: true,
          },
          {
            kind: "text",
            content:
              "Inference and control-plane calls share one API key but use different base URLs. The account id goes in the model string for inference and in the path for the control plane.",
            variant: "muted",
          },
        ],
      });
    }

    sections.splice(1, 0, ...this.renderLiveSection(resource));

    return {
      logs: { defaultTailLines: 200 },
      title: resource.displayName,
      subtitle: `Deployment · ${modelString}`,
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      metricsCapability: { defaultTimeRangeMs: 14 * 24 * 60 * 60 * 1000 },
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  /** The Prometheus snapshot stashed by `enrichDetail`; nothing if it failed. */
  private renderLiveSection(resource: ResourceInstance): SectionNode[] {
    const raw = resource.resolvedOutputs["__live__"];
    if (!raw) return [];
    let live: LiveDeploymentMetrics;
    try {
      live = JSON.parse(raw) as LiveDeploymentMetrics;
    } catch {
      return [];
    }
    const rate = (v: number | undefined, unit: string) =>
      v === undefined
        ? ""
        : `${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US")} ${unit}`;
    const ms = (v: number | undefined) =>
      v === undefined ? "" : `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString("en-US")} ms`;
    const pct = (v: number | undefined) => (v === undefined ? "" : `${v.toFixed(1)}%`);
    const pair = (a: number | undefined, b: number | undefined) =>
      a === undefined && b === undefined ? "" : `${ms(a) || "–"} / ${ms(b) || "–"}`;
    const items = [
      { key: "Requests", value: rate(live.requestsPerSec, "req/s") },
      { key: "Errors", value: rate(live.errorsPerSec, "req/s") },
      { key: "Prompt Tokens", value: rate(live.promptTokensPerSec, "tokens/s") },
      { key: "Cached Prompt Share", value: pct(live.cachedPromptPct) },
      { key: "Time to First Token p50 / p99", value: pair(live.ttftP50, live.ttftP99) },
      { key: "End-to-end Latency p50 / p99", value: pair(live.e2eP50, live.e2eP99) },
      { key: "Per-token Generation p50", value: ms(live.perTokenP50) },
      { key: "Generation Queue p50", value: ms(live.generationQueueP50) },
      { key: "Prefill p50", value: ms(live.prefillP50) },
      { key: "Prefill Queue p50", value: ms(live.prefillQueueP50) },
      {
        key: "Concurrent Requests",
        value: live.concurrentRequests === undefined ? "" : live.concurrentRequests.toFixed(1),
      },
      { key: "KV Cache Blocks in Use", value: pct(live.kvBlocksPct) },
      { key: "KV Cache Slots in Use", value: pct(live.kvSlotsPct) },
    ].filter((item) => item.value);
    if (items.length === 0) return [];
    return [
      {
        kind: "section",
        title: "Live performance",
        children: [
          { kind: "key-value-list", items },
          {
            kind: "text",
            variant: "muted",
            content:
              "One-minute rates and percentiles from Fireworks' Prometheus metrics endpoint, read when this page opened. Fireworks serves only the current window, not history; scrape the same endpoint into your own Prometheus or Grafana for charts.",
          },
        ],
      },
    ];
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapReadyState(String(fields["state"] ?? ""));
    const modelName = String(resource.resolvedOutputs["modelName"] ?? "");
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(modelName
                ? [{ key: "Model String", value: modelName, copyable: true }]
                : [{ key: "Model ID", value: String(fields["modelId"] ?? ""), copyable: true }]),
              ...(fields["kind"]
                ? [{ key: "Kind", value: prettyEnum(String(fields["kind"]), "KIND_") }]
                : []),
              { key: "State", value: mapped.label },
              ...(fields["description"]
                ? [{ key: "Description", value: String(fields["description"]) }]
                : []),
              ...(fields["contextLength"] != null
                ? [
                    {
                      key: "Context Length",
                      value: `${formatNumber(Number(fields["contextLength"]))} tokens`,
                    },
                  ]
                : []),
              ...(fields["parameterCount"]
                ? [{ key: "Parameters", value: String(fields["parameterCount"]) }]
                : []),
              ...(fields["deprecationDate"]
                ? [{ key: "Deprecation Date", value: String(fields["deprecationDate"]) }]
                : []),
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
              { key: "Serverless", value: fields["supportsServerless"] ? "Yes" : "No" },
              { key: "LoRA Add-ons", value: fields["supportsLora"] ? "Yes" : "No" },
              { key: "Image Input", value: fields["supportsImageInput"] ? "Yes" : "No" },
              { key: "Tool Calling", value: fields["supportsTools"] ? "Yes" : "No" },
              { key: "Public", value: fields["public"] ? "Yes" : "No" },
            ],
          },
        ],
      },
    ];

    const links: SchemaNode[] = [];
    if (fields["huggingFaceUrl"]) {
      links.push({ kind: "link", label: "Hugging Face", url: String(fields["huggingFaceUrl"]) });
    }
    if (fields["githubUrl"]) {
      links.push({ kind: "link", label: "GitHub", url: String(fields["githubUrl"]) });
    }
    if (links.length) sections.push({ kind: "section", title: "Links", children: links });

    return {
      title: resource.displayName,
      subtitle: "Model",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      metricsCapability: { defaultTimeRangeMs: 14 * 24 * 60 * 60 * 1000 },
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDatasetDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapReadyState(String(fields["state"] ?? ""));
    return {
      title: resource.displayName,
      subtitle: "Dataset",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Dataset",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Dataset ID", value: String(fields["datasetId"] ?? ""), copyable: true },
                { key: "State", value: mapped.label },
                ...(fields["statusMessage"]
                  ? [{ key: "Status", value: String(fields["statusMessage"]) }]
                  : []),
                ...(fields["format"]
                  ? [{ key: "Format", value: prettyEnum(String(fields["format"]), "FORMAT_") }]
                  : []),
                ...(fields["source"] ? [{ key: "Source", value: String(fields["source"]) }] : []),
                ...(fields["exampleCount"] != null
                  ? [{ key: "Examples", value: formatNumber(Number(fields["exampleCount"])) }]
                  : []),
                ...(fields["estimatedTokenCount"] != null
                  ? [
                      {
                        key: "Estimated Tokens",
                        value: formatNumber(Number(fields["estimatedTokenCount"])),
                      },
                    ]
                  : []),
                ...(fields["averageTurnCount"] != null
                  ? [{ key: "Average Turns", value: String(fields["averageTurnCount"]) }]
                  : []),
                ...(fields["createdBy"]
                  ? [{ key: "Created By", value: String(fields["createdBy"]) }]
                  : []),
                ...(fields["createTime"]
                  ? [{ key: "Created", value: String(fields["createTime"]) }]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderDeployedModelDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapReadyState(String(fields["state"] ?? ""));
    return {
      title: resource.displayName,
      subtitle: "Deployed model (LoRA add-on)",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Deployed Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Deployed Model ID",
                  value: String(fields["deployedModelId"] ?? ""),
                  copyable: true,
                },
                { key: "State", value: mapped.label },
                ...(fields["model"]
                  ? [{ key: "Model", value: String(fields["model"]), copyable: true }]
                  : []),
                ...(fields["deployment"]
                  ? [{ key: "Deployment", value: String(fields["deployment"]) }]
                  : []),
                { key: "Default", value: fields["isDefault"] ? "Yes" : "No" },
                { key: "Public", value: fields["public"] ? "Yes" : "No" },
                { key: "Fireworks-managed", value: fields["serverless"] ? "Yes" : "No" },
                ...(fields["createTime"]
                  ? [{ key: "Created", value: String(fields["createTime"]) }]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderBatchJobDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapJobState(String(fields["state"] ?? ""));
    return {
      title: resource.displayName,
      subtitle: "Batch inference job",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Job",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Job ID", value: String(fields["jobId"] ?? ""), copyable: true },
                { key: "State", value: mapped.label },
                ...(fields["statusMessage"]
                  ? [{ key: "Status", value: String(fields["statusMessage"]) }]
                  : []),
                ...(fields["model"] ? [{ key: "Model", value: String(fields["model"]) }] : []),
                ...(fields["inputDatasetId"]
                  ? [{ key: "Input Dataset", value: String(fields["inputDatasetId"]) }]
                  : []),
                ...(fields["outputDatasetId"]
                  ? [{ key: "Output Dataset", value: String(fields["outputDatasetId"]) }]
                  : []),
                ...(fields["createdBy"]
                  ? [{ key: "Created By", value: String(fields["createdBy"]) }]
                  : []),
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
                ...(fields["progressPercent"] != null
                  ? [{ key: "Percent", value: `${Number(fields["progressPercent"]).toFixed(0)}%` }]
                  : []),
                ...(fields["totalInputRequests"] != null
                  ? [
                      {
                        key: "Input Requests",
                        value: formatNumber(Number(fields["totalInputRequests"])),
                      },
                    ]
                  : []),
                ...(fields["successfullyProcessedRequests"] != null
                  ? [
                      {
                        key: "Succeeded",
                        value: formatNumber(Number(fields["successfullyProcessedRequests"])),
                      },
                    ]
                  : []),
                ...(fields["failedRequests"] != null
                  ? [{ key: "Failed", value: formatNumber(Number(fields["failedRequests"])) }]
                  : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Timing",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...(fields["createTime"]
                  ? [{ key: "Created", value: String(fields["createTime"]) }]
                  : []),
                ...(fields["runStartTime"]
                  ? [{ key: "Started", value: String(fields["runStartTime"]) }]
                  : []),
                // There is no `completionTime` on this object: `lifecycle.endTime` is it.
                ...(fields["endTime"] ? [{ key: "Ended", value: String(fields["endTime"]) }] : []),
                ...(fields["expireTime"]
                  ? [{ key: "Deadline", value: String(fields["expireTime"]) }]
                  : []),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderFineTuningJobDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapJobState(String(fields["state"] ?? ""));
    const short = String(fields["state"] ?? "").replace(/^JOB_STATE_/, "");
    const cancellable = ["RUNNING", "PENDING", "CREATING", "VALIDATING", "IDLE"].includes(short);
    const resumable = ["PAUSED", "EARLY_STOPPED"].includes(short);
    return {
      title: resource.displayName,
      subtitle: "Supervised fine-tuning job",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Job",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Job ID", value: String(fields["jobId"] ?? ""), copyable: true },
                { key: "State", value: mapped.label },
                ...(fields["statusMessage"]
                  ? [{ key: "Status", value: String(fields["statusMessage"]) }]
                  : []),
                ...(fields["baseModel"]
                  ? [{ key: "Base Model", value: String(fields["baseModel"]) }]
                  : []),
                ...(fields["dataset"]
                  ? [{ key: "Dataset", value: String(fields["dataset"]) }]
                  : []),
                ...(fields["evaluationDataset"]
                  ? [{ key: "Evaluation Dataset", value: String(fields["evaluationDataset"]) }]
                  : []),
                ...(fields["outputModel"]
                  ? [{ key: "Output Model", value: String(fields["outputModel"]), copyable: true }]
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
                ...(fields["epochs"] != null
                  ? [{ key: "Epochs", value: String(fields["epochs"]) }]
                  : []),
                ...(fields["learningRate"] != null
                  ? [{ key: "Learning Rate", value: String(fields["learningRate"]) }]
                  : []),
                ...(fields["loraRank"] != null
                  ? [{ key: "LoRA Rank", value: String(fields["loraRank"]) }]
                  : []),
                ...(fields["batchSizeSamples"] != null
                  ? [{ key: "Batch Size", value: String(fields["batchSizeSamples"]) }]
                  : []),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Cost",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...(fields["estimatedCost"] != null
                  ? [
                      {
                        key: "Estimated Cost",
                        value: `$${Number(fields["estimatedCost"]).toFixed(2)}`,
                      },
                    ]
                  : [{ key: "Estimated Cost", value: "Not reported" }]),
                ...(fields["progressPercent"] != null
                  ? [{ key: "Progress", value: `${Number(fields["progressPercent"]).toFixed(0)}%` }]
                  : []),
                ...(fields["createTime"]
                  ? [{ key: "Created", value: String(fields["createTime"]) }]
                  : []),
                // Note: the field is `completedTime`, not `completionTime`.
                ...(fields["completedTime"]
                  ? [{ key: "Completed", value: String(fields["completedTime"]) }]
                  : []),
              ],
            },
          ],
        },
      ],
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
                    "Cancel this fine-tuning job? You are billed for the accelerator time already used.",
                  successMessage: "Cancellation requested.",
                },
              },
            ]
          : []),
        ...(resumable
          ? [
              {
                kind: "action" as const,
                label: "Resume",
                action: {
                  type: "plugin-action" as const,
                  actionId: "resume",
                  successMessage: "Resume requested.",
                },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "API key",
      status: {
        kind: "status-dot",
        status: fields["expireTime"] ? "degraded" : "healthy",
        label: fields["expireTime"] ? "Expires" : "No expiry",
      },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key ID", value: String(fields["keyId"] ?? ""), copyable: true },
                { key: "Display Name", value: String(fields["displayName"] ?? "") },
                ...(fields["prefix"] ? [{ key: "Prefix", value: `${fields["prefix"]}…` }] : []),
                ...(fields["email"] ? [{ key: "Owner", value: String(fields["email"]) }] : []),
                ...(fields["secure"] != null
                  ? [
                      {
                        key: "Plaintext Known to Fireworks",
                        value: fields["secure"] ? "No" : "Yes",
                      },
                    ]
                  : []),
                ...(fields["createTime"]
                  ? [{ key: "Created", value: String(fields["createTime"]) }]
                  : []),
                ...(fields["expireTime"]
                  ? [{ key: "Expires", value: String(fields["expireTime"]) }]
                  : [{ key: "Expires", value: "Never" }]),
              ],
            },
            {
              kind: "text",
              content:
                "The plaintext value is only returned when the key is created. To replace a lost key, create a new one.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderSecretDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Account secret",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Secret",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key Name", value: String(fields["keyName"] ?? ""), copyable: true },
                { key: "Secret ID", value: String(fields["secretId"] ?? ""), copyable: true },
              ],
            },
            {
              kind: "text",
              content:
                "Secret values are write-only on the Fireworks API, so only the key name is shown.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderQuotaDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const used = Number(fields["usage"] ?? 0);
    const limit = Number(fields["value"] ?? 0);
    return {
      title: resource.displayName,
      subtitle: "Accelerator quota",
      status: {
        kind: "status-dot",
        status: limit > 0 && used / limit >= 0.9 ? "degraded" : "info",
        label: `${used} / ${limit}`,
      },
      sections: [
        {
          kind: "section",
          title: "Quota",
          children: [
            {
              kind: "key-value-list",
              items: [
                // The id encodes both accelerator and region, e.g. `h100-us-iowa-1`.
                { key: "Quota ID", value: String(fields["quotaId"] ?? ""), copyable: true },
                { key: "Enforced Limit", value: String(fields["value"] ?? "—") },
                { key: "Approved Maximum", value: String(fields["maxValue"] ?? "—") },
                { key: "In Use", value: String(used) },
                ...(fields["updateTime"]
                  ? [{ key: "Updated", value: String(fields["updateTime"]) }]
                  : []),
              ],
            },
            {
              kind: "text",
              content:
                "The enforced limit can be lowered below the approved maximum to cap spend. Raising it above the approved maximum requires a usage-limit increase request with Fireworks.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderRouterDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapDeploymentState(String(fields["state"] ?? ""));
    const routerName = String(resource.resolvedOutputs["routerName"] ?? "");
    const deployments = String(fields["deployments"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Router",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...kvItems(fields, [
                ["Router ID", "routerId", true],
                ["Status", "statusMessage"],
                ["Model", "model", true],
              ]),
              { key: "State", value: mapped.label },
              {
                key: "Routing Strategy",
                value:
                  fields["strategy"] === "evenLoad"
                    ? "Even load per replica"
                    : fields["strategy"] === "weightedRandom"
                      ? "Weighted random (by replica count)"
                      : "Default",
              },
              { key: "Visibility", value: fields["public"] ? "Public" : "Private" },
              ...kvItems(fields, [
                ["System-generated", "autoGenerated"],
                ["Created By", "createdBy"],
                ["Created", "createTime"],
              ]),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Deployments",
        children: deployments.length
          ? deployments.map((name) => ({
              kind: "text" as const,
              variant: "mono" as const,
              copyable: true,
              content: name,
            }))
          : [{ kind: "text", variant: "muted", content: "No deployments." }],
      },
    ];
    if (routerName) {
      sections.push({
        kind: "section",
        title: "Calling this router",
        children: [
          {
            kind: "text",
            content: `POST ${INFERENCE_BASE}/chat/completions  {"model": "${routerName}"}`,
            variant: "mono",
            copyable: true,
          },
          ...(fields["aliases"]
            ? [
                {
                  kind: "text" as const,
                  variant: "muted" as const,
                  content: `Also reachable as: ${String(fields["aliases"])}`,
                },
              ]
            : []),
        ],
      });
    }
    return {
      title: resource.displayName,
      subtitle: "Router",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  /** DPO and RFT jobs share `trainingConfig`, states and the resume verb. */
  private renderTrainingJobDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const isRft = resource.resourceTypeId === "reinforcement-fine-tuning-job";
    const mapped = mapJobState(String(fields["state"] ?? ""));
    const short = String(fields["state"] ?? "").replace(/^JOB_STATE_/, "");
    const cancellable =
      isRft && ["RUNNING", "PENDING", "CREATING", "VALIDATING", "IDLE"].includes(short);
    const resumable = ["PAUSED", "EARLY_STOPPED", "FAILED", "CANCELLED"].includes(short);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Job",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...kvItems(fields, [["Job ID", "jobId", true]]),
              { key: "State", value: mapped.label },
              ...kvItems(fields, [
                ["Status", "statusMessage"],
                ["Base Model", "baseModel"],
                ["Evaluator", "evaluator"],
                ["Dataset", "dataset"],
                ["Evaluation Dataset", "evaluationDataset"],
                ["Output Model", "outputModel", true],
                ["Created By", "createdBy"],
                ["Created", "createTime"],
                ["Completed", "completedTime"],
              ]),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Training",
        children: [
          {
            kind: "key-value-list",
            items: kvItems(fields, [
              ["Loss Method", "lossMethod"],
              ["KL Beta", "klBeta"],
              ["Epochs", "epochs"],
              ["Learning Rate", "learningRate"],
              ["LoRA Rank", "loraRank"],
              ["Batch Size", "batchSizeSamples"],
              ["Nodes", "nodeCount"],
            ]),
          },
        ],
      },
    ];
    if (isRft) {
      sections.push({
        kind: "section",
        title: "Progress",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...(fields["progressPercent"] != null
                ? [{ key: "Percent", value: `${Number(fields["progressPercent"]).toFixed(0)}%` }]
                : []),
              ...kvItems(fields, [
                ["Current Epoch", "epoch"],
                ["Input Tokens", "inputTokens"],
                ["Output Tokens", "outputTokens"],
              ]),
            ],
          },
        ],
      });
    }
    if (fields["wandbUrl"]) {
      sections.push({
        kind: "section",
        title: "Links",
        children: [
          { kind: "link", label: "Weights & Biases run", url: String(fields["wandbUrl"]) },
        ],
      });
    }
    return {
      title: resource.displayName,
      subtitle: isRft ? "Reinforcement fine-tuning job" : "DPO job",
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
                    "Cancel this reinforcement fine-tuning job? You are billed for the accelerator time already used.",
                  successMessage: "Cancellation requested.",
                },
              },
            ]
          : []),
        ...(resumable
          ? [
              {
                kind: "action" as const,
                label: "Resume",
                action: {
                  type: "plugin-action" as const,
                  actionId: "resume",
                  successMessage: "Resume requested.",
                },
              },
            ]
          : []),
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
    };
  }

  private renderEvaluatorDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapEvaluatorState(String(fields["state"] ?? ""));
    return {
      logs: { defaultTailLines: 500 },
      title: resource.displayName,
      subtitle: "Evaluator",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Evaluator",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...kvItems(fields, [["Evaluator ID", "evaluatorId", true]]),
                { key: "State", value: mapped.label },
                ...kvItems(fields, [
                  ["Status", "statusMessage"],
                  ["Description", "description"],
                  ["Default Dataset", "defaultDataset"],
                  ["Entry Point", "entryPoint", true],
                  ["Source", "sourceType"],
                  ["GitHub Repository", "githubRepository"],
                  ["Commit", "commitHash", true],
                  ["Created By", "createdBy"],
                  ["Created", "createTime"],
                  ["Updated", "updateTime"],
                ]),
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "New evaluators and code changes go through Fireworks' upload-and-build flow (the firectl CLI or Eval Protocol SDK). Display name and description can be edited here.",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderEvaluationJobDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapJobState(String(fields["state"] ?? ""));
    let metrics: Array<{ key: string; value: string }> = [];
    try {
      const parsed = JSON.parse(String(fields["metrics"] ?? "{}")) as Record<string, unknown>;
      metrics = Object.entries(parsed).map(([key, value]) => ({
        key,
        value: typeof value === "object" ? JSON.stringify(value) : String(value),
      }));
    } catch {
      metrics = [];
    }
    return {
      logs: { defaultTailLines: 500 },
      title: resource.displayName,
      subtitle: "Evaluation job",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "Job",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...kvItems(fields, [["Job ID", "jobId", true]]),
                { key: "State", value: mapped.label },
                ...kvItems(fields, [
                  ["Status", "statusMessage"],
                  ["Evaluator", "evaluator"],
                  ["Input Dataset", "inputDataset"],
                  ["Output Dataset", "outputDataset"],
                  ["Created By", "createdBy"],
                  ["Created", "createTime"],
                  ["Updated", "updateTime"],
                ]),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Metrics",
          children: metrics.length
            ? [{ kind: "key-value-list", items: metrics }]
            : [{ kind: "text", variant: "muted", content: "No metrics reported yet." }],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderUserDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const mapped = mapDeploymentState(String(fields["state"] ?? ""));
    return {
      logs: { defaultTailLines: 200 },
      title: resource.displayName,
      subtitle: fields["serviceAccount"] ? "Service account" : "User",
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections: [
        {
          kind: "section",
          title: "User",
          children: [
            {
              kind: "key-value-list",
              items: kvItems(fields, [
                ["User ID", "userId", true],
                ["Email", "email", true],
                ["Role", "role"],
                ["Permission Preset", "permissionPreset"],
                ["Service Account", "serviceAccount"],
                ["Created", "createTime"],
                ["Updated", "updateTime"],
              ]),
            },
          ],
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

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/** Strategy oneof for router create/update bodies. */
function strategyBody(strategy: string | undefined): Record<string, Record<string, never>> {
  return strategy === "evenLoad" ? { evenLoad: {} } : { weightedRandom: {} };
}

/** `policy-picker` submits a JSON array; tolerate a comma list as well. */
function parseIdList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // fall through to comma splitting
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** `WANDB_API_KEY` → `wandb-api-key`: a valid resource id derived from the key name. */
function secretIdFor(keyName: string): string {
  return (
    keyName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "secret"
  );
}

function getUserCreateConfig(): CreateResourceConfig {
  return {
    fields: [
      {
        key: "kind",
        label: "Kind",
        kind: "select",
        required: true,
        options: [
          { id: "member", label: "Member (invite by email)" },
          { id: "service-account", label: "Service account" },
        ],
        defaultValue: "member",
      },
      {
        key: "email",
        label: "Email",
        kind: "text",
        required: false,
        placeholder: "teammate@example.com",
        showWhen: { fieldKey: "kind", fieldValue: "member" },
      },
      { key: "displayName", label: "Display Name", kind: "text", required: false },
      {
        key: "role",
        label: "Role",
        kind: "select",
        required: true,
        options: [
          { id: "admin", label: "Admin" },
          { id: "user", label: "User" },
          { id: "contributor", label: "Contributor" },
          { id: "inference-user", label: "Inference user" },
          { id: "custom", label: "Custom (permission preset)" },
        ],
        defaultValue: "user",
      },
      {
        key: "permissionPreset",
        label: "Permission Preset",
        kind: "text",
        required: false,
        showWhen: { fieldKey: "role", fieldValue: "custom" },
        description: "The Fireworks permission preset that governs a custom role.",
      },
    ],
  };
}

function getSecretCreateConfig(): CreateResourceConfig {
  return {
    fields: [
      {
        key: "keyName",
        label: "Key Name",
        kind: "text",
        required: true,
        placeholder: "WANDB_API_KEY",
        description: "The name jobs and evaluators reference the secret by.",
      },
      {
        key: "value",
        label: "Value",
        kind: "password",
        required: true,
        description: "Write-only: Fireworks never returns it again.",
      },
    ],
  };
}
