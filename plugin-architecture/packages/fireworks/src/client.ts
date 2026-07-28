import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceCreateResult,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { CostSetupError, jsonRestFetch } from "@infrawrench/plugin-base";

const HOST = "https://api.fireworks.ai";
/** The account is encoded in the model string on this plane, not in the path. */
const INFERENCE_BASE = `${HOST}/inference/v1`;

/** `pageSize` is clamped server-side at 200; anything larger is silently coerced. */
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

/** `GET /billingUsage` refuses a window wider than 31 days. */
const MAX_USAGE_WINDOW_DAYS = 31;

// ---------------------------------------------------------------------------
// Wire shapes — mirrored from https://docs.fireworks.ai/merged.openapi.yaml
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
  /** int64 — arrives as a JSON string. */
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
  /** int64 — arrives as a JSON string. */
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
  /** There is no `completionTime` on this object — the end stamp lives here. */
  lifecycle?: { validatedTime?: string; runStartTime?: string; endTime?: string } | null;
}

interface Money {
  currencyCode?: string;
  /** int64 — arrives as a JSON string. */
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
}

interface Secret {
  name?: string;
  keyName?: string;
}

interface Quota {
  name?: string;
  /** int64 — arrives as a JSON string. */
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
  /** int64 — arrives as a JSON string. */
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

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/** `accounts/{acct}/deployments/{id}` → `{id}`. */
function lastSegment(name: string | undefined): string {
  if (!name) return "";
  const parts = name.split("/");
  return parts[parts.length - 1] ?? "";
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
        "Fireworks plugin: missing accountId credential — Fireworks has no whoami endpoint, so the account id must be supplied",
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
    // mutually-exclusive marker objects, not booleans — flatten to one label.
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
      default: {
        // API keys have no published get-by-id route over HTTP — the generated
        // spec path for it is malformed — so we re-read the list instead.
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
    if (typeId !== "api-key") {
      throw new Error(`Fireworks plugin: createResource not supported for type "${typeId}"`);
    }
    const users = await this.paginate<"users", User>("/users", "users").catch((): User[] => []);
    const options = users
      .filter((user) => Boolean(user.name))
      .map((user) => ({
        id: lastSegment(user.name),
        label: user.email
          ? `${user.displayName || lastSegment(user.name)} — ${user.email}`
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
    if (typeId !== "api-key") {
      throw new Error(`Fireworks plugin: createResource not supported for type "${typeId}"`);
    }
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
              message: `Copy this key now — Fireworks returns the plaintext value only at creation and never stores it: ${created.key}`,
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
    if (typeId !== "deployment") {
      throw new Error(`Fireworks plugin: updateResource not supported for type "${typeId}"`);
    }
    const id = encodeURIComponent(externalIdOf(resourceId));

    if (fields["replicaCount"] !== undefined) {
      const replicaCount = Number.parseInt(fields["replicaCount"], 10);
      if (!Number.isFinite(replicaCount) || replicaCount < 0) {
        throw new Error("Fireworks plugin: replicaCount must be a non-negative integer");
      }
      // Note the `:scale` suffix — this is a custom method, so it does NOT
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
   * `POST .../supervisedFineTuningJobs/{id}:cancel` and `:resume`, and
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
   * `usageCosts:query` returns google.type.Money — real dollars.
   * https://docs.fireworks.ai/api-reference/query-usage-costs
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
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
            // Not an account admin — fall back to this principal's own spend
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
   * `GET /v1/accounts/{aid}/billingUsage` — daily buckets, split into
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
      case "supervised-fine-tuning-job": {
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
      case "supervised-fine-tuning-job": {
        const mapped = mapJobState(state);
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
            // Worth spelling out — this is not ordinary PATCH semantics.
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
              "Inference and control-plane calls share the same API key but not the same base URL — the account lives in the model string here, and in the path on the control plane.",
            variant: "muted",
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Deployment · ${modelString}`,
      status: { kind: "status-dot", status: mapped.status, label: mapped.label },
      sections,
      metricsCapability: { defaultTimeRangeMs: 14 * 24 * 60 * 60 * 1000 },
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
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
                // There is no `completionTime` on this object — `lifecycle.endTime` is it.
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
                "The plaintext value is returned once, in the create response, and is never stored — there is no way to read it back. Create a replacement key rather than trying to recover this one.",
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
                "Secret values are write-only on the Fireworks API — they are never returned by a get or a list, so only the key name is shown here.",
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
