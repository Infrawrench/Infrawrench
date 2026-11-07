import {
  createApiClient,
  jsonRestFetch,
  withCursorPagination,
  type HttpHostServices,
} from "@infrawrench/plugin-base";
import type { components, paths } from "./api-types.gen.js";

type Schemas = components["schemas"];

const API_HOST = "https://api.together.ai";
export const API_BASE = `${API_HOST}/v1`;

/** `/billing/usage` for a v1 route. Anything else, which is v2, names its whole URL. */
function errorPath(url: string): string {
  return url.startsWith(API_BASE) ? url.slice(API_BASE.length) || "/" : url;
}

export interface TogetherConnection {
  apiKey: string;
  caCert: string;
  http: HttpHostServices | undefined;
}

const jsonHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  Accept: "application/json",
});

/**
 * Together's document spans both API versions, so the client's base is the host and
 * every path carries its version. The v2 operations override the server to this same
 * host, not the inference one (`api-inference.together.ai`), which would answer 404.
 */
export function createTogetherApi({ apiKey, caCert, http }: TogetherConnection) {
  return createApiClient<paths>({
    vendor: "Together",
    baseUrl: API_HOST,
    headers: jsonHeaders(apiKey),
    encodeQuery: encodeURIComponent,
    httpError: ({ status, url, body }) =>
      new Error(`Together API error ${status} for ${errorPath(url)}: ${body}`),
    http,
    caCert,
  });
}

/**
 * The v2 lists: `limit` and `after`, with `next_cursor` null on the last page. 10,000
 * rows by default. The document states no maximum page size for most of them.
 */
export function withDmiPagination(api: ReturnType<typeof createTogetherApi>) {
  return withCursorPagination(api, {
    cursorParam: "after",
    sizeParam: "limit",
    next: "next_cursor",
    pageSize: 100,
    maxPages: 100,
  });
}

/** The status of a failed call, from the message both request paths here write. */
export function apiErrorStatus(error: unknown): number | undefined {
  const match = error instanceof Error ? /^Together API error (\d+)/.exec(error.message) : null;
  return match ? Number(match[1]) : undefined;
}

/**
 * A call to a v1 route the document no longer describes: `/whoami`, `/models`, `/hardware`
 * and `/endpoints`. The types below stand in for it, so nothing but the plugin's use of
 * them checks these. Together's migration guide still has v1 endpoints listed, stopped and
 * deleted here "until further notice":
 * https://docs.together.ai/docs/dedicated-endpoints/migrate-from-v1
 */
export function undocumentedRequest<T>(
  { apiKey, caCert, http }: TogetherConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  return jsonRestFetch<T>({
    vendor: "Together",
    url,
    errorPath: errorPath(url),
    headers: jsonHeaders(apiKey),
    ...(init ? { init } : {}),
    ...(http ? { http } : {}),
    ...(caCert ? { caCert } : {}),
  });
}

// ---------------------------------------------------------------------------
// Routes the document does not cover
// ---------------------------------------------------------------------------

/** `GET /v3/whoami` nests the ids; `GET /v1/whoami` has them at the top level. */
export interface WhoAmI {
  type?: string;
  project?: { id?: string };
  organization?: { id?: string };
  project_id?: string;
  organization_id?: string;
}

export interface TogetherModel {
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

/** `GET /v1/endpoints` items are narrower than `GET /v1/endpoints/{id}`. */
export interface ListEndpoint {
  id?: string;
  object?: string;
  name?: string;
  model?: string;
  type?: string;
  owner?: string;
  state?: string;
  created_at?: string;
}

export interface DedicatedEndpoint extends ListEndpoint {
  display_name?: string;
  hardware?: string;
  autoscaling?: { min_replicas?: number; max_replicas?: number } | null;
}

/** `POST /v1/endpoints`. */
export interface EndpointCreateBody {
  model: string;
  hardware: string;
  autoscaling: { min_replicas: number; max_replicas: number };
  display_name?: string;
  state: "STARTED" | "STOPPED";
  inactive_timeout?: number;
}

/** `PATCH /v1/endpoints/{id}`. */
export interface EndpointUpdateBody {
  display_name?: string;
  state?: "STARTED" | "STOPPED";
  autoscaling?: { min_replicas: number; max_replicas: number };
}

export interface TogetherHardware {
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

// ---------------------------------------------------------------------------
// Routes the document covers
// ---------------------------------------------------------------------------

/** The list answers the truncated form, a single job the full one. */
export type FineTuneJob = Schemas["FinetuneResponseTruncated"] | Schemas["FinetuneResponse"];

/** `LineCount` is undocumented but still emitted; the Python SDK maps it. */
export type TogetherFile = Schemas["FileResponse"] & { LineCount?: number };

export type BatchJob = Schemas["BatchJob"];
/** `POST /v1/batches` answers `{ job, warning }`; a bare job is tolerated too. */
export type CreatedBatch = BatchJob & Schemas["BatchJobWithWarning"];
export type EvaluationJob = Schemas["EvaluationJob"];
export type DmiEndpoint = Schemas["DE.Endpoint"];
export type SupportedModel = Schemas["DE.SupportedModel"];
export type InstanceType = Schemas["DE.InferenceInstanceType"];
export type DmiEndpointEvent = Schemas["DE.EndpointEvent"];
export type DmiEndpointMetrics = Schemas["DE.EndpointMetrics"];
export type DmiAnalytics = Schemas["DE.AnalyticsData"];
export type GpuCluster = Schemas["GPUClusterInfo"];
export type ClusterCreateBody = Schemas["GPUClusterCreateRequest"];
export type ClusterUpdateBody = Schemas["GPUClusterUpdateRequest"];
export type ComputeRegion = Schemas["RegionListResponse"]["regions"][number];
export type SharedVolume = Schemas["GPUClustersSharedVolume"];
export type FineTuneEvent = Schemas["FineTuneEvent"];
export type FineTuneCheckpoint = Schemas["FineTuneCheckpoint"];
export type BillingUsageLineItem = Schemas["BillingUsageLineItem"];
export type BillingUsageReport = Schemas["BillingUsageReport"];

/** The `verbose_json` form, which is the one the plugin asks for. */
export type TranscriptionResponse = Schemas["AudioTranscriptionVerboseJsonResponse"];

/** Some of Together's own samples show a flat `{ voices: [...] }` rather than `{ data: [...] }`. */
export type VoiceCatalog = Partial<Schemas["ListVoicesResponse"]> & {
  voices?: Schemas["ModelVoices"][];
};
