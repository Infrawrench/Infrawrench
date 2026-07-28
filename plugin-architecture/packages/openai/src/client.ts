import type {
  ActionNode,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  KVItem,
  MetricSeries,
  MetricSeriesPoint,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  StatusDotNode,
  SidebarItemSchema,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import { CostSetupError, jsonRestFetch } from "@infrawrench/plugin-base";
import {
  ACCEPTED_AUDIO_TYPES,
  AUTO_LANGUAGE,
  DEFAULT_STT_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_VOICE,
  DIARIZE_MODEL,
  LEGACY_TTS_MODELS,
  MAX_AUDIO_BYTES,
  MAX_TTS_CHARACTERS,
  SPEECH_MODELS,
  STT_LANGUAGES,
  TTS_VOICES,
  VERBOSE_JSON_MODEL,
  audioFileName,
  isSttModel,
  isTtsModel,
} from "./speech.js";

const PLUGIN_ID = "openai";
const API_BASE = "https://api.openai.com/v1";

/**
 * The wall between the two key types is absolute: `/v1/organization/*` is
 * declared `AdminApiKeyAuth` in OpenAI's own API description and answers a
 * project key with 403, while an admin key is refused everywhere on the data
 * plane. Neither degrades — so rather than surfacing a bare 403 from six
 * different call sites, every admin request funnels through one guard that
 * names the missing credential.
 */
const ADMIN_KEY_REQUIRED =
  'OpenAI plugin: this needs the account\'s "Admin API key". Organization projects, members, invites, ' +
  "usage and costs live under /v1/organization/* and only an admin key (sk-admin-…) can reach them — a " +
  "project key (sk-… / sk-proj-…) is rejected there with a 403. Edit this account and paste an admin key " +
  "from https://platform.openai.com/settings/organization/admin-keys.";

// ---- API response shapes (only the fields this plugin reads) ---------------

interface ListEnvelope<T> {
  data?: T[];
  has_more?: boolean;
  last_id?: string | null;
}

interface OpenAIModel {
  id: string;
  created?: number;
  owned_by?: string;
}

interface FineTuningJob {
  id: string;
  model?: string;
  status?: string;
  fine_tuned_model?: string | null;
  training_file?: string;
  validation_file?: string | null;
  trained_tokens?: number | null;
  created_at?: number;
  finished_at?: number | null;
  estimated_finish?: number | null;
  seed?: number;
  error?: { code?: string; message?: string } | null;
  method?: { type?: string } | null;
}

interface Batch {
  id: string;
  status?: string;
  endpoint?: string;
  model?: string;
  input_file_id?: string;
  output_file_id?: string;
  error_file_id?: string;
  completion_window?: string;
  created_at?: number;
  completed_at?: number;
  expires_at?: number;
  request_counts?: { total?: number; completed?: number; failed?: number };
}

interface OpenAIFile {
  id: string;
  filename?: string;
  purpose?: string;
  bytes?: number;
  created_at?: number;
  expires_at?: number;
}

interface VectorStore {
  id: string;
  name?: string;
  status?: string;
  usage_bytes?: number;
  created_at?: number;
  last_active_at?: number | null;
  expires_at?: number | null;
  file_counts?: {
    total?: number;
    completed?: number;
    in_progress?: number;
    failed?: number;
    cancelled?: number;
  };
}

interface Container {
  id: string;
  name?: string;
  status?: string;
  created_at?: number;
  last_active_at?: number;
  memory_limit?: string;
  expires_after?: { anchor?: string; minutes?: number };
  network_policy?: { type?: string; allowed_domains?: string[] };
}

interface EvalObject {
  id: string;
  name?: string;
  created_at?: number;
  data_source_config?: { type?: string };
  testing_criteria?: unknown[];
}

interface Project {
  id: string;
  name?: string | null;
  status?: string | null;
  created_at?: number;
  archived_at?: number | null;
}

interface ProjectApiKey {
  id: string;
  name?: string;
  redacted_value?: string;
  created_at?: number;
  last_used_at?: number | null;
  owner_project_access?: string;
  owner?: {
    type?: string;
    user?: { name?: string | null; email?: string | null };
    service_account?: { name?: string | null };
  };
}

interface OrganizationUser {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  added_at?: number;
  is_service_account?: boolean;
  is_scim_managed?: boolean;
  api_key_last_used_at?: number | null;
}

interface Invite {
  id: string;
  email?: string;
  role?: string;
  status?: string;
  created_at?: number;
  expires_at?: number | null;
  accepted_at?: number | null;
  projects?: Array<{ id?: string; role?: string }>;
}

interface ServiceAccountCreateResponse {
  id: string;
  name?: string;
  role?: string;
  created_at?: number;
  api_key?: { id?: string; value?: string; name?: string } | null;
}

interface UsageResult {
  object?: string;
  amount?: { value?: number; currency?: string };
  line_item?: string | null;
  project_id?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  num_model_requests?: number;
}

interface UsageBucket {
  start_time?: number;
  end_time?: number;
  results?: UsageResult[];
}

interface UsagePage {
  data?: UsageBucket[];
  has_more?: boolean;
  next_page?: string | null;
}

interface TranscriptionResponse {
  text?: string;
  language?: string;
  languages?: string[];
  duration?: number;
  words?: Array<{ word?: string; start?: number; end?: number }>;
  segments?: Array<{ text?: string; start?: number; end?: number; speaker?: string }>;
  usage?: { type?: string; seconds?: number; input_tokens?: number; total_tokens?: number };
}

// ---- Small helpers --------------------------------------------------------

/** Resource ids are `{accountId}:{typeId}:{externalId}`. */
function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function dash(value: unknown): string {
  const s = str(value);
  return s === "" ? "—" : s;
}

/** Unix seconds → ISO-8601, or "" for null/0/missing. */
function isoOf(seconds: unknown): string {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString();
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function formatBytes(value: unknown): string {
  const n = num(value);
  if (n === undefined) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function section(title: string, items: KVItem[]): SectionNode {
  return { kind: "section", title, children: [{ kind: "key-value-list", items }] };
}

function refreshAction(): ActionNode[] {
  return [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }];
}

/** `exactOptionalPropertyTypes` forbids an explicit `label: undefined`. */
function statusDot(status: unknown): StatusDotNode {
  const label = str(status);
  return { kind: "status-dot", status: statusOf(status), ...(label ? { label } : {}) };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

function headerValue(res: Response, name: string): string | undefined {
  const value = res.headers?.get?.(name);
  return value ?? undefined;
}

function dayStartUnix(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

/**
 * The OpenAI SDKs serialise repeated query arrays as `k=a&k=b` — the default
 * `array_format` on `openai-python`'s Querystring — not `k[]=a`. Bracket
 * notation is only used for multipart form bodies.
 */
function appendAll(params: URLSearchParams, key: string, values: string[]): void {
  for (const value of values) params.append(key, value);
}

/**
 * OpenAI paginates in four different dialects. The three list-shaped ones
 * relevant here all take an `after` cursor, but only some responses hand back
 * an explicit `last_id`: the admin endpoints (projects, users, invites, project
 * API keys) and vector stores / containers / evals do, while fine-tuning jobs,
 * batches and files do not and require the cursor to be read off the last
 * element. Preferring `last_id` and falling back to `data[-1].id` covers both
 * without silently truncating a long list.
 */
function nextCursor<T extends { id: string }>(
  page: ListEnvelope<T>,
  batch: T[],
): string | undefined {
  if (typeof page.last_id === "string" && page.last_id !== "") return page.last_id;
  const last = batch[batch.length - 1];
  return last?.id;
}

const STATUS_COLORS: Record<string, ResourceStatus> = {
  succeeded: "healthy",
  completed: "healthy",
  active: "healthy",
  running: "provisioning",
  in_progress: "provisioning",
  queued: "provisioning",
  validating: "provisioning",
  validating_files: "provisioning",
  finalizing: "provisioning",
  cancelling: "provisioning",
  pending: "provisioning",
  paused: "degraded",
  expired: "degraded",
  archived: "degraded",
  cancelled: "degraded",
  failed: "error",
};

function statusOf(value: unknown): ResourceStatus {
  return STATUS_COLORS[str(value).toLowerCase()] ?? "info";
}

/**
 * OpenAI plugin client.
 *
 * Two credentials, two disjoint planes: `apiKey` reaches everything under
 * `/v1` that isn't `/v1/organization/*`, and `adminApiKey` reaches only
 * `/v1/organization/*`. Every request goes through `services.http` when the
 * host provides one so bastion egress routing and a custom CA keep working;
 * the two audio calls are the documented exceptions (see `ttsBytes` and
 * `sttTranscribe`).
 */
export class OpenAIClient implements PluginClient {
  private readonly apiKey: string;
  private readonly adminApiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("OpenAI plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.adminApiKey = credentials["adminApiKey"] ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** True when the account carries an admin key, so admin sections can render. */
  private get hasAdminKey(): boolean {
    return this.adminApiKey !== "";
  }

  private async request<T>(path: string, key: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "OpenAI",
      url: `${API_BASE}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  /** Data plane — project key. */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, this.apiKey, options);
  }

  /** Admin plane — admin key, with the missing-credential guard. */
  private async adminFetch<T>(path: string, options?: RequestInit): Promise<T> {
    if (!this.hasAdminKey) throw new Error(ADMIN_KEY_REQUIRED);
    return this.request<T>(path, this.adminApiKey, options);
  }

  private async listAll<T extends { id: string }>(
    path: string,
    params: Record<string, string>,
    opts: { admin?: boolean; pageSize?: number; maxPages?: number } = {},
  ): Promise<T[]> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? 20;
    const out: T[] = [];
    let after: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const qs = new URLSearchParams(params);
      qs.set("limit", String(pageSize));
      if (after) qs.set("after", after);
      const url = `${path}?${qs.toString()}`;
      const body = opts.admin
        ? await this.adminFetch<ListEnvelope<T>>(url)
        : await this.fetch<ListEnvelope<T>>(url);
      const batch = body.data ?? [];
      out.push(...batch);
      if (!body.has_more || batch.length === 0) break;
      const cursor = nextCursor(body, batch);
      if (!cursor) break;
      after = cursor;
    }

    return out;
  }

  /**
   * Usage and cost endpoints don't use the `after` cursor at all — they page
   * with an opaque `page` token echoed back as `next_page`.
   */
  private async listUsageBuckets(
    path: string,
    params: URLSearchParams,
    maxPages = 10,
  ): Promise<UsageBucket[]> {
    const out: UsageBucket[] = [];
    let page: string | undefined;

    for (let i = 0; i < maxPages; i++) {
      const qs = new URLSearchParams(params);
      if (page) qs.set("page", page);
      const body = await this.adminFetch<UsagePage>(`${path}?${qs.toString()}`);
      out.push(...(body.data ?? []));
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }

    return out;
  }

  // ---- Listing -------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return this.listModels(accountId);
      case "fine-tuning-job":
        return this.listFineTuningJobs(accountId);
      case "batch":
        return this.listBatches(accountId);
      case "file":
        return this.listFiles(accountId);
      case "vector-store":
        return this.listVectorStores(accountId);
      case "container":
        return this.listContainers(accountId);
      case "eval":
        return this.listEvals(accountId);
      case "project":
        return this.listProjects(accountId);
      case "project-api-key":
        return this.listProjectApiKeys(accountId);
      case "organization-user":
        return this.listOrganizationUsers(accountId);
      case "invite":
        return this.listInvites(accountId);
      default:
        throw new Error(`OpenAI plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * `GET /v1/models` — verified 2026-07-29 against openapi.yaml v2.3.0
   * (`listModels`). Unpaginated; the whole catalogue arrives in one flat list.
   */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const body = await this.fetch<{ data?: OpenAIModel[] }>("/models");
    const models = [...(body.data ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const now = new Date().toISOString();
    return models.map((model) => this.mapModel(accountId, model, now));
  }

  private mapModel(accountId: string, model: OpenAIModel, now: string): ResourceInstance {
    const created = isoOf(model.created);
    return {
      id: `${accountId}:model:${model.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "model",
      accountId,
      displayName: model.id,
      externalId: model.id,
      fields: {
        modelId: model.id,
        ownedBy: str(model.owned_by),
        created,
        isFineTuned: model.id.startsWith("ft:"),
        supportsTts: isTtsModel(model.id),
        supportsStt: isSttModel(model.id),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/fine_tuning/jobs` — verified 2026-07-29 against openapi.yaml
   * v2.3.0 (`listPaginatedFineTuningJobs`). The response carries `has_more` but
   * no `last_id`, so the cursor comes off the final element.
   */
  private async listFineTuningJobs(accountId: string): Promise<ResourceInstance[]> {
    const jobs = await this.listAll<FineTuningJob>("/fine_tuning/jobs", {});
    const now = new Date().toISOString();
    return jobs.map((job) => this.mapFineTuningJob(accountId, job, now));
  }

  private mapFineTuningJob(accountId: string, job: FineTuningJob, now: string): ResourceInstance {
    const created = isoOf(job.created_at);
    return {
      id: `${accountId}:fine-tuning-job:${job.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "fine-tuning-job",
      accountId,
      displayName: job.fine_tuned_model || job.id,
      externalId: job.id,
      fields: {
        model: str(job.model),
        status: str(job.status),
        fineTunedModel: str(job.fine_tuned_model),
        trainingFile: str(job.training_file),
        validationFile: str(job.validation_file),
        trainedTokens: num(job.trained_tokens) ?? 0,
        method: str(job.method?.type),
        seed: num(job.seed) ?? 0,
        createdAt: created,
        finishedAt: isoOf(job.finished_at),
        estimatedFinish: isoOf(job.estimated_finish),
        errorMessage: str(job.error?.message),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/batches` — verified 2026-07-29 against openapi.yaml v2.3.0
   * (`listBatches`). `limit` caps at 100.
   */
  private async listBatches(accountId: string): Promise<ResourceInstance[]> {
    const batches = await this.listAll<Batch>("/batches", {});
    const now = new Date().toISOString();
    return batches.map((batch) => this.mapBatch(accountId, batch, now));
  }

  private mapBatch(accountId: string, batch: Batch, now: string): ResourceInstance {
    const created = isoOf(batch.created_at);
    return {
      id: `${accountId}:batch:${batch.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "batch",
      accountId,
      displayName: batch.id,
      externalId: batch.id,
      fields: {
        status: str(batch.status),
        endpoint: str(batch.endpoint),
        model: str(batch.model),
        inputFileId: str(batch.input_file_id),
        outputFileId: str(batch.output_file_id),
        errorFileId: str(batch.error_file_id),
        completionWindow: str(batch.completion_window),
        requestsTotal: num(batch.request_counts?.total) ?? 0,
        requestsCompleted: num(batch.request_counts?.completed) ?? 0,
        requestsFailed: num(batch.request_counts?.failed) ?? 0,
        createdAt: created,
        completedAt: isoOf(batch.completed_at),
        expiresAt: isoOf(batch.expires_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/files` — verified 2026-07-29 against openapi.yaml v2.3.0
   * (`listFiles`). `limit` accepts up to 10,000; 1,000 per page keeps
   * individual responses small without needing many round-trips.
   */
  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const files = await this.listAll<OpenAIFile>("/files", { order: "desc" }, { pageSize: 1000 });
    const now = new Date().toISOString();
    return files.map((file) => this.mapFile(accountId, file, now));
  }

  private mapFile(accountId: string, file: OpenAIFile, now: string): ResourceInstance {
    const created = isoOf(file.created_at);
    return {
      id: `${accountId}:file:${file.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "file",
      accountId,
      displayName: file.filename || file.id,
      externalId: file.id,
      fields: {
        filename: str(file.filename),
        purpose: str(file.purpose),
        bytes: num(file.bytes) ?? 0,
        createdAt: created,
        expiresAt: isoOf(file.expires_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /** `GET /v1/vector_stores` — verified 2026-07-29 (`listVectorStores`). */
  private async listVectorStores(accountId: string): Promise<ResourceInstance[]> {
    const stores = await this.listAll<VectorStore>("/vector_stores", { order: "desc" });
    const now = new Date().toISOString();
    return stores.map((store) => this.mapVectorStore(accountId, store, now));
  }

  private mapVectorStore(accountId: string, store: VectorStore, now: string): ResourceInstance {
    const created = isoOf(store.created_at);
    return {
      id: `${accountId}:vector-store:${store.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "vector-store",
      accountId,
      displayName: store.name || store.id,
      externalId: store.id,
      fields: {
        name: str(store.name),
        status: str(store.status),
        usageBytes: num(store.usage_bytes) ?? 0,
        filesTotal: num(store.file_counts?.total) ?? 0,
        filesCompleted: num(store.file_counts?.completed) ?? 0,
        filesInProgress: num(store.file_counts?.in_progress) ?? 0,
        filesFailed: num(store.file_counts?.failed) ?? 0,
        createdAt: created,
        lastActiveAt: isoOf(store.last_active_at),
        expiresAt: isoOf(store.expires_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /** `GET /v1/containers` — verified 2026-07-29 (`ListContainers`). */
  private async listContainers(accountId: string): Promise<ResourceInstance[]> {
    const containers = await this.listAll<Container>("/containers", { order: "desc" });
    const now = new Date().toISOString();
    return containers.map((container) => this.mapContainer(accountId, container, now));
  }

  private mapContainer(accountId: string, container: Container, now: string): ResourceInstance {
    const created = isoOf(container.created_at);
    const policy = container.network_policy;
    return {
      id: `${accountId}:container:${container.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "container",
      accountId,
      displayName: container.name || container.id,
      externalId: container.id,
      fields: {
        name: str(container.name),
        status: str(container.status),
        memoryLimit: str(container.memory_limit),
        expiresAfterMinutes: num(container.expires_after?.minutes) ?? 0,
        networkPolicy:
          policy?.type === "allowlist"
            ? `allowlist: ${(policy.allowed_domains ?? []).join(", ") || "none"}`
            : str(policy?.type),
        createdAt: created,
        lastActiveAt: isoOf(container.last_active_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /** `GET /v1/evals` — verified 2026-07-29 (`listEvals`). */
  private async listEvals(accountId: string): Promise<ResourceInstance[]> {
    const evals = await this.listAll<EvalObject>("/evals", { order: "desc" });
    const now = new Date().toISOString();
    return evals.map((item) => this.mapEval(accountId, item, now));
  }

  private mapEval(accountId: string, item: EvalObject, now: string): ResourceInstance {
    const created = isoOf(item.created_at);
    return {
      id: `${accountId}:eval:${item.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "eval",
      accountId,
      displayName: item.name || item.id,
      externalId: item.id,
      fields: {
        name: str(item.name),
        dataSourceType: str(item.data_source_config?.type),
        testingCriteria: (item.testing_criteria ?? []).length,
        createdAt: created,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/organization/projects` — verified 2026-07-29 (`list-projects`).
   * Archived projects are hidden unless `include_archived=true`; keeping them
   * visible matters because their historical usage still shows up in costs.
   */
  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetchProjects();
    const now = new Date().toISOString();
    return projects.map((project) => this.mapProject(accountId, project, now));
  }

  private async fetchProjects(): Promise<Project[]> {
    return this.listAll<Project>(
      "/organization/projects",
      { include_archived: "true" },
      { admin: true },
    );
  }

  private mapProject(accountId: string, project: Project, now: string): ResourceInstance {
    const created = isoOf(project.created_at);
    return {
      id: `${accountId}:project:${project.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "project",
      accountId,
      displayName: project.name || project.id,
      externalId: project.id,
      fields: {
        name: str(project.name),
        status: str(project.status),
        createdAt: created,
        archivedAt: isoOf(project.archived_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/organization/projects/{project_id}/api_keys` — verified
   * 2026-07-29 (`list-project-api-keys`). Keys are only addressable per
   * project, so this fans out over the non-archived projects.
   */
  private async listProjectApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const projects = (await this.fetchProjects()).filter((p) => p.status !== "archived");
    const now = new Date().toISOString();

    const pages = await Promise.all(
      projects.map(async (project) => {
        const keys = await this.listAll<ProjectApiKey>(
          `/organization/projects/${encodeURIComponent(project.id)}/api_keys`,
          {},
          { admin: true },
        );
        return keys.map((key) =>
          this.mapProjectApiKey(accountId, project.id, str(project.name), key, now),
        );
      }),
    );

    return pages.flat();
  }

  private mapProjectApiKey(
    accountId: string,
    projectId: string,
    projectName: string,
    key: ProjectApiKey,
    now: string,
  ): ResourceInstance {
    const created = isoOf(key.created_at);
    const owner = key.owner;
    const ownerName =
      owner?.type === "service_account"
        ? str(owner.service_account?.name)
        : str(owner?.user?.name || owner?.user?.email);
    return {
      id: `${accountId}:project-api-key:${projectId}:${key.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "project-api-key",
      accountId,
      parentResourceId: `${accountId}:project:${projectId}`,
      displayName: key.name || key.id,
      externalId: `${projectId}:${key.id}`,
      fields: {
        name: str(key.name),
        redactedValue: str(key.redacted_value),
        projectId,
        projectName,
        ownerType: str(owner?.type),
        ownerName,
        ownerProjectAccess: str(key.owner_project_access),
        createdAt: created,
        lastUsedAt: isoOf(key.last_used_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /** `GET /v1/organization/users` — verified 2026-07-29 (`list-users`). */
  private async listOrganizationUsers(accountId: string): Promise<ResourceInstance[]> {
    const users = await this.listAll<OrganizationUser>("/organization/users", {}, { admin: true });
    const now = new Date().toISOString();
    return users.map((user) => this.mapOrganizationUser(accountId, user, now));
  }

  private mapOrganizationUser(
    accountId: string,
    user: OrganizationUser,
    now: string,
  ): ResourceInstance {
    const added = isoOf(user.added_at);
    return {
      id: `${accountId}:organization-user:${user.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "organization-user",
      accountId,
      displayName: user.name || user.email || user.id,
      externalId: user.id,
      fields: {
        name: str(user.name),
        email: str(user.email),
        role: str(user.role),
        addedAt: added,
        isServiceAccount: user.is_service_account === true,
        isScimManaged: user.is_scim_managed === true,
        apiKeyLastUsedAt: isoOf(user.api_key_last_used_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: added || now,
      updatedAt: now,
    };
  }

  /** `GET /v1/organization/invites` — verified 2026-07-29 (`list-invites`). */
  private async listInvites(accountId: string): Promise<ResourceInstance[]> {
    const invites = await this.listAll<Invite>("/organization/invites", {}, { admin: true });
    const now = new Date().toISOString();
    return invites.map((invite) => this.mapInvite(accountId, invite, now));
  }

  private mapInvite(accountId: string, invite: Invite, now: string): ResourceInstance {
    const created = isoOf(invite.created_at);
    return {
      id: `${accountId}:invite:${invite.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "invite",
      accountId,
      displayName: invite.email || invite.id,
      externalId: invite.id,
      fields: {
        email: str(invite.email),
        role: str(invite.role),
        status: str(invite.status),
        projects: (invite.projects ?? []).map((p) => `${str(p.id)} (${str(p.role)})`).join(", "),
        createdAt: created,
        expiresAt: isoOf(invite.expires_at),
        acceptedAt: isoOf(invite.accepted_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  // ---- Single-resource reads -----------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    const id = encodeURIComponent(externalId);
    const now = new Date().toISOString();

    switch (typeId) {
      case "model":
        return this.mapModel(accountId, await this.fetch<OpenAIModel>(`/models/${id}`), now);
      case "fine-tuning-job":
        return this.mapFineTuningJob(
          accountId,
          await this.fetch<FineTuningJob>(`/fine_tuning/jobs/${id}`),
          now,
        );
      case "batch":
        return this.mapBatch(accountId, await this.fetch<Batch>(`/batches/${id}`), now);
      case "file":
        return this.mapFile(accountId, await this.fetch<OpenAIFile>(`/files/${id}`), now);
      case "vector-store":
        return this.mapVectorStore(
          accountId,
          await this.fetch<VectorStore>(`/vector_stores/${id}`),
          now,
        );
      case "container":
        return this.mapContainer(accountId, await this.fetch<Container>(`/containers/${id}`), now);
      case "eval":
        return this.mapEval(accountId, await this.fetch<EvalObject>(`/evals/${id}`), now);
      case "project":
        return this.mapProject(
          accountId,
          await this.adminFetch<Project>(`/organization/projects/${id}`),
          now,
        );
      case "project-api-key": {
        const { projectId, keyId } = splitApiKeyId(externalId);
        const [key, project] = await Promise.all([
          this.adminFetch<ProjectApiKey>(
            `/organization/projects/${encodeURIComponent(projectId)}/api_keys/${encodeURIComponent(keyId)}`,
          ),
          this.adminFetch<Project>(`/organization/projects/${encodeURIComponent(projectId)}`),
        ]);
        return this.mapProjectApiKey(accountId, projectId, str(project.name), key, now);
      }
      case "organization-user":
        return this.mapOrganizationUser(
          accountId,
          await this.adminFetch<OrganizationUser>(`/organization/users/${id}`),
          now,
        );
      case "invite":
        return this.mapInvite(
          accountId,
          await this.adminFetch<Invite>(`/organization/invites/${id}`),
          now,
        );
      default:
        throw new Error(`OpenAI plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);

    // Ids are already encoded in the resource id — no round-trip needed.
    if (outputKey === "modelId" && typeId === "model") return externalId;
    if (outputKey === "jobId" && typeId === "fine-tuning-job") return externalId;
    if (outputKey === "batchId" && typeId === "batch") return externalId;
    if (outputKey === "fileId" && typeId === "file") return externalId;
    if (outputKey === "vectorStoreId" && typeId === "vector-store") return externalId;
    if (outputKey === "containerId" && typeId === "container") return externalId;
    if (outputKey === "evalId" && typeId === "eval") return externalId;
    if (outputKey === "projectId" && typeId === "project") return externalId;
    if (outputKey === "userId" && typeId === "organization-user") return externalId;
    if (outputKey === "inviteId" && typeId === "invite") return externalId;
    if (typeId === "project-api-key") {
      const { projectId, keyId } = splitApiKeyId(externalId);
      if (outputKey === "apiKeyId") return keyId;
      if (outputKey === "projectId") return projectId;
    }

    const resource = await this.getResource(typeId, resourceId, accountId);
    const fieldKey = OUTPUT_FIELD_MAP[`${typeId}:${outputKey}`];
    if (fieldKey) return str(resource.fields[fieldKey]);

    throw new Error(`OpenAI plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "fine-tuning-job":
        return [
          { label: "Status", value: dash(f["status"]), variant: statVariant(f["status"]) },
          { label: "Base Model", value: dash(f["model"]) },
          { label: "Trained Tokens", value: (num(f["trainedTokens"]) ?? 0).toLocaleString() },
        ];
      case "batch":
        return [
          { label: "Status", value: dash(f["status"]), variant: statVariant(f["status"]) },
          {
            label: "Requests",
            value: `${num(f["requestsCompleted"]) ?? 0} / ${num(f["requestsTotal"]) ?? 0}`,
          },
          { label: "Failed", value: String(num(f["requestsFailed"]) ?? 0) },
        ];
      case "vector-store":
        return [
          { label: "Status", value: dash(f["status"]), variant: statVariant(f["status"]) },
          { label: "Files", value: String(num(f["filesTotal"]) ?? 0) },
          { label: "Storage", value: formatBytes(f["usageBytes"]) },
        ];
      case "file":
        return [
          { label: "Purpose", value: dash(f["purpose"]) },
          { label: "Size", value: formatBytes(f["bytes"]) },
        ];
      case "project":
        return [
          { label: "Status", value: dash(f["status"]), variant: statVariant(f["status"]) },
          { label: "Created", value: dash(f["createdAt"]).slice(0, 10) },
        ];
      default:
        return [];
    }
  }

  // ---- Detail rendering ----------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "model":
        return this.renderModelDetail(resource);
      case "fine-tuning-job":
        return this.renderFineTuningJobDetail(resource);
      case "batch":
        return this.renderBatchDetail(resource);
      case "file":
        return this.renderFileDetail(resource);
      case "vector-store":
        return this.renderVectorStoreDetail(resource);
      case "container":
        return this.renderContainerDetail(resource);
      case "eval":
        return this.renderEvalDetail(resource);
      case "project":
        return this.renderProjectDetail(resource);
      case "project-api-key":
        return this.renderProjectApiKeyDetail(resource);
      case "organization-user":
        return this.renderOrganizationUserDetail(resource);
      case "invite":
        return this.renderInviteDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
          sections: [],
          headerActions: refreshAction(),
        };
    }
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const modelId = str(resource.fields["modelId"]) || resource.displayName;
    const isFineTuned = resource.fields["isFineTuned"] === true;
    const speechCapable = isTtsModel(modelId) || isSttModel(modelId);

    const headerActions = [...refreshAction()];
    if (isFineTuned) {
      headerActions.push({
        kind: "action",
        label: "Delete fine-tuned model",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "delete-fine-tuned-model",
          confirmMessage: `Permanently delete ${modelId}? Anything still calling this model id will start failing. Only fine-tuned models can be deleted, and only by an organization Owner.`,
          successMessage: "Fine-tuned model deleted.",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle: isFineTuned ? "OpenAI fine-tuned model" : "OpenAI model",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        section("Model", [
          { key: "Model ID", value: modelId, copyable: true },
          { key: "Owned By", value: dash(resource.fields["ownedBy"]) },
          { key: "Created", value: dash(resource.fields["created"]) },
          { key: "Fine-tuned", value: isFineTuned ? "Yes" : "No" },
        ]),
        section("Speech support", [
          {
            key: "Text-to-speech",
            value: isTtsModel(modelId) ? "Yes — /v1/audio/speech" : "No",
          },
          {
            key: "Transcription",
            value: isSttModel(modelId) ? "Yes — /v1/audio/transcriptions" : "No",
          },
        ]),
      ],
      headerActions,
      metricsCapability: { defaultTimeRangeMs: 7 * 24 * 60 * 60 * 1000 },
      speechPanel: {
        modes: ["tts", "stt"],
        tabLabel: "Speech",
        subtitle: speechCapable
          ? `${modelId} · mp3 out, 4,096 characters per request · 25 MB per clip in`
          : `${modelId} can't do audio — pick a speech model below to try synthesis or transcription`,
        helpText:
          "One model picker drives both halves. Synthesis falls back to gpt-4o-mini-tts and transcription to gpt-4o-transcribe when the selected model can't do that half. Word timings only come back from whisper-1; speaker labels only from gpt-4o-transcribe-diarize.",
        voices: TTS_VOICES,
        defaultVoice: DEFAULT_VOICE,
        voiceLabel: "Voice",
        models: SPEECH_MODELS,
        defaultModel: speechCapable ? modelId : DEFAULT_TTS_MODEL,
        modelLabel: "Model",
        languages: STT_LANGUAGES,
        defaultLanguage: AUTO_LANGUAGE,
        languageLabel: "Language",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        maxCharacters: MAX_TTS_CHARACTERS,
        maxAudioBytes: MAX_AUDIO_BYTES,
        synthesizeLabel: "Synthesize",
        transcribeLabel: "Transcribe",
      },
    };
  }

  private renderFineTuningJobDetail(resource: ResourceInstance): DetailViewSchema {
    const status = str(resource.fields["status"]);
    const terminal = ["succeeded", "failed", "cancelled"].includes(status);
    const error = str(resource.fields["errorMessage"]);

    const headerActions = [...refreshAction()];
    if (!terminal) {
      headerActions.push(
        {
          kind: "action",
          label: "Pause",
          action: {
            type: "plugin-action",
            actionId: "pause-fine-tuning-job",
            successMessage: "Fine-tuning job paused.",
          },
        },
        {
          kind: "action",
          label: "Resume",
          action: {
            type: "plugin-action",
            actionId: "resume-fine-tuning-job",
            successMessage: "Fine-tuning job resumed.",
          },
        },
        {
          kind: "action",
          label: "Cancel",
          variant: "danger",
          action: {
            type: "plugin-action",
            actionId: "cancel-fine-tuning-job",
            confirmMessage:
              "Cancel this fine-tuning job? Tokens already trained are still billed and the run cannot be restarted.",
            successMessage: "Fine-tuning job cancelled.",
          },
        },
      );
    }

    const sections: SectionNode[] = [
      section("Run", [
        { key: "Job ID", value: resource.externalId ?? resource.id, copyable: true },
        { key: "Status", value: dash(status) },
        { key: "Base Model", value: dash(resource.fields["model"]) },
        { key: "Fine-tuned Model", value: dash(resource.fields["fineTunedModel"]), copyable: true },
        { key: "Method", value: dash(resource.fields["method"]) },
        { key: "Seed", value: dash(resource.fields["seed"]) },
      ]),
      section("Data", [
        { key: "Training File", value: dash(resource.fields["trainingFile"]) },
        { key: "Validation File", value: dash(resource.fields["validationFile"]) },
        {
          key: "Trained Tokens",
          value: (num(resource.fields["trainedTokens"]) ?? 0).toLocaleString(),
        },
      ]),
      section("Timeline", [
        { key: "Created", value: dash(resource.fields["createdAt"]) },
        { key: "Estimated Finish", value: dash(resource.fields["estimatedFinish"]) },
        { key: "Finished", value: dash(resource.fields["finishedAt"]) },
      ]),
    ];

    if (error) sections.push(section("Failure", [{ key: "Error", value: error }]));

    return {
      title: resource.displayName,
      subtitle: `OpenAI fine-tuning job · ${dash(resource.fields["model"])}`,
      status: statusDot(status),
      sections,
      headerActions,
    };
  }

  private renderBatchDetail(resource: ResourceInstance): DetailViewSchema {
    const status = str(resource.fields["status"]);
    const cancellable = ["validating", "in_progress", "finalizing"].includes(status);

    const headerActions = [...refreshAction()];
    if (cancellable) {
      headerActions.push({
        kind: "action",
        label: "Cancel batch",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "cancel-batch",
          confirmMessage:
            "Cancel this batch? Requests that already completed stay billed and their output file is still produced.",
          successMessage: "Batch cancellation requested.",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle: `OpenAI batch · ${dash(resource.fields["endpoint"])}`,
      status: statusDot(status),
      sections: [
        section("Batch", [
          { key: "Batch ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Status", value: dash(status) },
          { key: "Endpoint", value: dash(resource.fields["endpoint"]) },
          { key: "Model", value: dash(resource.fields["model"]) },
          { key: "Completion Window", value: dash(resource.fields["completionWindow"]) },
        ]),
        section("Progress", [
          { key: "Total Requests", value: String(num(resource.fields["requestsTotal"]) ?? 0) },
          { key: "Completed", value: String(num(resource.fields["requestsCompleted"]) ?? 0) },
          { key: "Failed", value: String(num(resource.fields["requestsFailed"]) ?? 0) },
        ]),
        section("Files", [
          { key: "Input File", value: dash(resource.fields["inputFileId"]), copyable: true },
          { key: "Output File", value: dash(resource.fields["outputFileId"]), copyable: true },
          { key: "Error File", value: dash(resource.fields["errorFileId"]), copyable: true },
        ]),
        section("Timeline", [
          { key: "Created", value: dash(resource.fields["createdAt"]) },
          { key: "Completed", value: dash(resource.fields["completedAt"]) },
          { key: "Expires", value: dash(resource.fields["expiresAt"]) },
        ]),
      ],
      headerActions,
    };
  }

  private renderFileDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: `OpenAI file · ${dash(resource.fields["purpose"])}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        section("File", [
          { key: "File ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Filename", value: dash(resource.fields["filename"]) },
          { key: "Purpose", value: dash(resource.fields["purpose"]) },
          { key: "Size", value: formatBytes(resource.fields["bytes"]) },
          { key: "Created", value: dash(resource.fields["createdAt"]) },
          { key: "Expires", value: dash(resource.fields["expiresAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderVectorStoreDetail(resource: ResourceInstance): DetailViewSchema {
    const status = str(resource.fields["status"]);
    return {
      title: resource.displayName,
      subtitle: "OpenAI vector store",
      status: statusDot(status),
      sections: [
        section("Store", [
          { key: "Vector Store ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Name", value: dash(resource.fields["name"]) },
          { key: "Status", value: dash(status) },
          { key: "Storage Used", value: formatBytes(resource.fields["usageBytes"]) },
        ]),
        section("Files", [
          { key: "Total", value: String(num(resource.fields["filesTotal"]) ?? 0) },
          { key: "Ready", value: String(num(resource.fields["filesCompleted"]) ?? 0) },
          { key: "Processing", value: String(num(resource.fields["filesInProgress"]) ?? 0) },
          { key: "Failed", value: String(num(resource.fields["filesFailed"]) ?? 0) },
        ]),
        section("Timeline", [
          { key: "Created", value: dash(resource.fields["createdAt"]) },
          { key: "Last Active", value: dash(resource.fields["lastActiveAt"]) },
          { key: "Expires", value: dash(resource.fields["expiresAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderContainerDetail(resource: ResourceInstance): DetailViewSchema {
    const status = str(resource.fields["status"]);
    return {
      title: resource.displayName,
      subtitle: "OpenAI code-interpreter container",
      status: statusDot(status),
      sections: [
        section("Container", [
          { key: "Container ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Name", value: dash(resource.fields["name"]) },
          { key: "Status", value: dash(status) },
          { key: "Memory Limit", value: dash(resource.fields["memoryLimit"]) },
          { key: "Network Policy", value: dash(resource.fields["networkPolicy"]) },
          {
            key: "Idle Expiry",
            value: (() => {
              const minutes = num(resource.fields["expiresAfterMinutes"]) ?? 0;
              return minutes > 0 ? `${minutes} minutes after last activity` : "—";
            })(),
          },
        ]),
        section("Timeline", [
          { key: "Created", value: dash(resource.fields["createdAt"]) },
          { key: "Last Active", value: dash(resource.fields["lastActiveAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderEvalDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: "OpenAI eval",
      status: { kind: "status-dot", status: "info" },
      sections: [
        section("Eval", [
          { key: "Eval ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Name", value: dash(resource.fields["name"]) },
          { key: "Data Source", value: dash(resource.fields["dataSourceType"]) },
          { key: "Graders", value: String(num(resource.fields["testingCriteria"]) ?? 0) },
          { key: "Created", value: dash(resource.fields["createdAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderProjectDetail(resource: ResourceInstance): DetailViewSchema {
    const status = str(resource.fields["status"]);
    const headerActions = [...refreshAction()];
    if (status !== "archived") {
      headerActions.push({
        kind: "action",
        label: "Archive project",
        variant: "danger",
        action: {
          type: "plugin-action",
          actionId: "archive-project",
          confirmMessage:
            "Archive this project? OpenAI has no delete for projects and no unarchive — every API key scoped to it stops working.",
          successMessage: "Project archived.",
        },
      });
    }

    return {
      title: resource.displayName,
      subtitle: "OpenAI project",
      status: { kind: "status-dot", status: statusOf(status || "active") },
      sections: [
        section("Project", [
          { key: "Project ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Name", value: dash(resource.fields["name"]) },
          { key: "Status", value: dash(status) },
          { key: "Created", value: dash(resource.fields["createdAt"]) },
          { key: "Archived", value: dash(resource.fields["archivedAt"]) },
        ]),
        {
          kind: "section",
          title: "API keys",
          children: [
            {
              kind: "text",
              variant: "muted",
              content:
                "User-owned project keys can be listed and revoked through the API but never created. Use “Get credentials” to create a service account in this project and mint its key — that value is shown once and cannot be re-read.",
            },
          ],
        },
      ],
      headerActions,
      metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
    };
  }

  private renderProjectApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: `OpenAI project API key · ${dash(resource.fields["projectName"])}`,
      status: {
        kind: "status-dot",
        status: resource.fields["ownerProjectAccess"] === "inactive" ? "degraded" : "healthy",
      },
      sections: [
        section("Key", [
          { key: "Name", value: dash(resource.fields["name"]) },
          { key: "Redacted Value", value: dash(resource.fields["redactedValue"]) },
          { key: "Owner", value: dash(resource.fields["ownerName"]) },
          { key: "Owner Type", value: dash(resource.fields["ownerType"]) },
          { key: "Owner Access", value: dash(resource.fields["ownerProjectAccess"]) },
        ]),
        section("Project", [
          { key: "Project", value: dash(resource.fields["projectName"]) },
          { key: "Project ID", value: dash(resource.fields["projectId"]), copyable: true },
        ]),
        section("Usage", [
          { key: "Created", value: dash(resource.fields["createdAt"]) },
          { key: "Last Used", value: dash(resource.fields["lastUsedAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderOrganizationUserDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle: `OpenAI organization member · ${dash(resource.fields["role"])}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        section("Member", [
          { key: "User ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Name", value: dash(resource.fields["name"]) },
          { key: "Email", value: dash(resource.fields["email"]) },
          { key: "Role", value: dash(resource.fields["role"]) },
          { key: "Added", value: dash(resource.fields["addedAt"]) },
        ]),
        section("Account type", [
          {
            key: "Service Account",
            value: resource.fields["isServiceAccount"] === true ? "Yes" : "No",
          },
          {
            key: "SCIM Managed",
            value: resource.fields["isScimManaged"] === true ? "Yes" : "No",
          },
          { key: "API Key Last Used", value: dash(resource.fields["apiKeyLastUsedAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderInviteDetail(resource: ResourceInstance): DetailViewSchema {
    const status = str(resource.fields["status"]);
    return {
      title: resource.displayName,
      subtitle: `OpenAI invite · ${dash(resource.fields["role"])}`,
      status: statusDot(status),
      sections: [
        section("Invite", [
          { key: "Invite ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Email", value: dash(resource.fields["email"]) },
          { key: "Role", value: dash(resource.fields["role"]) },
          { key: "Status", value: dash(status) },
          { key: "Projects", value: dash(resource.fields["projects"]) },
        ]),
        section("Timeline", [
          { key: "Sent", value: dash(resource.fields["createdAt"]) },
          { key: "Expires", value: dash(resource.fields["expiresAt"]) },
          { key: "Accepted", value: dash(resource.fields["acceptedAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const status =
      resource.resourceTypeId === "model" || resource.resourceTypeId === "file"
        ? "healthy"
        : statusOf(resource.fields["status"]);
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  // ---- Create / update / delete -------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "fine-tuning-job": {
        const [models, files] = await Promise.all([
          this.fetch<{ data?: OpenAIModel[] }>("/models"),
          this.listAll<OpenAIFile>(
            "/files",
            { purpose: "fine-tune", order: "desc" },
            {
              pageSize: 1000,
              maxPages: 3,
            },
          ),
        ]);
        // Only base models can be fine-tuned; a fine-tuned snapshot is `ft:…`.
        const baseModels = (models.data ?? [])
          .filter((m) => !m.id.startsWith("ft:"))
          .map((m) => ({ id: m.id, label: m.id }))
          .sort((a, b) => a.id.localeCompare(b.id));
        const fileOptions = files.map((f) => ({
          id: f.id,
          label: `${f.filename ?? f.id} (${formatBytes(f.bytes)})`,
        }));
        return {
          fields: [
            {
              key: "model",
              label: "Base Model",
              kind: "select",
              required: true,
              options: baseModels,
              description: "Model to fine-tune. Not every base model is eligible.",
              ...(baseModels[0] ? { defaultValue: baseModels[0].id } : {}),
            },
            {
              key: "training_file",
              label: "Training File",
              kind: "select",
              required: true,
              options: fileOptions,
              description:
                "A JSONL file already uploaded with purpose `fine-tune`. Upload one from the OpenAI dashboard if the list is empty.",
              ...(fileOptions[0] ? { defaultValue: fileOptions[0].id } : {}),
            },
            {
              key: "validation_file",
              label: "Validation File",
              kind: "select",
              required: false,
              options: [{ id: "", label: "None" }, ...fileOptions],
              defaultValue: "",
            },
            {
              key: "suffix",
              label: "Model Name Suffix",
              kind: "text",
              required: false,
              description: "Appended to the resulting model id. Up to 64 characters.",
              placeholder: "support-bot",
            },
            {
              key: "seed",
              label: "Seed",
              kind: "number",
              required: false,
              description: "Set for reproducible runs. Left blank, OpenAI picks one.",
            },
          ],
        };
      }

      case "batch": {
        const files = await this.listAll<OpenAIFile>(
          "/files",
          { purpose: "batch", order: "desc" },
          { pageSize: 1000, maxPages: 3 },
        );
        const fileOptions = files.map((f) => ({
          id: f.id,
          label: `${f.filename ?? f.id} (${formatBytes(f.bytes)})`,
        }));
        return {
          fields: [
            {
              key: "input_file_id",
              label: "Input File",
              kind: "select",
              required: true,
              options: fileOptions,
              description: "A JSONL file uploaded with purpose `batch`, up to 200 MB.",
              ...(fileOptions[0] ? { defaultValue: fileOptions[0].id } : {}),
            },
            {
              key: "endpoint",
              label: "Endpoint",
              kind: "select",
              required: true,
              defaultValue: "/v1/chat/completions",
              options: [
                { id: "/v1/responses", label: "/v1/responses" },
                { id: "/v1/chat/completions", label: "/v1/chat/completions" },
                { id: "/v1/embeddings", label: "/v1/embeddings" },
                { id: "/v1/completions", label: "/v1/completions" },
                { id: "/v1/moderations", label: "/v1/moderations" },
                { id: "/v1/images/generations", label: "/v1/images/generations" },
                { id: "/v1/images/edits", label: "/v1/images/edits" },
                { id: "/v1/videos", label: "/v1/videos" },
              ],
              description: "Every request in the file must target this endpoint.",
            },
            {
              key: "completion_window",
              label: "Completion Window",
              kind: "select",
              required: true,
              defaultValue: "24h",
              options: [{ id: "24h", label: "24 hours" }],
              description: "24h is the only window the API accepts today.",
            },
          ],
        };
      }

      case "vector-store":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "support-faq",
            },
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: false,
              placeholder: "What this store is for",
            },
            {
              key: "expires_after_days",
              label: "Expire After (days idle)",
              kind: "number",
              required: false,
              minValue: 1,
              maxValue: 365,
              description:
                "Deletes the store this many days after it was last used. Leave blank to keep it forever.",
            },
          ],
        };

      case "container":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "analysis-sandbox",
            },
            {
              key: "memory_limit",
              label: "Memory Limit",
              kind: "select",
              required: false,
              defaultValue: "1g",
              options: [
                { id: "1g", label: "1 GB" },
                { id: "4g", label: "4 GB" },
                { id: "16g", label: "16 GB" },
                { id: "64g", label: "64 GB" },
              ],
            },
            {
              key: "expires_after_minutes",
              label: "Idle Expiry (minutes)",
              kind: "number",
              required: false,
              minValue: 1,
              description: "Minutes of inactivity before the container is torn down.",
            },
          ],
        };

      case "project":
        return {
          fields: [
            {
              key: "name",
              label: "Project Name",
              kind: "text",
              required: true,
              description:
                "Appears in usage and cost reports. Projects can be archived, never deleted.",
              placeholder: "production",
            },
          ],
        };

      case "invite": {
        const projects = this.hasAdminKey
          ? (await this.fetchProjects()).filter((p) => p.status !== "archived")
          : [];
        const projectOptions = [
          { id: "", label: "Default project" },
          ...projects.map((p) => ({ id: p.id, label: p.name || p.id })),
        ];
        return {
          fields: [
            {
              key: "email",
              label: "Email",
              kind: "text",
              required: true,
              placeholder: "teammate@example.com",
            },
            {
              key: "role",
              label: "Organization Role",
              kind: "select",
              required: true,
              defaultValue: "reader",
              options: [
                { id: "reader", label: "Reader" },
                { id: "owner", label: "Owner" },
              ],
            },
            {
              key: "project_id",
              label: "Grant Access To",
              kind: "select",
              required: false,
              defaultValue: parentProjectId(parentResourceId) ?? "",
              options: projectOptions,
              description:
                "Project membership granted the moment the invite is accepted. Leave on the default project to keep OpenAI's legacy behaviour.",
            },
            {
              key: "project_role",
              label: "Project Role",
              kind: "select",
              required: false,
              defaultValue: "member",
              options: [
                { id: "member", label: "Member" },
                { id: "owner", label: "Owner" },
              ],
              showWhen: { fieldKey: "project_id", fieldValuesNot: [""] },
            },
          ],
        };
      }

      default:
        throw new Error(`OpenAI plugin: no create config for type "${typeId}"`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const now = new Date().toISOString();

    switch (typeId) {
      case "fine-tuning-job": {
        // POST /v1/fine_tuning/jobs — verified 2026-07-29 (`createFineTuningJob`).
        const seed = num(fields["seed"]);
        const body: Record<string, unknown> = {
          model: fields["model"],
          training_file: fields["training_file"],
          ...(fields["validation_file"] ? { validation_file: fields["validation_file"] } : {}),
          ...(fields["suffix"] ? { suffix: fields["suffix"] } : {}),
          ...(seed !== undefined ? { seed } : {}),
        };
        const job = await this.fetch<FineTuningJob>("/fine_tuning/jobs", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return this.mapFineTuningJob(accountId, job, now);
      }

      case "batch": {
        // POST /v1/batches — verified 2026-07-29 (`createBatch`).
        const batch = await this.fetch<Batch>("/batches", {
          method: "POST",
          body: JSON.stringify({
            input_file_id: fields["input_file_id"],
            endpoint: fields["endpoint"],
            completion_window: fields["completion_window"] || "24h",
          }),
        });
        return this.mapBatch(accountId, batch, now);
      }

      case "vector-store": {
        // POST /v1/vector_stores — verified 2026-07-29 (`createVectorStore`).
        const days = num(fields["expires_after_days"]);
        const store = await this.fetch<VectorStore>("/vector_stores", {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"],
            ...(fields["description"] ? { description: fields["description"] } : {}),
            ...(days !== undefined && days > 0
              ? { expires_after: { anchor: "last_active_at", days } }
              : {}),
          }),
        });
        return this.mapVectorStore(accountId, store, now);
      }

      case "container": {
        // POST /v1/containers — verified 2026-07-29 (`CreateContainer`).
        const minutes = num(fields["expires_after_minutes"]);
        const container = await this.fetch<Container>("/containers", {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"],
            ...(fields["memory_limit"] ? { memory_limit: fields["memory_limit"] } : {}),
            ...(minutes !== undefined && minutes > 0
              ? { expires_after: { anchor: "last_active_at", minutes } }
              : {}),
          }),
        });
        return this.mapContainer(accountId, container, now);
      }

      case "project": {
        // POST /v1/organization/projects — verified 2026-07-29 (`create-project`).
        const project = await this.adminFetch<Project>("/organization/projects", {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] }),
        });
        return this.mapProject(accountId, project, now);
      }

      case "invite": {
        // POST /v1/organization/invites — verified 2026-07-29 (`inviteUser`).
        const projectId = fields["project_id"];
        const invite = await this.adminFetch<Invite>("/organization/invites", {
          method: "POST",
          body: JSON.stringify({
            email: fields["email"],
            role: fields["role"] || "reader",
            ...(projectId
              ? { projects: [{ id: projectId, role: fields["project_role"] || "member" }] }
              : {}),
          }),
        });
        return this.mapInvite(accountId, invite, now);
      }

      default:
        throw new Error(`OpenAI plugin: cannot create type "${typeId}"`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    const id = encodeURIComponent(externalId);
    const now = new Date().toISOString();

    switch (typeId) {
      case "vector-store": {
        // POST /v1/vector_stores/{id} — verified 2026-07-29 (`modifyVectorStore`).
        const store = await this.fetch<VectorStore>(`/vector_stores/${id}`, {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] }),
        });
        return this.mapVectorStore(accountId, store, now);
      }
      case "eval": {
        // POST /v1/evals/{id} — verified 2026-07-29 (`updateEval`).
        const item = await this.fetch<EvalObject>(`/evals/${id}`, {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] }),
        });
        return this.mapEval(accountId, item, now);
      }
      case "project": {
        // POST /v1/organization/projects/{id} — verified 2026-07-29 (`modify-project`).
        const project = await this.adminFetch<Project>(`/organization/projects/${id}`, {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] }),
        });
        return this.mapProject(accountId, project, now);
      }
      case "organization-user": {
        // POST /v1/organization/users/{id} — verified 2026-07-29 (`modify-user`).
        const user = await this.adminFetch<OrganizationUser>(`/organization/users/${id}`, {
          method: "POST",
          body: JSON.stringify({ role: fields["role"] }),
        });
        return this.mapOrganizationUser(accountId, user, now);
      }
      default:
        throw new Error(`OpenAI plugin: cannot update type "${typeId}"`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    const id = encodeURIComponent(externalId);

    switch (typeId) {
      case "file":
        // DELETE /v1/files/{file_id} — verified 2026-07-29 (`deleteFile`).
        await this.fetch(`/files/${id}`, { method: "DELETE" });
        return;
      case "vector-store":
        // DELETE /v1/vector_stores/{id} — verified 2026-07-29 (`deleteVectorStore`).
        await this.fetch(`/vector_stores/${id}`, { method: "DELETE" });
        return;
      case "container":
        // DELETE /v1/containers/{id} — verified 2026-07-29 (`DeleteContainer`).
        await this.fetch(`/containers/${id}`, { method: "DELETE" });
        return;
      case "eval":
        // DELETE /v1/evals/{id} — verified 2026-07-29 (`deleteEval`).
        await this.fetch(`/evals/${id}`, { method: "DELETE" });
        return;
      case "invite":
        // DELETE /v1/organization/invites/{id} — verified 2026-07-29 (`delete-invite`).
        // Rejected once the invite has been accepted.
        await this.adminFetch(`/organization/invites/${id}`, { method: "DELETE" });
        return;
      case "organization-user":
        // DELETE /v1/organization/users/{id} — verified 2026-07-29 (`delete-user`).
        await this.adminFetch(`/organization/users/${id}`, { method: "DELETE" });
        return;
      case "project-api-key": {
        // DELETE /v1/organization/projects/{p}/api_keys/{k} — verified 2026-07-29
        // (`delete-project-api-key`). 400s when the key belongs to a service
        // account; the service account has to be removed instead.
        const { projectId, keyId } = splitApiKeyId(externalId);
        await this.adminFetch(
          `/organization/projects/${encodeURIComponent(projectId)}/api_keys/${encodeURIComponent(keyId)}`,
          { method: "DELETE" },
        );
        return;
      }
      default:
        throw new Error(`OpenAI plugin: cannot delete type "${typeId}"`);
    }
  }

  /**
   * Header actions. Everything here maps onto a verb-shaped POST that has no
   * request body.
   */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const externalId = externalIdOf(resourceId);
    const id = encodeURIComponent(externalId);

    if (typeId === "fine-tuning-job") {
      // POST /v1/fine_tuning/jobs/{id}/{cancel,pause,resume} — verified 2026-07-29.
      const verb =
        actionId === "cancel-fine-tuning-job"
          ? "cancel"
          : actionId === "pause-fine-tuning-job"
            ? "pause"
            : actionId === "resume-fine-tuning-job"
              ? "resume"
              : "";
      if (verb) {
        await this.fetch(`/fine_tuning/jobs/${id}/${verb}`, { method: "POST" });
        return;
      }
    }

    if (typeId === "batch" && actionId === "cancel-batch") {
      // POST /v1/batches/{id}/cancel — verified 2026-07-29 (`cancelBatch`).
      await this.fetch(`/batches/${id}/cancel`, { method: "POST" });
      return;
    }

    if (typeId === "model" && actionId === "delete-fine-tuned-model") {
      // DELETE /v1/models/{model} — verified 2026-07-29 (`deleteModel`). The API
      // only accepts fine-tuned model ids, so refuse locally rather than letting
      // a base model produce a confusing 4xx.
      if (!externalId.startsWith("ft:")) {
        throw new Error(
          `OpenAI plugin: "${externalId}" is a base model. Only fine-tuned models (ft:…) owned by your organization can be deleted.`,
        );
      }
      await this.fetch(`/models/${id}`, { method: "DELETE" });
      return;
    }

    if (typeId === "project" && actionId === "archive-project") {
      // POST /v1/organization/projects/{id}/archive — verified 2026-07-29.
      await this.adminFetch(`/organization/projects/${id}/archive`, { method: "POST" });
      return;
    }

    throw new Error(`OpenAI plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  /**
   * POST /v1/organization/projects/{id}/service_accounts — verified 2026-07-29
   * (`create-project-service-account`). This is the only route in the whole API
   * that hands back a usable secret key, and it does so exactly once.
   */
  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "project" || formatId !== "service-account-key") {
      throw new Error(`OpenAI plugin: no credential format "${formatId}" for type "${typeId}"`);
    }

    const projectId = externalIdOf(resourceId);
    const name = `infrawrench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
    const created = await this.adminFetch<ServiceAccountCreateResponse>(
      `/organization/projects/${encodeURIComponent(projectId)}/service_accounts`,
      { method: "POST", body: JSON.stringify({ name }) },
    );

    const value = str(created.api_key?.value);
    if (!value) {
      throw new Error(
        "OpenAI plugin: the service account was created but no API key came back. Check the project's key settings in the OpenAI dashboard.",
      );
    }

    return {
      content: value,
      filename: `openai-${projectId}-service-account-key.txt`,
      mimeType: "text/plain",
      fields: [
        { label: "Service Account", value: str(created.name) || name },
        { label: "Service Account ID", value: created.id },
        { label: "API Key ID", value: str(created.api_key?.id) },
        { label: "API Key", value, sensitive: true, hint: "Only shown once" },
      ],
      warning:
        "Save this key now. OpenAI never returns it again — the key list only ever shows a redacted value.",
    };
  }

  // ---- Metrics and costs ---------------------------------------------------

  /**
   * `GET /v1/organization/usage/completions` and `GET /v1/organization/costs` —
   * verified 2026-07-29 (`usage-completions`, `usage-costs`). `start_time` is
   * required and in Unix **seconds**; `end_time` is exclusive. Both live behind
   * the admin key.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (!this.hasAdminKey) throw new Error(ADMIN_KEY_REQUIRED);

    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 7 * 24 * 60 * 60 * 1000;
    const startTime = Math.floor(startMs / 1000);
    const endTime = Math.ceil(endMs / 1000);
    const spanDays = Math.max(1, Math.ceil((endTime - startTime) / 86400));
    const externalId = externalIdOf(resourceId);

    if (resourceTypeId === "model") {
      // `1h` buckets cap at 168, `1d` at 31 — pick whichever fits the window.
      const hourly = spanDays <= 7;
      const params = new URLSearchParams({
        start_time: String(startTime),
        end_time: String(endTime),
        bucket_width: hourly ? "1h" : "1d",
        limit: String(hourly ? Math.min(168, spanDays * 24) : Math.min(31, spanDays)),
      });
      appendAll(params, "models", [externalId]);

      const buckets = await this.listUsageBuckets("/organization/usage/completions", params);
      const input: MetricSeriesPoint[] = [];
      const output: MetricSeriesPoint[] = [];
      const requests: MetricSeriesPoint[] = [];

      for (const bucket of buckets) {
        const ts = (bucket.start_time ?? 0) * 1000;
        let inTokens = 0;
        let outTokens = 0;
        let reqs = 0;
        for (const result of bucket.results ?? []) {
          inTokens += result.input_tokens ?? 0;
          outTokens += result.output_tokens ?? 0;
          reqs += result.num_model_requests ?? 0;
        }
        input.push({ timestamp: ts, value: inTokens });
        output.push({ timestamp: ts, value: outTokens });
        requests.push({ timestamp: ts, value: reqs });
      }

      return [
        { label: "Input tokens", unit: "tokens", points: input },
        { label: "Output tokens", unit: "tokens", points: output },
        { label: "Requests", unit: "requests", points: requests },
      ];
    }

    if (resourceTypeId === "project") {
      // /organization/costs only accepts 1d buckets, limit 1–180.
      const params = new URLSearchParams({
        start_time: String(startTime),
        end_time: String(endTime),
        bucket_width: "1d",
        limit: String(Math.min(180, spanDays)),
      });
      appendAll(params, "project_ids", [externalId]);

      const buckets = await this.listUsageBuckets("/organization/costs", params);
      const points: MetricSeriesPoint[] = buckets.map((bucket) => {
        let total = 0;
        for (const result of bucket.results ?? []) total += result.amount?.value ?? 0;
        return { timestamp: (bucket.start_time ?? 0) * 1000, value: total };
      });
      return [{ label: "Cost", unit: "USD", points }];
    }

    return [];
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (!this.hasAdminKey) {
      throw new CostSetupError(
        "OpenAI cost collection needs an Admin API key. /v1/organization/costs rejects project keys with a 403, so add an admin key (sk-admin-…) to this account.",
        {
          label: "Create an admin key",
          url: "https://platform.openai.com/settings/organization/admin-keys",
        },
      );
    }

    const startTime = dayStartUnix(range.fromDate);
    const endTime = dayStartUnix(range.toDate) + 86400; // end_time is exclusive
    const days = Math.max(1, Math.round((endTime - startTime) / 86400));

    const base = new URLSearchParams({
      start_time: String(startTime),
      end_time: String(endTime),
      bucket_width: "1d",
      limit: String(Math.min(180, days)),
    });

    // Grouping turns one lump sum into a per-product breakdown. If the account
    // can't group for any reason, an ungrouped total is still worth having, so
    // fall back rather than losing the whole day's collection.
    const grouped = new URLSearchParams(base);
    appendAll(grouped, "group_by", ["line_item", "project_id"]);

    let buckets: UsageBucket[];
    try {
      buckets = await this.listUsageBuckets("/organization/costs", grouped, 20);
    } catch {
      buckets = await this.listUsageBuckets("/organization/costs", base, 20);
    }

    const rows: CostRow[] = [];
    for (const bucket of buckets) {
      const date = new Date((bucket.start_time ?? 0) * 1000).toISOString().slice(0, 10);
      for (const result of bucket.results ?? []) {
        const amount = result.amount?.value;
        if (typeof amount !== "number" || amount === 0) continue;
        rows.push({
          date,
          currency: (result.amount?.currency ?? "usd").toUpperCase(),
          amount,
          ...(result.line_item ? { service: result.line_item } : {}),
          ...(result.project_id ? { tags: { project_id: result.project_id } } : {}),
        });
      }
    }

    return rows;
  }

  // ---- Speech tab ----------------------------------------------------------

  async synthesizeSpeech(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    if (typeId !== "model") {
      throw new Error(`OpenAI plugin: cannot synthesize speech for type "${typeId}"`);
    }

    // The panel has one model dropdown for both halves, so the selection may
    // well be a transcription model. Falling back beats a 400.
    const requested = payload.modelId || externalIdOf(resourceId);
    const model = isTtsModel(requested) ? requested : DEFAULT_TTS_MODEL;
    const voice = payload.voiceId || DEFAULT_VOICE;

    const body: Record<string, unknown> = {
      model,
      input: payload.text,
      voice,
      // Explicit rather than implied: the browser has to be able to play it
      // back, and mp3 is the one container every `<audio>` element handles.
      response_format: "mp3",
    };
    // `instructions` and `stream_format` are both documented as unsupported on
    // tts-1 / tts-1-hd — sending either is a 400, not a silent no-op.
    if (!LEGACY_TTS_MODELS.has(model)) {
      body["instructions"] = "Speak clearly and naturally at a normal conversational pace.";
    }

    const started = Date.now();
    const { bytes, requestId } = await this.ttsBytes(body);
    const elapsedMs = Date.now() - started;

    const characters = payload.text.length;
    const note = isTtsModel(requested) ? "" : ` · ${requested} can't synthesize, used ${model}`;

    return {
      audioBase64: Buffer.from(bytes).toString("base64"),
      mimeType: "audio/mpeg",
      fileName: `openai-${voice}.mp3`,
      summary: `${model} · ${voice} · ${characters.toLocaleString()} characters · mp3 · ${elapsedMs} ms${note}`,
      characters,
      ...(requestId ? { requestId } : {}),
    };
  }

  async transcribeAudio(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    if (typeId !== "model") {
      throw new Error(`OpenAI plugin: cannot transcribe audio for type "${typeId}"`);
    }

    const requested = payload.modelId || externalIdOf(resourceId);
    const model = isSttModel(requested) ? requested : DEFAULT_STT_MODEL;

    // Response format is not a free choice. `verbose_json` — the only shape
    // that carries word and segment timings — is accepted by whisper-1 alone;
    // the gpt-4o transcribe family is json-only. The diarize model has its own
    // `diarized_json`, which is where speaker labels come from. Asking for a
    // format the model doesn't support is a 400, so the request is built to
    // match the model rather than hoping for graceful degradation.
    const wantsVerbose = model === VERBOSE_JSON_MODEL;
    const wantsDiarized = model === DIARIZE_MODEL;
    const responseFormat = wantsVerbose ? "verbose_json" : wantsDiarized ? "diarized_json" : "json";

    const started = Date.now();
    const result = await this.sttTranscribe(payload, model, responseFormat, wantsVerbose);
    const elapsedMs = Date.now() - started;

    const words: TranscriptWord[] = [];
    if (wantsVerbose) {
      for (const word of result.words ?? []) {
        if (typeof word.word !== "string") continue;
        words.push({
          text: word.word,
          ...(typeof word.start === "number" ? { start: word.start } : {}),
          ...(typeof word.end === "number" ? { end: word.end } : {}),
        });
      }
    }
    if (wantsDiarized) {
      for (const segment of result.segments ?? []) {
        if (typeof segment.text !== "string") continue;
        words.push({
          text: segment.text,
          ...(typeof segment.start === "number" ? { start: segment.start } : {}),
          ...(typeof segment.end === "number" ? { end: segment.end } : {}),
          ...(segment.speaker ? { speaker: segment.speaker } : {}),
        });
      }
    }

    const duration = typeof result.duration === "number" ? result.duration : result.usage?.seconds;
    const language = result.language ?? result.languages?.[0];

    const summary = [
      model,
      duration !== undefined ? `${duration.toFixed(1)} s of audio` : undefined,
      wantsVerbose && words.length > 0 ? `${words.length} word timings` : undefined,
      wantsDiarized && words.length > 0 ? `${words.length} speaker segments` : undefined,
      !wantsVerbose && !wantsDiarized
        ? "no timings — whisper-1 is the only model that returns them"
        : undefined,
      `${elapsedMs} ms`,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");

    return {
      text: str(result.text),
      summary,
      ...(language ? { language } : {}),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      ...(words.length > 0 ? { words } : {}),
    };
  }

  /**
   * POST /v1/audio/speech — verified 2026-07-29 against openapi.yaml v2.3.0
   * (`createSpeech`): JSON goes in, raw `application/octet-stream` audio comes
   * back.
   *
   * Deliberately not routed through `jsonRestFetch`. That helper JSON-parses
   * every response, and the host HTTP service it delegates to returns bodies as
   * UTF-8 strings — either of which would shred an mp3. This one call therefore
   * uses the global `fetch` and bypasses bastion egress routing and the custom
   * CA credential; every JSON control-plane call still goes through the host.
   */
  private async ttsBytes(
    body: Record<string, unknown>,
  ): Promise<{ bytes: Uint8Array; requestId?: string }> {
    const res = await fetch(`${API_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    });

    // Errors arrive as JSON where audio was expected, so branch on status
    // before touching the body.
    if (!res.ok) {
      throw new Error(`OpenAI API error ${res.status} for /audio/speech: ${await safeText(res)}`);
    }

    const requestId = headerValue(res, "x-request-id");
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      ...(requestId ? { requestId } : {}),
    };
  }

  /**
   * POST /v1/audio/transcriptions — verified 2026-07-29 (`createTranscription`).
   * multipart/form-data, which `jsonRestFetch` cannot express: its host-HTTP
   * path stringifies a FormData instead of encoding it. So this call also uses
   * the global `fetch` and bypasses bastion routing.
   *
   * The clip's content type is whatever MediaRecorder or the file picker
   * produced (`audio/webm;codecs=opus` on Chromium, `audio/mp4` on Safari) and
   * is forwarded verbatim — nothing is transcoded. Only the filename extension
   * is normalised, because the endpoint reads the format from it too.
   */
  private async sttTranscribe(
    payload: TranscribeAudioPayload,
    model: string,
    responseFormat: string,
    withTimestamps: boolean,
  ): Promise<TranscriptionResponse> {
    const bytes = new Uint8Array(Buffer.from(payload.audioBase64, "base64"));
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: payload.mimeType }),
      payload.fileName ?? audioFileName(payload.mimeType),
    );
    form.append("model", model);
    form.append("response_format", responseFormat);
    if (payload.language && payload.language !== AUTO_LANGUAGE) {
      form.append("language", payload.language);
    }
    if (withTimestamps) {
      // Repeated field, mirroring how the official SDKs encode arrays.
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
    }

    // No explicit Content-Type: fetch has to set it so the multipart boundary
    // matches the body it generated.
    const res = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(
        `OpenAI API error ${res.status} for /audio/transcriptions: ${await safeText(res)}`,
      );
    }

    return (await res.json()) as TranscriptionResponse;
  }
}

/** `project-api-key` external ids are `{projectId}:{keyId}`. */
function splitApiKeyId(externalId: string): { projectId: string; keyId: string } {
  const idx = externalId.indexOf(":");
  if (idx < 0) {
    throw new Error(
      `OpenAI plugin: malformed project API key id "${externalId}" (expected "proj_…:key_…")`,
    );
  }
  return { projectId: externalId.slice(0, idx), keyId: externalId.slice(idx + 1) };
}

/** Pull the project id out of a `{account}:project:{projectId}` parent id. */
function parentProjectId(parentResourceId?: string): string | undefined {
  if (!parentResourceId) return undefined;
  const parts = parentResourceId.split(":");
  return parts[1] === "project" ? parts.slice(2).join(":") : undefined;
}

function statVariant(status: unknown): NonNullable<DashboardStat["variant"]> {
  const mapped = statusOf(status);
  if (mapped === "healthy") return "status-healthy";
  if (mapped === "error") return "status-error";
  if (mapped === "degraded") return "status-degraded";
  return "default";
}

/** Outputs that are just a field read, keyed `{typeId}:{outputKey}`. */
const OUTPUT_FIELD_MAP: Record<string, string> = {
  "model:ownedBy": "ownedBy",
  "fine-tuning-job:fineTunedModel": "fineTunedModel",
  "fine-tuning-job:trainingFile": "trainingFile",
  "batch:outputFileId": "outputFileId",
  "batch:errorFileId": "errorFileId",
  "file:filename": "filename",
  "vector-store:name": "name",
  "container:name": "name",
  "eval:name": "name",
  "project:projectName": "name",
  "project-api-key:redactedValue": "redactedValue",
  "organization-user:email": "email",
  "invite:email": "email",
};
