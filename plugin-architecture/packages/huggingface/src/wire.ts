/**
 * Wire shapes for the Hugging Face APIs this plugin reads, verified against
 * https://huggingface.co/.well-known/openapi.json (Hub) and
 * https://api.endpoints.huggingface.cloud/openapi.json (Inference Endpoints
 * v2.0.0) in October 2026. Every field is optional on purpose: the Hub
 * omits keys freely and a missing one must never crash a listing.
 */

export interface WhoAmI {
  type?: string;
  id?: string;
  name?: string;
  fullname?: string;
  isPro?: boolean;
  canPay?: boolean;
  billingMode?: "prepaid" | "postpaid";
  orgs?: Array<{
    name?: string;
    fullname?: string;
    plan?: string;
    roleInOrg?: string;
    canPay?: boolean;
  }>;
  auth?: {
    type?: string;
    accessToken?: { displayName?: string; role?: string; createdAt?: string };
    expiresAt?: string;
  };
}

// ------------------------------------------------------- Inference Endpoints

export interface EndpointScaling {
  minReplica?: number;
  maxReplica?: number;
  scaleToZeroTimeout?: number | null;
  measure?: { hardwareUsage?: number | null; pendingRequests?: number | null } | null;
}

export interface Endpoint {
  name?: string;
  type?: string;
  tags?: string[];
  provider?: { vendor?: string; region?: string };
  compute?: {
    accelerator?: string;
    instanceType?: string;
    instanceSize?: string;
    scaling?: EndpointScaling;
  };
  model?: {
    repository?: string;
    revision?: string | null;
    task?: string;
    framework?: string;
    image?: Record<string, unknown>;
    env?: Record<string, string>;
  };
  status?: {
    state?: string;
    message?: string;
    errorMessage?: string | null;
    url?: string;
    readyReplica?: number;
    targetReplica?: number;
    createdAt?: string;
    updatedAt?: string;
    lastUsedAt?: string | null;
    createdBy?: { name?: string };
    inferenceMetricsEnabled?: boolean;
    private?: { serviceName?: string | null } | null;
  };
}

export interface EndpointList {
  items?: Endpoint[];
  nextCursor?: string | null;
  totalItems?: number;
}

export interface Compute {
  id?: string;
  accelerator?: string;
  numAccelerators?: number;
  memoryGb?: number;
  gpuMemoryGb?: number | null;
  numCpus?: number | null;
  instanceType?: string;
  instanceSize?: string;
  architecture?: string;
  status?: string;
  pricePerHour?: number;
  quota?: { maxAccelerators?: number; usedAccelerators?: number };
}

export interface Vendors {
  vendors?: Array<{
    name?: string;
    status?: string;
    regions?: Array<{ name?: string; label?: string; status?: string; computes?: Compute[] }>;
  }>;
}

export interface VendorQuotas {
  vendors?: Array<{
    name?: string;
    quotas?: Array<{
      instanceType?: string;
      architecture?: string;
      maxAccelerators?: number;
      usedAccelerators?: number;
    }>;
  }>;
}

export interface DataPoint {
  x?: string;
  y?: number;
}

export interface HardwareSeries {
  replicaId?: string;
  deviceId?: number | null;
  data?: DataPoint[];
}

export interface AllGraphs {
  responseStatusCodeGrouped?: { series?: Array<{ statusCode?: string; data?: DataPoint[] }> };
  responseElapsed?: { series?: Array<{ percentile?: string; data?: DataPoint[] }> };
  pendingRequest?: { series?: Array<{ status?: string; data?: DataPoint[] }> };
  replicasRunning?: { series?: Array<{ status?: string; data?: DataPoint[] }> };
  hardwareCpu?: { series?: HardwareSeries[] };
  hardwareMem?: { series?: HardwareSeries[] };
  hardwareGpu?: { series?: HardwareSeries[] };
  hardwareGpuMem?: { series?: HardwareSeries[] };
  inference?: {
    kvCache?: { series?: HardwareSeries[] };
    ttft?: { series?: HardwareSeries[] };
    itl?: { series?: HardwareSeries[] };
    prefixCache?: { series?: HardwareSeries[] };
    requests?: { waiting?: { series?: HardwareSeries[] }; running?: { series?: HardwareSeries[] } };
  } | null;
}

export interface LogEntry {
  timestamp?: string;
  line?: string;
  stream?: string;
  replica_id?: string;
  level?: string | null;
}

export interface Replicas {
  items?: Array<{ id?: string; status?: { stage?: string; live?: boolean } }>;
}

export interface CatalogList {
  items?: Array<{
    modelName?: string;
    repoId?: string;
    authorName?: string;
    task?: string;
    license?: string;
    recipes?: Array<{ publicId?: string; accelerator?: string; engineType?: string }>;
  }>;
}

// -------------------------------------------------------------------- Hub

export interface RepoInfo {
  id?: string;
  private?: boolean;
  gated?: boolean | string;
  disabled?: boolean;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  library_name?: string;
  lastModified?: string;
  createdAt?: string;
  usedStorage?: number;
  sdk?: string;
  subdomain?: string;
  runtime?: SpaceRuntime;
  cardData?: { title?: string; emoji?: string } | null;
}

export interface SpaceRuntime {
  stage?: string;
  hardware?: { current?: string | null; requested?: string | null };
  gcTimeout?: number | null;
  storage?: string | null;
  errorMessage?: string;
  domains?: Array<{ domain?: string; stage?: string }>;
}

export interface HardwareFlavor {
  name?: string;
  prettyName?: string;
  cpu?: string;
  ram?: string;
  accelerator?: { model?: string; quantity?: string; vram?: string } | null;
  unitCostUSD?: number;
  unitLabel?: string;
}

export interface SpaceKeyEntry {
  key?: string;
  value?: string;
  description?: string;
  updatedAt?: string;
}

export interface Job {
  id?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  spaceId?: string;
  dockerImage?: string;
  command?: string[];
  arguments?: string[];
  flavor?: string;
  timeout?: number;
  createdBy?: { name?: string };
  durations?: { runningSecs?: number; totalSecs?: number };
  labels?: Record<string, string>;
  status?: { stage?: string; message?: string | null; cancelReason?: string };
}

export interface ScheduledJob {
  id?: string;
  createdAt?: string;
  schedule?: string;
  suspend?: boolean;
  suspendReason?: string;
  concurrency?: boolean;
  status?: { lastJob?: { id?: string; at?: string } | null; nextJobRunAt?: string };
  jobSpec?: { dockerImage?: string; spaceId?: string; command?: string[]; flavor?: string };
}

export interface ServiceAccount {
  _id?: string;
  user?: string;
  name?: string;
  email?: string;
  description?: string;
  createdAt?: string;
  accessTokens?: Array<{
    _id?: string;
    displayName?: string;
    createdAt?: string;
    lastUsedAt?: string;
    expiration?: string;
    role?: string;
    permissions?: string[];
    last4?: string;
  }>;
}

export interface MemberToken {
  _id?: string;
  displayName?: string;
  role?: string;
  last4?: string;
  createdAt?: string;
  lastUsedAt?: string;
  owner?: { name?: string; fullname?: string };
  authorization?: { status?: string };
}

export interface Webhook {
  id?: string;
  url?: string;
  disabled?: boolean | string;
  hasSecret?: boolean;
  domains?: string[];
  watched?: Array<{ name?: string; type?: string }>;
  lastTriggerAt?: string;
  job?: { dockerImage?: string; spaceId?: string };
}

export interface RouterModels {
  data?: RouterModel[];
}

export interface RouterModel {
  id?: string;
  created?: number;
  owned_by?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  providers?: Array<{
    provider?: string;
    status?: string;
    context_length?: number;
    pricing?: { input?: number; output?: number };
    supports_tools?: boolean;
    supports_structured_output?: boolean;
    first_token_latency_ms?: number;
    throughput?: number;
  }>;
}

export interface ZeroGpuQuota {
  base?: number;
  current?: number;
  resetsAt?: string | null;
  overquotaUsed?: number;
}

export interface InferenceUsagePeriod {
  period?: string;
  usage?: Array<{
    user?: string | null;
    model?: string | null;
    provider?: string;
    requestCount?: number;
    costCents?: number;
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

export interface JobsUsage {
  hasAccess?: boolean;
  usage?: {
    usedMicroUsd?: number;
    totalMinutes?: number;
    periodStart?: string;
    periodEnd?: string;
    jobDetails?: Array<{
      jobId?: string;
      hardwareFlavor?: string;
      totalMinutes?: number;
      totalCostMicroUsd?: number;
      startedAt?: string;
      completedAt?: string;
    }>;
  };
}
