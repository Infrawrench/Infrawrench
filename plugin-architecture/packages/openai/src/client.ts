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
  LogsFetchParams,
  LogsFetchResult,
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
import {
  CostSetupError,
  base64ToBytes,
  bytesToBase64,
  jsonRestFetch,
  externalIdOf,
  formatBytes,
  withAiCostTags,
} from "@infrawrench/plugin-base";
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
 * plane. Neither degrades, so rather than surfacing a bare 403 from six
 * different call sites, every admin request funnels through one guard that
 * names the missing credential.
 */
const ADMIN_KEY_REQUIRED =
  'OpenAI plugin: this needs the account\'s "Admin API key". Organization projects, members, invites, ' +
  "usage and costs live under /v1/organization/* and only an admin key (sk-admin-…) can reach them; a " +
  "project key (sk-… / sk-proj-…) gets a 403. Edit this account and paste an admin key " +
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
  residency?: string | null;
  external_key_id?: string | null;
}

interface ProjectUser {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string;
  added_at?: number;
}

interface ProjectServiceAccount {
  id: string;
  name?: string;
  role?: string;
  created_at?: number;
}

interface ProjectRateLimit {
  id: string;
  model?: string;
  max_requests_per_1_minute?: number;
  max_tokens_per_1_minute?: number;
  max_images_per_1_minute?: number;
  max_audio_megabytes_per_1_minute?: number;
  max_requests_per_1_day?: number;
  batch_1_day_max_input_tokens?: number;
}

interface SpendLimit {
  threshold_amount?: number;
  currency?: string;
  interval?: string;
  enforcement?: { status?: string } | null;
}

interface SpendAlert {
  id: string;
  threshold_amount?: number;
  currency?: string;
  interval?: string;
  notification_channel?: {
    type?: string;
    recipients?: string[];
    subject_prefix?: string | null;
  } | null;
}

interface AdminApiKey {
  id: string;
  name?: string | null;
  redacted_value?: string;
  created_at?: number;
  expires_at?: number | null;
  last_used_at?: number | null;
  owner?: { id?: string; name?: string } | null;
}

interface ServiceAccountApiKeyCreated {
  id: string;
  name?: string;
  value?: string;
  expires_at?: number | null;
}

interface ProjectApiKey {
  id: string;
  name?: string;
  redacted_value?: string;
  created_at?: number;
  expires_at?: number | null;
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
  input_cached_tokens?: number;
  input_cache_write_tokens?: number;
  output_tokens?: number;
  input_audio_tokens?: number;
  output_audio_tokens?: number;
  num_model_requests?: number;
  /** images */
  images?: number;
  /** audio_speeches */
  characters?: number;
  /** audio_transcriptions */
  seconds?: number;
  /** vector_stores */
  usage_bytes?: number;
  /** code_interpreter_sessions */
  num_sessions?: number;
  /** web_search_calls, file_search_calls */
  num_requests?: number;
}

/** One audit log entry; the event payload sits under a key named after `type`. */
interface AuditLogEntry {
  id?: string;
  type?: string;
  effective_at?: number;
  project?: { id?: string; name?: string } | null;
  actor?: {
    type?: string;
    session?: {
      user?: { id?: string; email?: string } | null;
      ip_address?: string;
    } | null;
    api_key?: {
      id?: string;
      type?: string;
      user?: { id?: string; email?: string } | null;
      service_account?: { id?: string } | null;
    } | null;
  } | null;
  [key: string]: unknown;
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

/** A byte count off the wire, or "—" when the value is not a number. */
function formatByteValue(value: unknown): string {
  const n = num(value);
  return n === undefined ? "—" : formatBytes(n);
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

/** Project residency enum values, with the label the create form shows. */
const PROJECT_RESIDENCIES: Array<{ id: string; label: string }> = [
  { id: "GLOBAL", label: "Global (default)" },
  { id: "US_STORAGE_PROCESSING", label: "United States: storage and processing" },
  { id: "EU_STORAGE_PROCESSING", label: "Europe: storage and processing" },
  { id: "JP_STORAGE", label: "Japan: storage" },
  { id: "KR_STORAGE", label: "South Korea: storage" },
  { id: "CA_STORAGE", label: "Canada: storage" },
  { id: "SG_STORAGE", label: "Singapore: storage" },
  { id: "IN_STORAGE", label: "India: storage" },
  { id: "AU_STORAGE", label: "Australia: storage" },
  { id: "GB_STORAGE", label: "United Kingdom: storage" },
  { id: "AE_STORAGE", label: "UAE: storage" },
  { id: "AE_STORAGE_PROCESSING", label: "UAE: storage and processing" },
];

/** Scope key used for organization-wide spend limits and alerts. */
const ORG_SCOPE = "organization";

/** Dollars as typed into a form → whole cents for the spend APIs. */
function dollarsToCents(value: unknown, label: string): number {
  const n = num(value);
  if (n === undefined || n < 0) throw new Error(`OpenAI plugin: ${label} must be a dollar amount`);
  return Math.round(n * 100);
}

function centsToDollars(value: unknown): number {
  return (num(value) ?? 0) / 100;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && / 404 /.test(err.message);
}

/** Comma/newline separated emails → a de-duplicated array. */
function parseRecipients(raw: unknown): string[] {
  return [
    ...new Set(
      str(raw)
        .split(/[,\n]/)
        .map((e) => e.trim())
        .filter(Boolean),
    ),
  ];
}

function dayStartUnix(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);
}

/**
 * The OpenAI SDKs serialise repeated query arrays as `k=a&k=b` (the default
 * `array_format` on `openai-python`'s Querystring) not `k[]=a`. Bracket
 * notation is only used for multipart form bodies.
 */
function appendAll(params: URLSearchParams, key: string, values: string[]): void {
  for (const value of values) params.append(key, value);
}

type UsageFilter = "models" | "project_ids" | "user_ids" | "api_key_ids" | "vector_store_ids";

interface UsageSeriesSpec {
  label: string;
  unit: string;
  pick: (result: UsageResult) => number | undefined;
}

interface UsageEndpoint {
  /** Path under `/v1/organization/usage/`. */
  path: string;
  /** The filters the endpoint accepts. */
  filters: UsageFilter[];
  series: UsageSeriesSpec[];
  /** Completions: always charted, and its errors are not swallowed. */
  core?: boolean;
}

const PER_CALLER: UsageFilter[] = ["models", "project_ids", "user_ids", "api_key_ids"];

/**
 * Every usage endpoint, its accepted filters and the counters charted from
 * it. Field names verified 2026-10-03 against the usage result schemas.
 */
const USAGE_ENDPOINTS: UsageEndpoint[] = [
  {
    path: "completions",
    filters: PER_CALLER,
    core: true,
    series: [
      { label: "Input tokens", unit: "tokens", pick: (r) => r.input_tokens },
      { label: "Cached input tokens", unit: "tokens", pick: (r) => r.input_cached_tokens },
      { label: "Output tokens", unit: "tokens", pick: (r) => r.output_tokens },
      { label: "Requests", unit: "requests", pick: (r) => r.num_model_requests },
    ],
  },
  {
    path: "embeddings",
    filters: PER_CALLER,
    series: [
      { label: "Embedding input tokens", unit: "tokens", pick: (r) => r.input_tokens },
      { label: "Embedding requests", unit: "requests", pick: (r) => r.num_model_requests },
    ],
  },
  {
    path: "moderations",
    filters: PER_CALLER,
    series: [
      { label: "Moderation input tokens", unit: "tokens", pick: (r) => r.input_tokens },
      { label: "Moderation requests", unit: "requests", pick: (r) => r.num_model_requests },
    ],
  },
  {
    path: "images",
    filters: PER_CALLER,
    series: [
      { label: "Images", unit: "images", pick: (r) => r.images },
      { label: "Image requests", unit: "requests", pick: (r) => r.num_model_requests },
    ],
  },
  {
    path: "audio_speeches",
    filters: PER_CALLER,
    series: [
      { label: "Speech characters", unit: "characters", pick: (r) => r.characters },
      { label: "Speech requests", unit: "requests", pick: (r) => r.num_model_requests },
    ],
  },
  {
    path: "audio_transcriptions",
    filters: PER_CALLER,
    series: [
      { label: "Transcribed audio", unit: "s", pick: (r) => r.seconds },
      { label: "Transcription requests", unit: "requests", pick: (r) => r.num_model_requests },
    ],
  },
  {
    path: "web_search_calls",
    filters: PER_CALLER,
    series: [{ label: "Web search calls", unit: "calls", pick: (r) => r.num_requests }],
  },
  {
    path: "file_search_calls",
    filters: ["project_ids", "user_ids", "api_key_ids", "vector_store_ids"],
    series: [{ label: "File search calls", unit: "calls", pick: (r) => r.num_requests }],
  },
  {
    path: "code_interpreter_sessions",
    filters: ["project_ids"],
    series: [{ label: "Code interpreter sessions", unit: "sessions", pick: (r) => r.num_sessions }],
  },
  {
    path: "vector_stores",
    filters: ["project_ids"],
    series: [{ label: "Vector store storage", unit: "bytes", pick: (r) => r.usage_bytes }],
  },
];

/** The completions counters past the core four, charted only when non-zero. */
const COMPLETIONS_EXTRA_SERIES: UsageSeriesSpec[] = [
  { label: "Cache write tokens", unit: "tokens", pick: (r) => r.input_cache_write_tokens },
  { label: "Audio input tokens", unit: "tokens", pick: (r) => r.input_audio_tokens },
  { label: "Audio output tokens", unit: "tokens", pick: (r) => r.output_audio_tokens },
];

/**
 * Sum each spec's counter per bucket. A primary endpoint keeps its series
 * even when empty; the others drop a series that is zero throughout, and so
 * do the completions extras.
 */
function usageSeries(
  endpoint: UsageEndpoint,
  buckets: UsageBucket[],
  primary: boolean,
): MetricSeries[] {
  const build = (specs: UsageSeriesSpec[], keepEmpty: boolean): MetricSeries[] =>
    specs
      .map((spec) => ({
        label: spec.label,
        unit: spec.unit,
        points: buckets.map((bucket) => {
          let value = 0;
          for (const result of bucket.results ?? []) value += spec.pick(result) ?? 0;
          return { timestamp: (bucket.start_time ?? 0) * 1000, value };
        }),
      }))
      .filter((series) => keepEmpty || series.points.some((point) => point.value !== 0));
  const extras = endpoint.core ? build(COMPLETIONS_EXTRA_SERIES, false) : [];
  return [...build(endpoint.series, primary), ...extras];
}

/**
 * One audit log entry as a log line: time, event type, who did it, and the
 * id of what it was done to (the payload sits under a key named after the
 * type).
 */
function formatAuditLog(entry: AuditLogEntry): string {
  const at = entry.effective_at ? new Date(entry.effective_at * 1000).toISOString() : "";
  const type = str(entry.type);
  const actor = entry.actor;
  const session = actor?.session;
  const key = actor?.api_key;
  const who =
    str(session?.user?.email) ||
    str(key?.user?.email) ||
    str(key?.service_account?.id) ||
    str(session?.user?.id) ||
    str(key?.user?.id) ||
    str(key?.id);
  const payload = entry[type];
  const target =
    payload && typeof payload === "object" ? str((payload as { id?: unknown }).id) : "";
  return [
    at,
    type,
    who ? `by ${who}` : "",
    session?.ip_address ? `from ${session.ip_address}` : "",
    target ? `on ${target}` : "",
    entry.project?.name ? `(project ${entry.project.name})` : "",
  ]
    .filter(Boolean)
    .join(" ");
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

  /** Data plane: project key. */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(path, this.apiKey, options);
  }

  /** Admin plane: admin key, with the missing-credential guard. */
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
   * Usage and cost endpoints don't use the `after` cursor at all: they page
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
      case "project-user":
        return this.listPerProject(accountId, "users", (project, u: ProjectUser, now) =>
          this.mapProjectUser(accountId, project.id, str(project.name), u, now),
        );
      case "project-service-account":
        return this.listPerProject(
          accountId,
          "service_accounts",
          (project, sa: ProjectServiceAccount, now) =>
            this.mapProjectServiceAccount(accountId, project.id, str(project.name), sa, now),
        );
      case "project-rate-limit":
        return this.listPerProject(accountId, "rate_limits", (project, rl: ProjectRateLimit, now) =>
          this.mapProjectRateLimit(accountId, project.id, str(project.name), rl, now),
        );
      case "spend-limit":
        return this.listSpendLimits(accountId);
      case "spend-alert":
        return this.listSpendAlerts(accountId);
      case "admin-api-key":
        return this.listAdminApiKeys(accountId);
      default:
        throw new Error(`OpenAI plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * `GET /v1/models`: verified 2026-07-29 against openapi.yaml v2.3.0
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
   * `GET /v1/fine_tuning/jobs`: verified 2026-07-29 against openapi.yaml
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
   * `GET /v1/batches`: verified 2026-07-29 against openapi.yaml v2.3.0
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
   * `GET /v1/files`: verified 2026-07-29 against openapi.yaml v2.3.0
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

  /** `GET /v1/vector_stores`: verified 2026-07-29 (`listVectorStores`). */
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

  /** `GET /v1/containers`: verified 2026-07-29 (`ListContainers`). */
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

  /** `GET /v1/evals`: verified 2026-07-29 (`listEvals`). */
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
   * `GET /v1/organization/projects`: verified 2026-07-29 (`list-projects`).
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
        residency: str(project.residency),
        externalKeyId: str(project.external_key_id),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/organization/projects/{project_id}/api_keys`: verified
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
        expiresAt: isoOf(key.expires_at),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  /** `GET /v1/organization/users`: verified 2026-07-29 (`list-users`). */
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

  /** `GET /v1/organization/invites`: verified 2026-07-29 (`list-invites`). */
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

  /**
   * Fan a per-project admin list (`users`, `service_accounts`,
   * `rate_limits`) out over every non-archived project.
   */
  private async listPerProject<T extends { id: string }>(
    accountId: string,
    collection: "users" | "service_accounts" | "rate_limits",
    map: (project: Project, item: T, now: string) => ResourceInstance,
  ): Promise<ResourceInstance[]> {
    const projects = (await this.fetchProjects()).filter((p) => p.status !== "archived");
    const now = new Date().toISOString();
    const pages = await Promise.all(
      projects.map(async (project) => {
        const items = await this.listAll<T>(
          `/organization/projects/${encodeURIComponent(project.id)}/${collection}`,
          {},
          { admin: true },
        );
        return items.map((item) => map(project, item, now));
      }),
    );
    return pages.flat();
  }

  private mapProjectUser(
    accountId: string,
    projectId: string,
    projectName: string,
    user: ProjectUser,
    now: string,
  ): ResourceInstance {
    const added = isoOf(user.added_at);
    return {
      id: `${accountId}:project-user:${projectId}:${user.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "project-user",
      accountId,
      parentResourceId: `${accountId}:project:${projectId}`,
      displayName: user.name || user.email || user.id,
      externalId: `${projectId}:${user.id}`,
      fields: {
        name: str(user.name),
        email: str(user.email),
        userId: user.id,
        projectId,
        projectName,
        role: str(user.role),
        addedAt: added,
      },
      resolvedOutputs: { userId: user.id, projectId, email: str(user.email) },
      secretStates: [],
      createdAt: added || now,
      updatedAt: now,
    };
  }

  private mapProjectServiceAccount(
    accountId: string,
    projectId: string,
    projectName: string,
    sa: ProjectServiceAccount,
    now: string,
  ): ResourceInstance {
    const created = isoOf(sa.created_at);
    return {
      id: `${accountId}:project-service-account:${projectId}:${sa.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "project-service-account",
      accountId,
      parentResourceId: `${accountId}:project:${projectId}`,
      displayName: sa.name || sa.id,
      externalId: `${projectId}:${sa.id}`,
      fields: {
        name: str(sa.name),
        role: str(sa.role),
        projectId,
        projectName,
        createdAt: created,
      },
      resolvedOutputs: { serviceAccountId: sa.id, projectId },
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  private mapProjectRateLimit(
    accountId: string,
    projectId: string,
    projectName: string,
    rl: ProjectRateLimit,
    now: string,
  ): ResourceInstance {
    return {
      id: `${accountId}:project-rate-limit:${projectId}:${rl.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "project-rate-limit",
      accountId,
      parentResourceId: `${accountId}:project:${projectId}`,
      displayName: rl.model || rl.id,
      externalId: `${projectId}:${rl.id}`,
      fields: {
        model: str(rl.model),
        projectId,
        projectName,
        maxRequestsPerMinute: num(rl.max_requests_per_1_minute) ?? 0,
        maxTokensPerMinute: num(rl.max_tokens_per_1_minute) ?? 0,
        // Absent for models the limiter does not apply to; "" keeps the edit
        // form from offering a zero that would then be written back.
        maxImagesPerMinute: num(rl.max_images_per_1_minute) ?? "",
        maxAudioMegabytesPerMinute: num(rl.max_audio_megabytes_per_1_minute) ?? "",
        maxRequestsPerDay: num(rl.max_requests_per_1_day) ?? "",
        batchMaxInputTokensPerDay: num(rl.batch_1_day_max_input_tokens) ?? "",
      },
      resolvedOutputs: { rateLimitId: rl.id, model: str(rl.model) },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/organization/spend_limit` and
   * `GET /v1/organization/projects/{id}/spend_limit`: verified 2026-10-03
   * against openapi.yaml. Both answer 404 when no limit is set, which is the
   * common case and simply means "no row".
   */
  private async listSpendLimits(accountId: string): Promise<ResourceInstance[]> {
    const projects = (await this.fetchProjects()).filter((p) => p.status !== "archived");
    const now = new Date().toISOString();
    const scopes: Array<{ scope: string; name: string }> = [
      { scope: ORG_SCOPE, name: "Organization" },
      ...projects.map((p) => ({ scope: p.id, name: str(p.name) || p.id })),
    ];
    const rows = await Promise.all(
      scopes.map(async ({ scope, name }) => {
        try {
          const limit = await this.adminFetch<SpendLimit>(spendLimitPath(scope));
          return [this.mapSpendLimit(accountId, scope, name, limit, now)];
        } catch (err) {
          if (isNotFound(err)) return [];
          throw err;
        }
      }),
    );
    return rows.flat();
  }

  private mapSpendLimit(
    accountId: string,
    scope: string,
    scopeName: string,
    limit: SpendLimit,
    now: string,
  ): ResourceInstance {
    const amountUsd = centsToDollars(limit.threshold_amount);
    const isOrg = scope === ORG_SCOPE;
    return {
      id: `${accountId}:spend-limit:${scope}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "spend-limit",
      accountId,
      ...(isOrg ? {} : { parentResourceId: `${accountId}:project:${scope}` }),
      displayName: `${scopeName} spend limit`,
      externalId: scope,
      fields: {
        scope: isOrg ? "Organization" : scopeName,
        projectId: isOrg ? "" : scope,
        amountUsd,
        interval: str(limit.interval) || "month",
        enforcement: str(limit.enforcement?.status),
      },
      resolvedOutputs: { amountUsd: String(amountUsd) },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * `GET /v1/organization/spend_alerts` and
   * `GET /v1/organization/projects/{id}/spend_alerts`: verified 2026-10-03
   * against openapi.yaml (`list-organization-spend-alerts`,
   * `list-project-spend-alerts`).
   */
  private async listSpendAlerts(accountId: string): Promise<ResourceInstance[]> {
    const projects = (await this.fetchProjects()).filter((p) => p.status !== "archived");
    const now = new Date().toISOString();
    const scopes: Array<{ scope: string; name: string }> = [
      { scope: ORG_SCOPE, name: "Organization" },
      ...projects.map((p) => ({ scope: p.id, name: str(p.name) || p.id })),
    ];
    const rows = await Promise.all(
      scopes.map(async ({ scope, name }) => {
        const alerts = await this.listAll<SpendAlert>(spendAlertsPath(scope), {}, { admin: true });
        return alerts.map((alert) => this.mapSpendAlert(accountId, scope, name, alert, now));
      }),
    );
    return rows.flat();
  }

  private mapSpendAlert(
    accountId: string,
    scope: string,
    scopeName: string,
    alert: SpendAlert,
    now: string,
  ): ResourceInstance {
    const thresholdUsd = centsToDollars(alert.threshold_amount);
    const isOrg = scope === ORG_SCOPE;
    return {
      id: `${accountId}:spend-alert:${scope}:${alert.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "spend-alert",
      accountId,
      ...(isOrg ? {} : { parentResourceId: `${accountId}:project:${scope}` }),
      displayName: `${scopeName}: $${thresholdUsd.toLocaleString("en-US")} / ${str(alert.interval) || "month"}`,
      externalId: `${scope}:${alert.id}`,
      fields: {
        scope: isOrg ? "Organization" : scopeName,
        projectId: isOrg ? "" : scope,
        thresholdUsd,
        recipients: (alert.notification_channel?.recipients ?? []).join(", "),
        subjectPrefix: str(alert.notification_channel?.subject_prefix),
        interval: str(alert.interval) || "month",
      },
      resolvedOutputs: { alertId: alert.id },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** `GET /v1/organization/admin_api_keys`: verified 2026-10-03 (`admin-api-keys-list`). */
  private async listAdminApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const keys = await this.listAll<AdminApiKey>(
      "/organization/admin_api_keys",
      { order: "desc" },
      { admin: true },
    );
    const now = new Date().toISOString();
    return keys.map((key) => this.mapAdminApiKey(accountId, key, now));
  }

  private mapAdminApiKey(accountId: string, key: AdminApiKey, now: string): ResourceInstance {
    const created = isoOf(key.created_at);
    return {
      id: `${accountId}:admin-api-key:${key.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: "admin-api-key",
      accountId,
      displayName: key.name || key.redacted_value || key.id,
      externalId: key.id,
      fields: {
        name: str(key.name),
        redactedValue: str(key.redacted_value),
        ownerName: str(key.owner?.name),
        ownerId: str(key.owner?.id),
        createdAt: created,
        expiresAt: isoOf(key.expires_at),
        lastUsedAt: isoOf(key.last_used_at),
      },
      resolvedOutputs: { adminKeyId: key.id, redactedValue: str(key.redacted_value) },
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
      case "project-user": {
        // GET …/projects/{p}/users/{u}: verified 2026-10-03 (`retrieve-project-user`).
        const { projectId, keyId: userId } = splitApiKeyId(externalId);
        const [user, project] = await Promise.all([
          this.adminFetch<ProjectUser>(
            `/organization/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`,
          ),
          this.adminFetch<Project>(`/organization/projects/${encodeURIComponent(projectId)}`),
        ]);
        return this.mapProjectUser(accountId, projectId, str(project.name), user, now);
      }
      case "project-service-account": {
        // GET …/service_accounts/{id}: verified 2026-10-03
        // (`retrieve-project-service-account`).
        const { projectId, keyId: saId } = splitApiKeyId(externalId);
        const [sa, project] = await Promise.all([
          this.adminFetch<ProjectServiceAccount>(
            `/organization/projects/${encodeURIComponent(projectId)}/service_accounts/${encodeURIComponent(saId)}`,
          ),
          this.adminFetch<Project>(`/organization/projects/${encodeURIComponent(projectId)}`),
        ]);
        return this.mapProjectServiceAccount(accountId, projectId, str(project.name), sa, now);
      }
      case "project-rate-limit": {
        // No single-limit GET exists; read the project's list and pick the row.
        const { projectId, keyId: rlId } = splitApiKeyId(externalId);
        const [limits, project] = await Promise.all([
          this.listAll<ProjectRateLimit>(
            `/organization/projects/${encodeURIComponent(projectId)}/rate_limits`,
            {},
            { admin: true },
          ),
          this.adminFetch<Project>(`/organization/projects/${encodeURIComponent(projectId)}`),
        ]);
        const limit = limits.find((l) => l.id === rlId);
        if (!limit) throw new Error(`OpenAI plugin: rate limit ${rlId} not found in ${projectId}`);
        return this.mapProjectRateLimit(accountId, projectId, str(project.name), limit, now);
      }
      case "spend-limit": {
        const scope = externalId;
        const [limit, name] = await Promise.all([
          this.adminFetch<SpendLimit>(spendLimitPath(scope)),
          this.scopeName(scope),
        ]);
        return this.mapSpendLimit(accountId, scope, name, limit, now);
      }
      case "spend-alert": {
        const { projectId: scope, keyId: alertId } = splitApiKeyId(externalId);
        const [alert, name] = await Promise.all([
          this.adminFetch<SpendAlert>(`${spendAlertsPath(scope)}/${encodeURIComponent(alertId)}`),
          this.scopeName(scope),
        ]);
        return this.mapSpendAlert(accountId, scope, name, alert, now);
      }
      case "admin-api-key":
        return this.mapAdminApiKey(
          accountId,
          await this.adminFetch<AdminApiKey>(`/organization/admin_api_keys/${id}`),
          now,
        );
      default:
        throw new Error(`OpenAI plugin: unknown resource type "${typeId}"`);
    }
  }

  /** Display name for a spend scope: "Organization" or the project's name. */
  private async scopeName(scope: string): Promise<string> {
    if (scope === ORG_SCOPE) return "Organization";
    const project = await this.adminFetch<Project>(
      `/organization/projects/${encodeURIComponent(scope)}`,
    );
    return str(project.name) || scope;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);

    // Ids are already encoded in the resource id: no round-trip needed.
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
    if (typeId === "project-user" || typeId === "project-service-account") {
      const { projectId, keyId } = splitApiKeyId(externalId);
      if (outputKey === "projectId") return projectId;
      if (outputKey === "userId" || outputKey === "serviceAccountId") return keyId;
    }
    if (typeId === "spend-alert" && outputKey === "alertId") {
      return splitApiKeyId(externalId).keyId;
    }
    if (typeId === "admin-api-key" && outputKey === "adminKeyId") return externalId;

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
          { label: "Storage", value: formatByteValue(f["usageBytes"]) },
        ];
      case "file":
        return [
          { label: "Purpose", value: dash(f["purpose"]) },
          { label: "Size", value: formatByteValue(f["bytes"]) },
        ];
      case "project":
        return [
          { label: "Status", value: dash(f["status"]), variant: statVariant(f["status"]) },
          { label: "Created", value: dash(f["createdAt"]).slice(0, 10) },
        ];
      case "project-rate-limit":
        return [
          {
            label: "Requests / min",
            value: (num(f["maxRequestsPerMinute"]) ?? 0).toLocaleString(),
          },
          { label: "Tokens / min", value: (num(f["maxTokensPerMinute"]) ?? 0).toLocaleString() },
        ];
      case "spend-limit":
        return [
          { label: "Monthly Limit", value: `$${(num(f["amountUsd"]) ?? 0).toLocaleString()}` },
          {
            label: "Enforcement",
            value: dash(f["enforcement"]),
            variant: f["enforcement"] === "enforcing" ? "status-error" : "status-healthy",
          },
        ];
      case "spend-alert":
        return [
          { label: "Threshold", value: `$${(num(f["thresholdUsd"]) ?? 0).toLocaleString()}` },
          { label: "Recipients", value: String(parseRecipients(f["recipients"]).length) },
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
      case "project-user":
        return this.renderProjectUserDetail(resource);
      case "project-service-account":
        return this.renderProjectServiceAccountDetail(resource);
      case "project-rate-limit":
        return this.renderProjectRateLimitDetail(resource);
      case "spend-limit":
        return this.renderSpendLimitDetail(resource);
      case "spend-alert":
        return this.renderSpendAlertDetail(resource);
      case "admin-api-key":
        return this.renderAdminApiKeyDetail(resource);
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
          destructive: true,
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
            value: isTtsModel(modelId) ? "Yes (/v1/audio/speech)" : "No",
          },
          {
            key: "Transcription",
            value: isSttModel(modelId) ? "Yes (/v1/audio/transcriptions)" : "No",
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
          : `${modelId} can't do audio. Pick a speech model below.`,
        helpText:
          "One picker drives both halves; synthesis falls back to gpt-4o-mini-tts and transcription to gpt-4o-transcribe if the model can't do that half. Word timings need whisper-1; speaker labels need gpt-4o-transcribe-diarize.",
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
          { key: "Size", value: formatByteValue(resource.fields["bytes"]) },
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
          { key: "Storage Used", value: formatByteValue(resource.fields["usageBytes"]) },
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
      metricsCapability: { defaultTimeRangeMs: 7 * 24 * 60 * 60 * 1000 },
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
            "Archive this project? Every API key scoped to it stops working, and it cannot be unarchived.",
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
          { key: "Data Residency", value: str(resource.fields["residency"]) || "GLOBAL" },
          ...(str(resource.fields["externalKeyId"])
            ? [{ key: "Encryption Key", value: str(resource.fields["externalKeyId"]) }]
            : []),
        ]),
        {
          kind: "section",
          title: "API keys",
          children: [
            {
              kind: "text",
              variant: "muted",
              content:
                "User-owned project keys can be listed and revoked but not created. Use “Get credentials” to create a service account key; it is shown once.",
            },
          ],
        },
      ],
      headerActions,
      metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
      logs: { defaultTailLines: 100 },
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
          { key: "Expires", value: str(resource.fields["expiresAt"]) || "never" },
          { key: "Last Used", value: dash(resource.fields["lastUsedAt"]) },
        ]),
      ],
      headerActions: refreshAction(),
      metricsCapability: { defaultTimeRangeMs: 7 * 24 * 60 * 60 * 1000 },
      logs: { defaultTailLines: 100 },
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
      metricsCapability: { defaultTimeRangeMs: 7 * 24 * 60 * 60 * 1000 },
      logs: { defaultTailLines: 100 },
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

  private renderProjectUserDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: `OpenAI project member · ${dash(f["projectName"])}`,
      status: { kind: "status-dot", status: "healthy", label: str(f["role"]) },
      sections: [
        section("Member", [
          { key: "Name", value: dash(f["name"]) },
          { key: "Email", value: dash(f["email"]), copyable: true },
          { key: "User ID", value: dash(f["userId"]), copyable: true },
          { key: "Project Role", value: dash(f["role"]) },
          { key: "Added", value: dash(f["addedAt"]) },
        ]),
        section("Project", [
          { key: "Project", value: dash(f["projectName"]) },
          { key: "Project ID", value: dash(f["projectId"]), copyable: true },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderProjectServiceAccountDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: `OpenAI service account · ${dash(f["projectName"])}`,
      status: { kind: "status-dot", status: "healthy", label: str(f["role"]) },
      sections: [
        section("Service account", [
          {
            key: "Service Account ID",
            value: str(resource.resolvedOutputs["serviceAccountId"]) || dash(resource.externalId),
            copyable: true,
          },
          { key: "Name", value: dash(f["name"]) },
          { key: "Project Role", value: dash(f["role"]) },
          { key: "Project", value: dash(f["projectName"]) },
          { key: "Created", value: dash(f["createdAt"]) },
        ]),
        {
          kind: "section",
          title: "Keys",
          children: [
            {
              kind: "text",
              variant: "muted",
              content:
                "Use Get credentials to mint another API key for this account; the secret is shown once. Its existing keys are listed under the project's API keys. Deleting the service account revokes all of them.",
            },
          ],
        },
      ],
      headerActions: refreshAction(),
      logs: { defaultTailLines: 100 },
    };
  }

  private renderProjectRateLimitDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const optional = (label: string, key: string): KVItem[] =>
      str(f[key]) === "" ? [] : [{ key: label, value: (num(f[key]) ?? 0).toLocaleString() }];
    return {
      title: resource.displayName,
      subtitle: `OpenAI project rate limit · ${dash(f["projectName"])}`,
      status: { kind: "status-dot", status: "info" },
      sections: [
        section("Limits", [
          {
            key: "Requests / min",
            value: (num(f["maxRequestsPerMinute"]) ?? 0).toLocaleString(),
          },
          { key: "Tokens / min", value: (num(f["maxTokensPerMinute"]) ?? 0).toLocaleString() },
          ...optional("Images / min", "maxImagesPerMinute"),
          ...optional("Audio MB / min", "maxAudioMegabytesPerMinute"),
          ...optional("Requests / day", "maxRequestsPerDay"),
          ...optional("Batch input tokens / day", "batchMaxInputTokensPerDay"),
        ]),
        {
          kind: "section",
          title: "About",
          children: [
            {
              kind: "text",
              variant: "muted",
              content:
                "Edit to lower this project's limits for the model. A project can never exceed the organization's own limit for that model, which comes from your usage tier.",
            },
          ],
        },
      ],
      headerActions: refreshAction(),
    };
  }

  private renderSpendLimitDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const enforcing = f["enforcement"] === "enforcing";
    return {
      title: resource.displayName,
      subtitle: `OpenAI hard spend limit · ${dash(f["scope"])}`,
      status: {
        kind: "status-dot",
        status: enforcing ? "error" : "healthy",
        label: enforcing ? "Enforcing" : "Within limit",
      },
      sections: [
        section("Limit", [
          { key: "Applies To", value: dash(f["scope"]) },
          { key: "Monthly Limit", value: `$${(num(f["amountUsd"]) ?? 0).toLocaleString()}` },
          { key: "Interval", value: dash(f["interval"]) },
          { key: "Enforcement", value: dash(f["enforcement"]) },
        ]),
        {
          kind: "section",
          title: "About",
          children: [
            {
              kind: "text",
              variant: "muted",
              content:
                "Once spend reaches this amount in a calendar month, API requests are refused until the month rolls over or the limit is raised. Deleting it removes the cap.",
            },
          ],
        },
      ],
      headerActions: refreshAction(),
    };
  }

  private renderSpendAlertDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: `OpenAI spend alert · ${dash(f["scope"])}`,
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        section("Alert", [
          { key: "Applies To", value: dash(f["scope"]) },
          { key: "Threshold", value: `$${(num(f["thresholdUsd"]) ?? 0).toLocaleString()}` },
          { key: "Interval", value: dash(f["interval"]) },
          { key: "Recipients", value: dash(f["recipients"]) },
          { key: "Subject Prefix", value: dash(f["subjectPrefix"]) },
        ]),
      ],
      headerActions: refreshAction(),
    };
  }

  private renderAdminApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "OpenAI admin API key",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        section("Key", [
          { key: "Key ID", value: resource.externalId ?? resource.id, copyable: true },
          { key: "Name", value: dash(f["name"]) },
          { key: "Redacted Value", value: dash(f["redactedValue"]) },
          { key: "Owner", value: dash(f["ownerName"]) },
        ]),
        section("Lifecycle", [
          { key: "Created", value: dash(f["createdAt"]) },
          { key: "Expires", value: str(f["expiresAt"]) || "never" },
          { key: "Last Used", value: dash(f["lastUsedAt"]) },
        ]),
        {
          kind: "section",
          title: "About",
          children: [
            {
              kind: "text",
              variant: "muted",
              content:
                "Admin keys can reach every organization setting. Deleting the key this account uses locks Infrawrench out of the admin sections until you paste a new one.",
            },
          ],
        },
      ],
      headerActions: refreshAction(),
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const status =
      resource.resourceTypeId === "model" ||
      resource.resourceTypeId === "file" ||
      resource.resourceTypeId === "project-user" ||
      resource.resourceTypeId === "project-service-account" ||
      resource.resourceTypeId === "spend-alert" ||
      resource.resourceTypeId === "admin-api-key"
        ? "healthy"
        : resource.resourceTypeId === "spend-limit"
          ? resource.fields["enforcement"] === "enforcing"
            ? "error"
            : "healthy"
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
          label: `${f.filename ?? f.id} (${formatByteValue(f.bytes)})`,
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
          label: `${f.filename ?? f.id} (${formatByteValue(f.bytes)})`,
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
            {
              key: "residency",
              label: "Data Residency",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [{ id: "", label: "Organization default" }, ...PROJECT_RESIDENCIES],
              description:
                "Where the project's data is stored and processed. Your organization must have access to the region, and it cannot be changed after creation.",
            },
          ],
        };

      case "project-user": {
        const [projects, users] = await Promise.all([
          this.fetchProjects(),
          this.listAll<OrganizationUser>("/organization/users", {}, { admin: true }),
        ]);
        const parent = parentProjectId(parentResourceId);
        return {
          fields: [
            parent
              ? {
                  key: "project_id",
                  label: "Project",
                  kind: "text",
                  required: true,
                  hidden: true,
                  defaultValue: parent,
                }
              : {
                  key: "project_id",
                  label: "Project",
                  kind: "select",
                  required: true,
                  options: projects
                    .filter((p) => p.status !== "archived")
                    .map((p) => ({ id: p.id, label: p.name || p.id, description: p.id })),
                },
            {
              key: "user_id",
              label: "Member",
              kind: "select",
              required: true,
              options: users
                .filter((u) => u.is_service_account !== true)
                .map((u) => ({
                  id: u.id,
                  label: u.name || u.email || u.id,
                  ...(u.email ? { description: u.email } : {}),
                })),
              description:
                "Only existing organization members can be added. Invite new people from Invites first.",
            },
            {
              key: "role",
              label: "Project Role",
              kind: "select",
              required: true,
              defaultValue: "member",
              options: [
                { id: "member", label: "Member" },
                { id: "owner", label: "Owner" },
              ],
            },
          ],
        };
      }

      case "spend-limit":
      case "spend-alert": {
        const projects = (await this.fetchProjects()).filter((p) => p.status !== "archived");
        const scopeOptions = [
          { id: ORG_SCOPE, label: "Whole organization" },
          ...projects.map((p) => ({ id: p.id, label: p.name || p.id, description: p.id })),
        ];
        const scopeField = {
          key: "scope",
          label: "Applies To",
          kind: "select" as const,
          required: true,
          defaultValue: parentProjectId(parentResourceId) ?? ORG_SCOPE,
          options: scopeOptions,
        };
        if (typeId === "spend-limit") {
          return {
            fields: [
              {
                ...scopeField,
                description:
                  "One hard limit per organization and per project. Creating one where a limit already exists replaces it.",
              },
              {
                key: "amount_usd",
                label: "Monthly Limit (USD)",
                kind: "number",
                required: true,
                minValue: 0.01,
                stepValue: 1,
                placeholder: "500",
                description:
                  "Requests are refused once spend reaches this amount in a calendar month.",
              },
            ],
          };
        }
        return {
          fields: [
            scopeField,
            {
              key: "threshold_usd",
              label: "Threshold (USD)",
              kind: "number",
              required: true,
              minValue: 0,
              stepValue: 1,
              placeholder: "250",
              description: "Email when spend for the calendar month crosses this amount.",
            },
            {
              key: "recipients",
              label: "Recipients",
              kind: "string-list",
              required: true,
              placeholder: "finance@example.com",
              addLabel: "+ Add recipient",
            },
            {
              key: "subject_prefix",
              label: "Subject Prefix",
              kind: "text",
              required: false,
              placeholder: "[OpenAI]",
            },
          ],
        };
      }

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
        // POST /v1/fine_tuning/jobs: verified 2026-07-29 (`createFineTuningJob`).
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
        // POST /v1/batches: verified 2026-07-29 (`createBatch`).
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
        // POST /v1/vector_stores: verified 2026-07-29 (`createVectorStore`).
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
        // POST /v1/containers: verified 2026-07-29 (`CreateContainer`).
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
        // POST /v1/organization/projects: verified 2026-10-03 (`create-project`).
        // `residency` replaces the deprecated `geography`.
        const project = await this.adminFetch<Project>("/organization/projects", {
          method: "POST",
          body: JSON.stringify({
            name: fields["name"],
            ...(fields["residency"] ? { residency: fields["residency"] } : {}),
          }),
        });
        return this.mapProject(accountId, project, now);
      }

      case "project-user": {
        // POST /v1/organization/projects/{p}/users: verified 2026-10-03
        // (`create-project-user`).
        const projectId = str(fields["project_id"]);
        if (!projectId || !fields["user_id"]) throw new Error("Pick a project and a member");
        const [user, project] = await Promise.all([
          this.adminFetch<ProjectUser>(
            `/organization/projects/${encodeURIComponent(projectId)}/users`,
            {
              method: "POST",
              body: JSON.stringify({
                user_id: fields["user_id"],
                role: fields["role"] || "member",
              }),
            },
          ),
          this.adminFetch<Project>(`/organization/projects/${encodeURIComponent(projectId)}`),
        ]);
        return this.mapProjectUser(accountId, projectId, str(project.name), user, now);
      }

      case "spend-limit": {
        // POST /v1/organization/spend_limit or …/projects/{p}/spend_limit:
        // verified 2026-10-03. Create-or-replace; only USD and month exist.
        const scope = str(fields["scope"]) || ORG_SCOPE;
        const limit = await this.adminFetch<SpendLimit>(spendLimitPath(scope), {
          method: "POST",
          body: JSON.stringify({
            threshold_amount: dollarsToCents(fields["amount_usd"], "Monthly limit"),
            currency: "USD",
            interval: "month",
          }),
        });
        return this.mapSpendLimit(accountId, scope, await this.scopeName(scope), limit, now);
      }

      case "spend-alert": {
        // POST /v1/organization/spend_alerts or …/projects/{p}/spend_alerts:
        // verified 2026-10-03 (`create-organization-spend-alert`,
        // `create-project-spend-alert`).
        const scope = str(fields["scope"]) || ORG_SCOPE;
        const alert = await this.adminFetch<SpendAlert>(spendAlertsPath(scope), {
          method: "POST",
          body: JSON.stringify(
            spendAlertBody(fields["threshold_usd"], fields["recipients"], fields["subject_prefix"]),
          ),
        });
        return this.mapSpendAlert(accountId, scope, await this.scopeName(scope), alert, now);
      }

      case "invite": {
        // POST /v1/organization/invites: verified 2026-07-29 (`inviteUser`).
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
        // POST /v1/vector_stores/{id}: verified 2026-07-29 (`modifyVectorStore`).
        const store = await this.fetch<VectorStore>(`/vector_stores/${id}`, {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] }),
        });
        return this.mapVectorStore(accountId, store, now);
      }
      case "eval": {
        // POST /v1/evals/{id}: verified 2026-07-29 (`updateEval`).
        const item = await this.fetch<EvalObject>(`/evals/${id}`, {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] }),
        });
        return this.mapEval(accountId, item, now);
      }
      case "project": {
        // POST /v1/organization/projects/{id}: verified 2026-07-29 (`modify-project`).
        const project = await this.adminFetch<Project>(`/organization/projects/${id}`, {
          method: "POST",
          body: JSON.stringify({ name: fields["name"] }),
        });
        return this.mapProject(accountId, project, now);
      }
      case "organization-user": {
        // POST /v1/organization/users/{id}: verified 2026-07-29 (`modify-user`).
        const user = await this.adminFetch<OrganizationUser>(`/organization/users/${id}`, {
          method: "POST",
          body: JSON.stringify({ role: fields["role"] }),
        });
        return this.mapOrganizationUser(accountId, user, now);
      }
      case "project-user": {
        // POST …/projects/{p}/users/{u}: verified 2026-10-03 (`modify-project-user`).
        const { projectId, keyId: userId } = splitApiKeyId(externalId);
        await this.adminFetch<ProjectUser>(
          `/organization/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`,
          { method: "POST", body: JSON.stringify({ role: fields["role"] }) },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "project-service-account": {
        // POST …/service_accounts/{id}: verified 2026-10-03
        // (`update-project-service-account`). Only member/owner are settable.
        const { projectId, keyId: saId } = splitApiKeyId(externalId);
        const body: Record<string, unknown> = {};
        if (fields["name"]) body["name"] = fields["name"];
        if (fields["role"] === "member" || fields["role"] === "owner")
          body["role"] = fields["role"];
        await this.adminFetch<ProjectServiceAccount>(
          `/organization/projects/${encodeURIComponent(projectId)}/service_accounts/${encodeURIComponent(saId)}`,
          { method: "POST", body: JSON.stringify(body) },
        );
        return this.getResource(typeId, resourceId, accountId);
      }
      case "project-rate-limit": {
        // POST …/projects/{p}/rate_limits/{id}: verified 2026-10-03
        // (`update-project-rate-limits`). Blank fields are left alone.
        const { projectId, keyId: rlId } = splitApiKeyId(externalId);
        const body: Record<string, number> = {};
        for (const [field, apiKey] of RATE_LIMIT_FIELDS) {
          const value = fields[field];
          if (value === undefined || str(value).trim() === "") continue;
          const n = num(value);
          if (n === undefined || n < 0 || !Number.isInteger(n)) {
            throw new Error(`OpenAI plugin: ${field} must be a whole number`);
          }
          body[apiKey] = n;
        }
        const updated = await this.adminFetch<ProjectRateLimit>(
          `/organization/projects/${encodeURIComponent(projectId)}/rate_limits/${encodeURIComponent(rlId)}`,
          { method: "POST", body: JSON.stringify(body) },
        );
        const project = await this.adminFetch<Project>(
          `/organization/projects/${encodeURIComponent(projectId)}`,
        );
        return this.mapProjectRateLimit(accountId, projectId, str(project.name), updated, now);
      }
      case "spend-limit": {
        const scope = externalId;
        const limit = await this.adminFetch<SpendLimit>(spendLimitPath(scope), {
          method: "POST",
          body: JSON.stringify({
            threshold_amount: dollarsToCents(fields["amountUsd"], "Monthly limit"),
            currency: "USD",
            interval: "month",
          }),
        });
        return this.mapSpendLimit(accountId, scope, await this.scopeName(scope), limit, now);
      }
      case "spend-alert": {
        // POST …/spend_alerts/{alert_id}: verified 2026-10-03. The update body
        // is the full create body, so every field is sent.
        const { projectId: scope, keyId: alertId } = splitApiKeyId(externalId);
        const alert = await this.adminFetch<SpendAlert>(
          `${spendAlertsPath(scope)}/${encodeURIComponent(alertId)}`,
          {
            method: "POST",
            body: JSON.stringify(
              spendAlertBody(fields["thresholdUsd"], fields["recipients"], fields["subjectPrefix"]),
            ),
          },
        );
        return this.mapSpendAlert(accountId, scope, await this.scopeName(scope), alert, now);
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
        // DELETE /v1/files/{file_id}: verified 2026-07-29 (`deleteFile`).
        await this.fetch(`/files/${id}`, { method: "DELETE" });
        return;
      case "vector-store":
        // DELETE /v1/vector_stores/{id}: verified 2026-07-29 (`deleteVectorStore`).
        await this.fetch(`/vector_stores/${id}`, { method: "DELETE" });
        return;
      case "container":
        // DELETE /v1/containers/{id}: verified 2026-07-29 (`DeleteContainer`).
        await this.fetch(`/containers/${id}`, { method: "DELETE" });
        return;
      case "eval":
        // DELETE /v1/evals/{id}: verified 2026-07-29 (`deleteEval`).
        await this.fetch(`/evals/${id}`, { method: "DELETE" });
        return;
      case "invite":
        // DELETE /v1/organization/invites/{id}: verified 2026-07-29 (`delete-invite`).
        // Rejected once the invite has been accepted.
        await this.adminFetch(`/organization/invites/${id}`, { method: "DELETE" });
        return;
      case "organization-user":
        // DELETE /v1/organization/users/{id}: verified 2026-07-29 (`delete-user`).
        await this.adminFetch(`/organization/users/${id}`, { method: "DELETE" });
        return;
      case "project-api-key": {
        // DELETE /v1/organization/projects/{p}/api_keys/{k}: verified 2026-07-29
        // (`delete-project-api-key`). 400s when the key belongs to a service
        // account; the service account has to be removed instead.
        const { projectId, keyId } = splitApiKeyId(externalId);
        await this.adminFetch(
          `/organization/projects/${encodeURIComponent(projectId)}/api_keys/${encodeURIComponent(keyId)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "project-user": {
        // DELETE …/projects/{p}/users/{u}: verified 2026-10-03 (`delete-project-user`).
        const { projectId, keyId: userId } = splitApiKeyId(externalId);
        await this.adminFetch(
          `/organization/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "project-service-account": {
        // DELETE …/service_accounts/{id}: verified 2026-10-03
        // (`delete-project-service-account`). Revokes the account's keys.
        const { projectId, keyId: saId } = splitApiKeyId(externalId);
        await this.adminFetch(
          `/organization/projects/${encodeURIComponent(projectId)}/service_accounts/${encodeURIComponent(saId)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "spend-limit":
        // DELETE /v1/organization/spend_limit or …/projects/{p}/spend_limit.
        await this.adminFetch(spendLimitPath(externalId), { method: "DELETE" });
        return;
      case "spend-alert": {
        const { projectId: scope, keyId: alertId } = splitApiKeyId(externalId);
        await this.adminFetch(`${spendAlertsPath(scope)}/${encodeURIComponent(alertId)}`, {
          method: "DELETE",
        });
        return;
      }
      case "admin-api-key":
        // DELETE /v1/organization/admin_api_keys/{id}: verified 2026-10-03
        // (`admin-api-keys-delete`).
        await this.adminFetch(`/organization/admin_api_keys/${id}`, { method: "DELETE" });
        return;
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
      // POST /v1/fine_tuning/jobs/{id}/{cancel,pause,resume}: verified 2026-07-29.
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
      // POST /v1/batches/{id}/cancel: verified 2026-07-29 (`cancelBatch`).
      await this.fetch(`/batches/${id}/cancel`, { method: "POST" });
      return;
    }

    if (typeId === "model" && actionId === "delete-fine-tuned-model") {
      // DELETE /v1/models/{model}: verified 2026-07-29 (`deleteModel`). The API
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
      // POST /v1/organization/projects/{id}/archive: verified 2026-07-29.
      await this.adminFetch(`/organization/projects/${id}/archive`, { method: "POST" });
      return;
    }

    throw new Error(`OpenAI plugin: unknown action "${actionId}" for type "${typeId}"`);
  }

  /**
   * POST /v1/organization/projects/{id}/service_accounts: verified 2026-07-29
   * (`create-project-service-account`). This is the only route in the whole API
   * that hands back a usable secret key, and it does so exactly once.
   */
  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "project-service-account" && formatId === "service-account-api-key") {
      // POST …/service_accounts/{id}/api_keys: verified 2026-10-03
      // (`CreateanAPIkeyforaserviceaccount`). The value is returned once.
      const { projectId, keyId: saId } = splitApiKeyId(externalIdOf(resourceId));
      const name = `infrawrench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
      const created = await this.adminFetch<ServiceAccountApiKeyCreated>(
        `/organization/projects/${encodeURIComponent(projectId)}/service_accounts/${encodeURIComponent(saId)}/api_keys`,
        { method: "POST", body: JSON.stringify({ name }) },
      );
      const value = str(created.value);
      if (!value) throw new Error("OpenAI plugin: the API key was created but no value came back.");
      return {
        content: value,
        filename: `openai-${saId}-api-key.txt`,
        mimeType: "text/plain",
        fields: [
          { label: "API Key ID", value: created.id },
          { label: "Name", value: str(created.name) || name },
          { label: "Expires", value: isoOf(created.expires_at) || "never" },
          { label: "API Key", value, sensitive: true, hint: "Only shown once" },
        ],
        warning:
          "Save this key now. OpenAI never returns it again; the key list only ever shows a redacted value.",
      };
    }
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
      warning: "Save this key now. OpenAI never shows it again.",
    };
  }

  // ---- Metrics and costs ---------------------------------------------------

  /**
   * `GET /v1/organization/usage/*` and `GET /v1/organization/costs`: verified
   * 2026-10-03 against openapi.yaml (`usage-completions`, `usage-costs` and
   * the other usage operations) and the current API reference, which adds
   * `web_search_calls` and `file_search_calls`. Every usage endpoint shares
   * one bucket/page shape and differs only in which filters it accepts and
   * which counters its results carry, so `USAGE_ENDPOINTS` drives them all.
   *
   * Models, project API keys, organization members and projects get the
   * completions series plus every other endpoint that accepts their filter;
   * projects also get their daily cost, and vector stores their file search
   * calls. Series past the core completions four are dropped when they are
   * zero across the whole window (a chat model never makes images), and a
   * failure on one of them drops that chart rather than the tab.
   * `start_time` is required and in Unix **seconds**; `end_time` is
   * exclusive. All of it lives behind the admin key.
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

    // A model filters on `models`, a key on `api_key_ids` (the bare key id,
    // not the project-prefixed external id), a member on `user_ids`, a
    // project on `project_ids` and a vector store on `vector_store_ids`.
    const filterFor: Record<string, [UsageFilter, string]> = {
      model: ["models", externalId],
      "project-api-key": [
        "api_key_ids",
        externalId.includes(":") ? splitApiKeyId(externalId).keyId : externalId,
      ],
      "organization-user": ["user_ids", externalId],
      project: ["project_ids", externalId],
      "vector-store": ["vector_store_ids", externalId],
    };
    const filter = filterFor[resourceTypeId];
    if (!filter) return [];

    // `1h` buckets cap at 168, `1d` at 31: pick whichever fits the window.
    const hourly = spanDays <= 7;
    const params = new URLSearchParams({
      start_time: String(startTime),
      end_time: String(endTime),
      bucket_width: hourly ? "1h" : "1d",
      limit: String(hourly ? Math.min(168, spanDays * 24) : Math.min(31, spanDays)),
    });
    appendAll(params, filter[0], [filter[1]]);

    const endpoints = USAGE_ENDPOINTS.filter((endpoint) => endpoint.filters.includes(filter[0]));
    const results = await Promise.all(
      endpoints.map(async (endpoint) => {
        // The completions call (or, for a vector store, the only call) is
        // the tab's baseline and surfaces its error; the rest are extras.
        const primary = endpoint.core === true || endpoints.length === 1;
        const load = this.listUsageBuckets(`/organization/usage/${endpoint.path}`, params);
        const buckets = primary ? await load : await load.catch(() => null);
        return buckets ? usageSeries(endpoint, buckets, primary) : [];
      }),
    );
    const usage = results.flat();

    if (resourceTypeId === "project") {
      // /organization/costs only accepts 1d buckets, limit 1–180.
      const params = new URLSearchParams({
        start_time: String(startTime),
        end_time: String(endTime),
        bucket_width: "1d",
        limit: String(Math.min(180, spanDays)),
      });
      appendAll(params, "project_ids", [externalId]);

      const costBuckets = await this.listUsageBuckets("/organization/costs", params);
      const points: MetricSeriesPoint[] = costBuckets.map((bucket) => {
        let total = 0;
        for (const result of bucket.results ?? []) total += result.amount?.value ?? 0;
        return { timestamp: (bucket.start_time ?? 0) * 1000, value: total };
      });
      return [{ label: "Cost", unit: "USD", points }, ...usage];
    }

    return usage;
  }

  /**
   * `GET /v1/organization/audit_logs`: verified 2026-10-03 against
   * openapi.yaml (`list-audit-logs`) and the current API reference. Audit
   * logging has to be turned on once by an organization owner (Settings →
   * Organization → Data controls) and records nothing from before that.
   *
   * A project reads its events with `project_ids[]`, a member and a service
   * account the events they performed with `actor_ids[]`, and a project API
   * key the events performed on it with `resource_ids[]`. Note the bracketed
   * array keys: unlike the usage endpoints, this one is described that way.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const externalId = externalIdOf(resourceId);
    const query = new URLSearchParams({
      limit: String(Math.min(Math.max(params.tailLines ?? 100, 1), 100)),
    });
    switch (typeId) {
      case "project":
        query.append("project_ids[]", externalId);
        break;
      case "organization-user":
        query.append("actor_ids[]", externalId);
        break;
      case "project-service-account":
        query.append("actor_ids[]", splitApiKeyId(externalId).keyId);
        break;
      case "project-api-key":
        query.append(
          "resource_ids[]",
          externalId.includes(":") ? splitApiKeyId(externalId).keyId : externalId,
        );
        break;
      default:
        throw new Error(`OpenAI plugin: no audit log for type "${typeId}"`);
    }

    const container = "audit log";
    const wrap = (lines: string[]) => ({
      text: lines.map((line) => `${line}\n`).join(""),
      containers: [container],
      activeContainer: container,
    });

    let page: ListEnvelope<AuditLogEntry>;
    try {
      page = await this.adminFetch<ListEnvelope<AuditLogEntry>>(
        `/organization/audit_logs?${query.toString()}`,
      );
    } catch (error) {
      if (error instanceof Error && / 40[03] /.test(error.message)) {
        return wrap([
          "OpenAI did not return the audit log. Audit logging has to be enabled once by an organization owner under Settings → Organization → Data controls → Audit logging, and only events after that are recorded.",
          error.message,
        ]);
      }
      throw error;
    }

    // Newest first from the API; reverse into reading order.
    const lines = (page.data ?? []).reverse().map(formatAuditLog);
    return wrap(lines.length > 0 ? lines : ["No audit log events for this resource."]);
  }

  async fetchCostData(accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    // Normalized AI dimensions (`ai:provider`, and `ai:model` /
    // `ai:token_type` where the billing API says), so request logs can be
    // reconciled against this bill. See plugin-base `ai-requests.ts`.
    return withAiCostTags(await this.fetchUntaggedCostRows(accountId, range), (row) => {
      const { model, tokenType } = parseOpenAiLineItem(row.service);
      return { provider: "openai", model, tokenType };
    });
  }

  private async fetchUntaggedCostRows(
    _accountId: string,
    range: CostFetchRange,
  ): Promise<CostRow[]> {
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
    // tts-1 / tts-1-hd: sending either is a 400, not a silent no-op.
    if (!LEGACY_TTS_MODELS.has(model)) {
      body["instructions"] = "Speak clearly and naturally at a normal conversational pace.";
    }

    const started = Date.now();
    const { bytes, requestId } = await this.ttsBytes(body);
    const elapsedMs = Date.now() - started;

    const characters = payload.text.length;
    const note = isTtsModel(requested) ? "" : ` · ${requested} can't synthesize, used ${model}`;

    return {
      audioBase64: bytesToBase64(bytes),
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

    // Response format is not a free choice. `verbose_json` (the only shape
    // that carries word and segment timings) is accepted by whisper-1 alone;
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
      !wantsVerbose && !wantsDiarized ? "no timings (only whisper-1 returns them)" : undefined,
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
   * POST /v1/audio/speech; verified 2026-07-29 against openapi.yaml v2.3.0
   * (`createSpeech`): JSON goes in, raw `application/octet-stream` audio comes
   * back.
   *
   * Deliberately not routed through `jsonRestFetch`. That helper JSON-parses
   * every response, and the host HTTP service it delegates to returns bodies as
   * UTF-8 strings: either of which would shred an mp3. This one call therefore
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
   * POST /v1/audio/transcriptions: verified 2026-07-29 (`createTranscription`).
   * multipart/form-data, which `jsonRestFetch` cannot express: its host-HTTP
   * path stringifies a FormData instead of encoding it. So this call also uses
   * the global `fetch` and bypasses bastion routing.
   *
   * The clip's content type is whatever MediaRecorder or the file picker
   * produced (`audio/webm;codecs=opus` on Chromium, `audio/mp4` on Safari) and
   * is forwarded verbatim: nothing is transcoded. Only the filename extension
   * is normalised, because the endpoint reads the format from it too.
   */
  private async sttTranscribe(
    payload: TranscribeAudioPayload,
    model: string,
    responseFormat: string,
    withTimestamps: boolean,
  ): Promise<TranscriptionResponse> {
    const bytes = base64ToBytes(payload.audioBase64);
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

/** Spend limit route for a scope: the organization or one project. */
function spendLimitPath(scope: string): string {
  return scope === ORG_SCOPE
    ? "/organization/spend_limit"
    : `/organization/projects/${encodeURIComponent(scope)}/spend_limit`;
}

/** Spend alerts collection route for a scope. */
function spendAlertsPath(scope: string): string {
  return scope === ORG_SCOPE
    ? "/organization/spend_alerts"
    : `/organization/projects/${encodeURIComponent(scope)}/spend_alerts`;
}

/** `CreateSpendAlertBody`: also the full update body. Only USD/month/email exist. */
function spendAlertBody(
  thresholdUsd: unknown,
  recipients: unknown,
  subjectPrefix: unknown,
): Record<string, unknown> {
  const emails = parseRecipients(recipients);
  if (emails.length === 0)
    throw new Error("OpenAI plugin: a spend alert needs at least one recipient");
  const prefix = str(subjectPrefix).trim();
  return {
    threshold_amount: dollarsToCents(thresholdUsd, "Threshold"),
    currency: "USD",
    interval: "month",
    notification_channel: {
      type: "email",
      recipients: emails,
      ...(prefix ? { subject_prefix: prefix } : {}),
    },
  };
}

/** Rate-limit form fields and the request keys they write. */
const RATE_LIMIT_FIELDS: Array<[string, string]> = [
  ["maxRequestsPerMinute", "max_requests_per_1_minute"],
  ["maxTokensPerMinute", "max_tokens_per_1_minute"],
  ["maxImagesPerMinute", "max_images_per_1_minute"],
  ["maxAudioMegabytesPerMinute", "max_audio_megabytes_per_1_minute"],
  ["maxRequestsPerDay", "max_requests_per_1_day"],
  ["batchMaxInputTokensPerDay", "batch_1_day_max_input_tokens"],
];

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
  "project-user:email": "email",
  "project-rate-limit:model": "model",
  "project-rate-limit:rateLimitId": "rateLimitId",
  "spend-limit:amountUsd": "amountUsd",
  "admin-api-key:redactedValue": "redactedValue",
  "invite:email": "email",
};

/**
 * Split an OpenAI cost `line_item` ("gpt-4o-2024-08-06, input",
 * "gpt-4o-mini, cached input") into a model and a token type. A line item
 * without the comma form (web search, file storage) is provider-only rather
 * than guessed.
 */
export function parseOpenAiLineItem(lineItem: string | undefined): {
  model?: string;
  tokenType?: "input" | "output" | "cache_read" | "cache_write" | "reasoning";
} {
  if (!lineItem) return {};
  const comma = lineItem.lastIndexOf(",");
  if (comma <= 0) return {};
  const model = lineItem.slice(0, comma).trim();
  const kind = lineItem
    .slice(comma + 1)
    .trim()
    .toLowerCase();
  const tokenType = /cached/.test(kind)
    ? "cache_read"
    : /reasoning/.test(kind)
      ? "reasoning"
      : /output/.test(kind)
        ? "output"
        : /input/.test(kind)
          ? "input"
          : undefined;
  if (!tokenType) return {};
  return { model, tokenType };
}
