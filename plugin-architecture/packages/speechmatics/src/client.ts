import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
  SpeechPanelOption,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

/** `JobDetails` — https://docs.speechmatics.com/batch.yaml (#/definitions/JobDetails). */
interface SpeechmaticsJob {
  id: string;
  /** `running | done | rejected | deleted | expired` — the async lifecycle enum. */
  status: string;
  created_at: string;
  data_name?: string;
  text_name?: string;
  duration?: number;
  lang?: string;
  config?: {
    type?: string;
    transcription_config?: {
      language?: string;
      model?: string;
      /** Deprecated alias for `model`; still returned for old jobs. */
      operating_point?: string;
      domain?: string;
      diarization?: string;
    };
  };
  errors?: Array<{ message?: string; timestamp?: string }>;
}

interface RetrieveJobsResponse {
  jobs: SpeechmaticsJob[];
}

interface RetrieveJobResponse {
  job: SpeechmaticsJob;
}

/**
 * `CreateJobResponse`. `status` here is the *sync-mode* enum
 * (`created | done | rejected | deleted`) and is only present when `wait` was
 * set — it is deliberately different from `JobDetails.status`.
 */
interface CreateJobResponse {
  id: string;
  status?: string;
  txt?: string;
  srt?: string;
  "json-v2"?: TranscriptJsonV2;
}

/** `RetrieveTranscriptResponse` in `json-v2` form. */
interface TranscriptJsonV2 {
  format?: string;
  job?: { id?: string; duration?: number; data_name?: string; created_at?: string };
  metadata?: {
    created_at?: string;
    type?: string;
    transcription_config?: { language?: string; model?: string; operating_point?: string };
  };
  results?: Array<{
    type?: string;
    start_time?: number;
    end_time?: number;
    channel?: string;
    alternatives?: Array<{
      content?: string;
      confidence?: number;
      language?: string;
      speaker?: string;
    }>;
  }>;
}

/**
 * `UsageResponse`. Note the schema names the breakdown key `operating_point`
 * while the documented examples show `model` — both are parsed.
 */
interface UsageResponse {
  since?: string;
  until?: string;
  summary?: UsageDetails[];
  details?: UsageDetails[];
}

interface UsageDetails {
  mode?: string;
  type?: string;
  language?: string;
  operating_point?: string;
  model?: string;
  count?: number;
  duration_hrs?: number;
}

/** `GET /v1/discovery/features` — unauthenticated. */
interface DiscoveryFeatures {
  metadata?: {
    language_pack_info?: Record<string, { language_description?: string }>;
  };
  batch?: {
    transcription?: Array<{
      version?: string;
      languages?: string[];
      locales?: Record<string, string[]>;
      domains?: Record<string, string[]>;
      domains_availability?: Record<string, string[]>;
    }>;
  };
}

/** Management API project — `GET /projects`. */
interface ManagementProject {
  project_id: number;
  name?: string;
  description?: string;
  is_default?: boolean | null;
  is_active?: boolean | null;
  created_at?: string;
  deleted_at?: string;
}

/** Management API key — `GET /api-keys`. */
interface ManagementApiKey {
  apikey_id: string;
  name?: string;
  created_at?: string;
  client_ref?: string;
}

/** Condensed discovery data stashed on the resource for the synchronous renderer. */
interface StashedDiscovery {
  languages: SpeechPanelOption[];
  models: SpeechPanelOption[];
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const VENDOR = "Speechmatics";
const MANAGEMENT_BASE_URL = "https://mp.api.speechmatics.com/v1";
const VALID_REGIONS = ["eu1", "us1", "au1"] as const;

/**
 * Documented batch input formats — "wav, mp3, aac, ogg, mpeg, amr, m4a, mp4,
 * flac". Speechmatics sniffs the container rather than trusting the filename,
 * and explicitly rejects raw/headerless audio.
 * https://docs.speechmatics.com/speech-to-text/batch/input
 */
const ACCEPTED_AUDIO_TYPES = [
  ".wav",
  ".mp3",
  ".aac",
  ".ogg",
  ".mpeg",
  ".amr",
  ".m4a",
  ".mp4",
  ".flac",
  "audio/wav",
  "audio/mpeg",
  "audio/aac",
  "audio/ogg",
  "audio/amr",
  "audio/mp4",
  "audio/flac",
  "video/mp4",
];

/**
 * A media file posted in the body of `POST /jobs` "must be less than 1 GB in
 * size or the job will be rejected".
 * https://docs.speechmatics.com/speech-to-text/batch/limits
 *
 * In practice our own host caps the upload far below this — the Speech tab
 * base64-encodes the clip into a JSON request body — so this is the provider
 * ceiling, not a promise that a 1 GB clip will survive the round trip.
 */
const MAX_AUDIO_BYTES = 1024 * 1024 * 1024;

/**
 * `#/definitions/Model` — "Specific model to use in transcription (previously
 * called operating point)". Discovery does not enumerate these, so they come
 * from the OpenAPI enum.
 */
const MODEL_OPTIONS: SpeechPanelOption[] = [
  { id: "enhanced", label: "Enhanced", description: "Highest accuracy. The usual default." },
  { id: "standard", label: "Standard", description: "Faster and cheaper, lower accuracy." },
  {
    id: "melia-1",
    label: "Melia-1",
    description: 'Batch only, and requires the "Multilingual" language.',
  },
];

/** melia-1 is documented as requiring `"language": "multi"`. */
const MELIA_MODEL = "melia-1";
const MULTILINGUAL_LANGUAGE = "multi";

/** Fallback picker contents when live discovery is unavailable (offline, mock). */
const FALLBACK_LANGUAGES: SpeechPanelOption[] = [
  { id: "en", label: "English (en)" },
  { id: "de", label: "German (de)" },
  { id: "es", label: "Spanish (es)" },
  { id: "fr", label: "French (fr)" },
  { id: "it", label: "Italian (it)" },
  { id: "nl", label: "Dutch (nl)" },
  { id: "pt", label: "Portuguese (pt)" },
  { id: "ja", label: "Japanese (ja)" },
  { id: "ko", label: "Korean (ko)" },
  { id: "cmn", label: "Mandarin (cmn)" },
  { id: MULTILINGUAL_LANGUAGE, label: "Multilingual (multi)" },
];

/** Key under `resolvedOutputs` used to smuggle async data into `renderDetail`. */
const DISCOVERY_STASH_KEY = "__discovery__";

/** Blocking window we ask `POST /jobs?wait=` to hold the connection for. */
const SYNC_WAIT_SECONDS = 60;
/** Hard ceiling on the whole submit → poll → fetch cycle. */
const TOTAL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

const TERMINAL_STATUSES = new Set(["done", "rejected", "deleted", "expired"]);

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Speechmatics plugin client.
 *
 * Two distinct APIs, two distinct credentials:
 *  - the regional ASR REST API (`https://{region}.asr.api.speechmatics.com/v2`)
 *    authenticated with the batch API key, and
 *  - the Management API (`https://mp.api.speechmatics.com/v1`) authenticated
 *    with a workspace management token.
 */
export class SpeechmaticsClient implements PluginClient {
  private readonly apiKey: string;
  private readonly region: string;
  private readonly managementToken: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Speechmatics plugin: missing apiKey credential");
    const region = (credentials["region"] ?? "eu1").trim().toLowerCase();
    if (!(VALID_REGIONS as readonly string[]).includes(region)) {
      throw new Error(
        `Speechmatics plugin: unknown region "${region}" (expected one of ${VALID_REGIONS.join(", ")})`,
      );
    }
    this.apiKey = apiKey;
    this.region = region;
    this.managementToken = credentials["managementToken"] ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** Regional batch endpoint. Jobs are not portable between regions. */
  private get baseUrl(): string {
    return `https://${this.region}.asr.api.speechmatics.com/v2`;
  }

  /** Same host, v1 prefix — where `/discovery/features` lives. */
  private get discoveryUrl(): string {
    return `https://${this.region}.asr.api.speechmatics.com/v1/discovery/features`;
  }

  /**
   * Always hand `jsonRestFetch` the host HTTP service when there is one — it
   * is the only path that picks up bastion egress routing and the custom CA.
   */
  private get transportOptions():
    | Record<string, never>
    | { http: NonNullable<HostServices["http"]> }
    | { http: NonNullable<HostServices["http"]>; caCert: string } {
    const http = this.services?.http;
    if (!http) return {};
    return this.caCert ? { http, caCert: this.caCert } : { http };
  }

  /* ---------------------------------------------------------------------- */
  /* HTTP                                                                     */
  /* ---------------------------------------------------------------------- */

  /** JSON call against the regional batch API. */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: VENDOR,
      url: `${this.baseUrl}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...this.transportOptions,
    });
  }

  /**
   * JSON call against the Management API — different host, different token.
   * https://docs.speechmatics.com/api-ref/management/get-all-projects
   */
  private async managementFetch<T>(path: string, options?: RequestInit): Promise<T> {
    if (!this.managementToken) {
      throw new Error(
        "Speechmatics plugin: this resource needs a management token. Add one to the account (Portal › Manage workspace › Management tokens).",
      );
    }
    return jsonRestFetch<T>({
      vendor: `${VENDOR} Management`,
      url: `${MANAGEMENT_BASE_URL}${path}`,
      errorPath: path,
      headers: { Authorization: `Bearer ${this.managementToken}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...this.transportOptions,
    });
  }

  /**
   * Non-JSON GET against the regional batch API. `?format=txt` and `?format=srt`
   * return `text/plain`, so they must not go through `jsonRestFetch`, which
   * always parses the body as JSON.
   */
  private async fetchText(path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "text/plain" };
    if (this.services?.http) {
      const res = await this.services.http.request({
        url,
        method: "GET",
        headers,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`${VENDOR} API error ${res.status} for ${path}: ${res.body}`);
      }
      return res.body;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`${VENDOR} API error ${res.status} for ${path}: ${await res.text()}`);
    }
    return res.text();
  }

  /**
   * Build a `multipart/form-data` body by hand.
   *
   * `jsonRestFetch`'s `bodyForHostHttp` explicitly does not support `FormData`
   * (it would `String()` it into garbage), but it *does* pass a `Uint8Array`
   * through untouched — so assembling the multipart bytes ourselves keeps the
   * upload on the host HTTP service, and therefore keeps bastion egress
   * routing and the custom CA working.
   */
  private buildMultipartBody(
    boundary: string,
    configJson: string,
    audio: Uint8Array,
    fileName: string,
    mimeType: string,
  ): Uint8Array {
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="config"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        `${configJson}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="data_file"; filename="${fileName}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + audio.length + tail.length);
    body.set(head, 0);
    body.set(audio, head.length);
    body.set(tail, head.length + audio.length);
    return body;
  }

  /**
   * `POST /v2/jobs` — multipart with exactly two parts, `config` (a JSON
   * *string*) and `data_file`. Returns 201 `{"id": "…"}`.
   * https://docs.speechmatics.com/batch.yaml
   */
  private async submitJob(
    configJson: string,
    audio: Uint8Array,
    fileName: string,
    mimeType: string,
    query: string,
  ): Promise<CreateJobResponse> {
    const boundary = `----infrawrench${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const body = this.buildMultipartBody(boundary, configJson, audio, fileName, mimeType);
    const path = `/jobs${query}`;
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };

    if (this.services?.http) {
      const res = await this.services.http.request({
        url,
        method: "POST",
        headers,
        body,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`${VENDOR} API error ${res.status} for ${path}: ${res.body}`);
      }
      return JSON.parse(res.body) as CreateJobResponse;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: body as unknown as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`${VENDOR} API error ${res.status} for ${path}: ${await res.text()}`);
    }
    return (await res.json()) as CreateJobResponse;
  }

  /* ---------------------------------------------------------------------- */
  /* Discovery                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * `GET /v1/discovery/features` — unauthenticated, and the only endpoint any
   * of our speech providers exposes that enumerates live language packs. Used
   * to fill the Speech tab's language picker with real ids instead of a list
   * baked into this file.
   */
  private async fetchDiscovery(): Promise<StashedDiscovery> {
    const data = await jsonRestFetch<DiscoveryFeatures>({
      vendor: VENDOR,
      url: this.discoveryUrl,
      errorPath: "/v1/discovery/features",
      headers: { Accept: "application/json" },
      ...this.transportOptions,
    });
    return condenseDiscovery(data);
  }

  /** Discovery is a nicety, never a hard dependency — fall back on failure. */
  private async fetchDiscoverySafe(): Promise<StashedDiscovery> {
    try {
      return await this.fetchDiscovery();
    } catch {
      return { languages: FALLBACK_LANGUAGES, models: MODEL_OPTIONS };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Listing                                                                  */
  /* ---------------------------------------------------------------------- */

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "job":
        return this.listJobs(accountId);
      case "project":
        return this.listProjects(accountId);
      case "api-key":
        return this.listApiKeys(accountId);
      default:
        throw new Error(`Speechmatics plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * `GET /v2/jobs` with the documented cursor pagination: `limit` (1–100) plus
   * `created_before`, a UTC timestamp that walks backwards from the most
   * recent job. Bounded so a busy workspace can't stall the sidebar.
   */
  private async listJobs(accountId: string): Promise<ResourceInstance[]> {
    const pageSize = 100;
    const maxPages = 5;
    const seen = new Set<string>();
    const jobs: SpeechmaticsJob[] = [];
    let createdBefore: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ limit: String(pageSize) });
      if (createdBefore) params.set("created_before", createdBefore);
      const res = await this.fetch<RetrieveJobsResponse>(`/jobs?${params.toString()}`);
      const batch = res?.jobs ?? [];
      let added = 0;
      for (const job of batch) {
        if (!job?.id || seen.has(job.id)) continue;
        seen.add(job.id);
        jobs.push(job);
        added++;
      }
      // Stop when the page is short (last page) or the cursor stopped moving.
      if (batch.length < pageSize || added === 0) break;
      const oldest = batch[batch.length - 1];
      if (!oldest?.created_at) break;
      createdBefore = oldest.created_at;
    }

    return jobs.map((job) => this.mapJob(job, accountId));
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    if (!this.managementToken) return [];
    const projects = await this.managementFetch<ManagementProject[]>("/projects");
    return (projects ?? []).map((project) => this.mapProject(project, accountId));
  }

  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    if (!this.managementToken) return [];
    const keys = await this.managementFetch<ManagementApiKey[]>("/api-keys");
    return (keys ?? []).map((key) => this.mapApiKey(key, accountId));
  }

  /* ---------------------------------------------------------------------- */
  /* Mapping                                                                  */
  /* ---------------------------------------------------------------------- */

  private jobTranscriptUrl(jobId: string): string {
    return `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/transcript?format=txt`;
  }

  private mapJob(job: SpeechmaticsJob, accountId: string): ResourceInstance {
    const tc = job.config?.transcription_config;
    // `operating_point` is the deprecated spelling of `model` and still comes
    // back on jobs submitted before the rename.
    const model = tc?.model ?? tc?.operating_point ?? "";
    const language = tc?.language ?? job.lang ?? "";
    const fields: Record<string, string | number | boolean> = {
      jobId: job.id,
      status: job.status,
      region: this.region,
      dataName: job.data_name ?? job.text_name ?? "",
      language,
      model,
      jobType: job.config?.type ?? "transcription",
      createdAt: job.created_at ?? "",
    };
    if (typeof job.duration === "number") fields["durationSeconds"] = job.duration;

    return {
      id: `${accountId}:job:${job.id}`,
      pluginId: "speechmatics",
      resourceTypeId: "job",
      accountId,
      displayName: job.data_name || job.id,
      fields,
      resolvedOutputs: {
        jobId: job.id,
        region: this.region,
        status: job.status,
        transcriptUrl: this.jobTranscriptUrl(job.id),
      },
      secretStates: [],
      externalId: job.id,
      createdAt: job.created_at ?? new Date().toISOString(),
      updatedAt: job.created_at ?? new Date().toISOString(),
    };
  }

  private mapProject(project: ManagementProject, accountId: string): ResourceInstance {
    const id = String(project.project_id);
    const name = project.name ?? `Project ${id}`;
    return {
      id: `${accountId}:project:${id}`,
      pluginId: "speechmatics",
      resourceTypeId: "project",
      accountId,
      displayName: name,
      fields: {
        projectId: id,
        name,
        description: project.description ?? "",
        isDefault: project.is_default === true,
        isActive: project.is_active !== false,
        createdAt: project.created_at ?? "",
      },
      resolvedOutputs: { projectId: id, projectName: name },
      secretStates: [],
      externalId: id,
      createdAt: project.created_at ?? new Date().toISOString(),
      updatedAt: project.created_at ?? new Date().toISOString(),
    };
  }

  private mapApiKey(key: ManagementApiKey, accountId: string): ResourceInstance {
    const name = key.name ?? key.apikey_id;
    return {
      id: `${accountId}:api-key:${key.apikey_id}`,
      pluginId: "speechmatics",
      resourceTypeId: "api-key",
      accountId,
      displayName: name,
      fields: {
        apiKeyId: key.apikey_id,
        name,
        clientRef: key.client_ref ?? "",
        projectId: "",
        createdAt: key.created_at ?? "",
      },
      resolvedOutputs: { apiKeyId: key.apikey_id, apiKeyName: name },
      secretStates: [],
      externalId: key.apikey_id,
      createdAt: key.created_at ?? new Date().toISOString(),
      updatedAt: key.created_at ?? new Date().toISOString(),
    };
  }

  /** `"{accountId}:{typeId}:{externalId}"` → `externalId`. */
  private externalId(resourceId: string): string {
    const parts = resourceId.split(":");
    return parts.length >= 3 ? parts.slice(2).join(":") : resourceId;
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                    */
  /* ---------------------------------------------------------------------- */

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "job") {
      const jobId = this.externalId(resourceId);
      // `GET /v2/jobs/{jobid}` — https://docs.speechmatics.com/batch.yaml
      const [detail, discovery] = await Promise.all([
        this.fetch<RetrieveJobResponse>(`/jobs/${encodeURIComponent(jobId)}`),
        // `renderDetail` is synchronous, so the Speech tab's pickers have to be
        // resolved here and smuggled through `resolvedOutputs`.
        this.fetchDiscoverySafe(),
      ]);
      if (!detail?.job) throw new Error(`Speechmatics plugin: job ${jobId} not found`);
      const instance = this.mapJob(detail.job, accountId);
      instance.resolvedOutputs[DISCOVERY_STASH_KEY] = JSON.stringify(discovery);
      return instance;
    }

    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) {
      throw new Error(`Speechmatics plugin: resource ${typeId}/${resourceId} not found`);
    }
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    // Region and the transcript URL are derivable without a round trip.
    if (typeId === "job") {
      const jobId = this.externalId(resourceId);
      if (outputKey === "jobId") return jobId;
      if (outputKey === "region") return this.region;
      if (outputKey === "transcriptUrl") return this.jobTranscriptUrl(jobId);
    }
    if (typeId === "project" && outputKey === "projectId") return this.externalId(resourceId);
    if (typeId === "api-key" && outputKey === "apiKeyId") return this.externalId(resourceId);

    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;

    throw new Error(
      `Speechmatics plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
    );
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    switch (resourceTypeId) {
      case "job": {
        const status = String(f["status"] ?? "");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "done"
                ? "status-healthy"
                : status === "rejected"
                  ? "status-error"
                  : "default",
          },
          { label: "Duration", value: formatDuration(Number(f["durationSeconds"] ?? 0)) },
          { label: "Model", value: String(f["model"] || "—") },
          { label: "Region", value: String(f["region"] ?? "") },
        ];
      }
      case "project":
        return [
          { label: "Project ID", value: String(f["projectId"] ?? "") },
          { label: "Default", value: f["isDefault"] ? "Yes" : "No" },
          { label: "Active", value: f["isActive"] ? "Yes" : "No" },
        ];
      case "api-key":
        return [
          { label: "Key ID", value: String(f["apiKeyId"] ?? "") },
          { label: "Created", value: String(f["createdAt"] || "—") },
        ];
      default:
        return [];
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Usage metrics                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Account usage over the requested window, from
   * `GET /v2/usage?since=&until=` (ISO calendar dates, both inclusive).
   *
   * The endpoint only returns totals for whatever window you ask for, so a
   * time series means asking several times. The range is split into at most
   * ten whole-day buckets, requested in parallel.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "job") return [];

    const dayMs = 86_400_000;
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 30 * dayMs;
    const totalDays = Math.max(1, Math.ceil((endMs - startMs) / dayMs));
    const buckets = Math.min(totalDays, 10);
    const daysPerBucket = Math.ceil(totalDays / buckets);

    const windows: Array<{ startMs: number; since: string; until: string }> = [];
    for (let i = 0; i < buckets; i++) {
      const bucketStart = startMs + i * daysPerBucket * dayMs;
      if (bucketStart > endMs) break;
      const bucketEnd = Math.min(bucketStart + (daysPerBucket - 1) * dayMs, endMs);
      windows.push({
        startMs: bucketStart,
        since: isoDate(bucketStart),
        until: isoDate(bucketEnd),
      });
    }

    const responses = await Promise.all(
      windows.map(async (w) => {
        try {
          const params = new URLSearchParams({ since: w.since, until: w.until });
          return await this.fetch<UsageResponse>(`/usage?${params.toString()}`);
        } catch {
          return undefined;
        }
      }),
    );

    const hours: MetricSeries = { label: "Transcription hours", unit: "h", points: [] };
    const counts: MetricSeries = { label: "Billable jobs", unit: "jobs", points: [] };
    responses.forEach((usage, i) => {
      const window = windows[i];
      if (!window || !usage) return;
      const rows = usage.summary?.length ? usage.summary : (usage.details ?? []);
      let totalHours = 0;
      let totalCount = 0;
      for (const row of rows) {
        totalHours += row.duration_hrs ?? 0;
        totalCount += row.count ?? 0;
      }
      hours.points.push({ timestamp: window.startMs, value: Number(totalHours.toFixed(3)) });
      counts.points.push({ timestamp: window.startMs, value: totalCount });
    });

    return [hours, counts];
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                                */
  /* ---------------------------------------------------------------------- */

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId === "job") {
      // `DELETE /v2/jobs/{jobid}?force=true` — without `force` a still-running
      // job answers HTTP 423 Locked instead of being removed.
      const jobId = this.externalId(resourceId);
      await this.fetch<unknown>(`/jobs/${encodeURIComponent(jobId)}?force=true`, {
        method: "DELETE",
      });
      return;
    }
    if (typeId === "api-key") {
      // `DELETE /api-keys/{apikey_id}` on the Management API.
      const keyId = this.externalId(resourceId);
      await this.managementFetch<unknown>(`/api-keys/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
      });
      return;
    }
    throw new Error(`Speechmatics plugin: deleteResource not supported for type "${typeId}"`);
  }

  /* ---------------------------------------------------------------------- */
  /* Speech tab                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Submit → (wait) → poll → fetch, all inside one call, bounded at
   * {@link TOTAL_TIMEOUT_MS}.
   *
   * The happy path is a single request: `POST /v2/jobs?wait=60&format=txt`
   * blocks until the job reaches a terminal state and embeds the transcript
   * under `txt`. Embedding is documented as best-effort, so everything after
   * that is the fallback.
   */
  async transcribeAudio(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    if (typeId !== "job") {
      throw new Error(`Speechmatics plugin: transcribeAudio not supported for type "${typeId}"`);
    }
    if (!payload.audioBase64) throw new Error("Speechmatics plugin: no audio supplied");

    const startedAt = Date.now();
    const deadline = startedAt + TOTAL_TIMEOUT_MS;

    // Plugins run in Node (server / Electron main), so Buffer is the right
    // decoder here — `atob` would hand back a binary string.
    const audio = new Uint8Array(Buffer.from(payload.audioBase64, "base64"));
    if (audio.length === 0) throw new Error("Speechmatics plugin: decoded audio is empty");
    if (audio.length > MAX_AUDIO_BYTES) {
      throw new Error(
        `Speechmatics plugin: clip is ${audio.length} bytes; the multipart job endpoint rejects anything over 1 GB`,
      );
    }

    const model = payload.modelId || "enhanced";
    // melia-1 is documented as batch-only and as requiring `"language": "multi"`.
    const language = model === MELIA_MODEL ? MULTILINGUAL_LANGUAGE : payload.language || "en";
    const configJson = JSON.stringify({
      type: "transcription",
      transcription_config: { language, model },
    });

    const mimeType = payload.mimeType || "application/octet-stream";
    const fileName = payload.fileName || `clip.${extensionForMime(mimeType)}`;

    const created = await this.submitJob(
      configJson,
      audio,
      fileName,
      mimeType,
      `?wait=${SYNC_WAIT_SECONDS}&format=txt`,
    );
    const jobId = created.id;
    if (!jobId) throw new Error("Speechmatics plugin: job submission returned no id");

    // The sync-mode status enum is `created | done | rejected | deleted` — a
    // different set to the async lifecycle enum on `GET /jobs/{id}`.
    if (created.status === "rejected") {
      throw new Error(`Speechmatics job ${jobId} was rejected before it could be transcribed`);
    }
    if (created.status === "deleted") {
      throw new Error(`Speechmatics job ${jobId} was deleted before it could finish`);
    }

    let text = typeof created.txt === "string" ? created.txt : undefined;

    if (text === undefined) {
      // Either `wait` elapsed with the job still running, or the transcript
      // simply was not embedded — both land here.
      const finalStatus = await this.waitForTerminalStatus(jobId, deadline);
      if (finalStatus === "rejected") {
        throw new Error(`Speechmatics job ${jobId} was rejected by the transcriber`);
      }
      if (finalStatus === "expired" || finalStatus === "deleted") {
        throw new Error(
          `Speechmatics job ${jobId} is no longer available (status "${finalStatus}")`,
        );
      }
      // Format is a query parameter here, not an Accept header.
      text = await this.fetchText(`/jobs/${encodeURIComponent(jobId)}/transcript?format=txt`);
    }

    // Best-effort enrichment: json-v2 carries word timings, per-word
    // confidence, speaker labels and the clip's measured duration.
    let words: TranscriptWord[] | undefined;
    let confidence: number | undefined;
    let durationSeconds: number | undefined;
    let detectedLanguage: string | undefined;
    try {
      const jsonV2 = await this.fetch<TranscriptJsonV2>(
        `/jobs/${encodeURIComponent(jobId)}/transcript?format=json-v2`,
      );
      const extracted = extractWords(jsonV2);
      if (extracted.words.length > 0) words = extracted.words;
      confidence = extracted.confidence;
      durationSeconds = jsonV2.job?.duration;
      detectedLanguage = jsonV2.metadata?.transcription_config?.language ?? undefined;
    } catch {
      // Timings are a bonus; the plain text stands on its own.
    }

    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summaryParts = [
      `job ${jobId}`,
      `model ${model}`,
      `language ${detectedLanguage ?? language}`,
      `${this.region} region`,
    ];
    if (typeof durationSeconds === "number") {
      summaryParts.push(`${formatDuration(durationSeconds)} audio`);
    }
    summaryParts.push(`${elapsedSeconds}s round trip`);
    summaryParts.push("transcript expires in 7 days");

    return {
      text: (text ?? "").trim(),
      summary: summaryParts.join(" · "),
      language: detectedLanguage ?? language,
      requestId: jobId,
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(words ? { words } : {}),
    };
  }

  /** Poll `GET /v2/jobs/{id}` until it lands on a terminal status. */
  private async waitForTerminalStatus(jobId: string, deadline: number): Promise<string> {
    for (;;) {
      const res = await this.fetch<RetrieveJobResponse>(`/jobs/${encodeURIComponent(jobId)}`);
      const status = res?.job?.status ?? "running";
      if (TERMINAL_STATUSES.has(status)) return status;
      if (Date.now() + POLL_INTERVAL_MS >= deadline) {
        throw new Error(
          `Speechmatics job ${jobId} did not finish within ${Math.round(TOTAL_TIMEOUT_MS / 1000)}s. It is still running — open the job from the sidebar to read the transcript once it lands.`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ---------------------------------------------------------------------- */

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "job":
        return this.renderJobDetail(resource);
      case "project":
        return this.renderProjectDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      default:
        return {
          title: resource.displayName,
          sections: [{ kind: "section", title: "Overview", children: [] }],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    switch (resource.resourceTypeId) {
      case "job": {
        const status = String(resource.fields["status"] ?? "");
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: jobStatusDot(status), label: status || "unknown" },
        };
      }
      case "project": {
        const isDefault = resource.fields["isDefault"] === true;
        const isActive = resource.fields["isActive"] !== false;
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: isActive ? "healthy" : "degraded",
            label: isDefault ? "Default" : isActive ? "Active" : "Inactive",
          },
        };
      }
      case "api-key":
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "info", label: "API key" },
        };
      default:
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "info" },
        };
    }
  }

  private renderJobDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const status = String(f["status"] ?? "");
    const region = String(f["region"] ?? this.region);
    const model = String(f["model"] ?? "");
    const language = String(f["language"] ?? "");
    const durationSeconds = Number(f["durationSeconds"] ?? 0);
    const transcriptUrl =
      resource.resolvedOutputs["transcriptUrl"] ??
      this.jobTranscriptUrl(String(f["jobId"] ?? resource.externalId ?? ""));

    const discovery = parseStashedDiscovery(resource.resolvedOutputs[DISCOVERY_STASH_KEY]);

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Job",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Job ID", value: String(f["jobId"] ?? ""), copyable: true },
              { key: "Status", value: status || "unknown" },
              { key: "Type", value: String(f["jobType"] ?? "transcription") },
              { key: "Audio file", value: String(f["dataName"] || "—") },
              {
                key: "Duration",
                value: durationSeconds > 0 ? formatDuration(durationSeconds) : "—",
              },
              { key: "Created", value: String(f["createdAt"] || "—") },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Transcription",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Language", value: language || "—" },
              { key: "Model", value: model || "—" },
              { key: "Region", value: region },
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "Jobs are region-scoped: this job can only be read from the " +
              `${region} endpoint. Audio, transcript and config are kept for 7 days, after which ` +
              "the transcript endpoints return HTTP 404 and the job reports status “expired”.",
          },
        ],
      },
      {
        kind: "section",
        title: "Transcript",
        children: [
          { kind: "text", variant: "mono", content: transcriptUrl, copyable: true },
          {
            kind: "text",
            variant: "muted",
            content:
              "Append ?format=txt, ?format=srt or ?format=json-v2 — the output format is a query " +
              "parameter, not an Accept header.",
          },
        ],
      },
    ];

    if (status === "rejected") {
      sections[0]?.children.push({
        kind: "text",
        variant: "muted",
        content:
          "This job was accepted but later could not be processed by the transcriber. The job log (GET /v2/jobs/{id}/log) usually explains why.",
      });
    }

    return {
      title: resource.displayName,
      subtitle: `Speechmatics batch job · ${region}`,
      status: { kind: "status-dot", status: jobStatusDot(status), label: status || "unknown" },
      sections,
      headerActions: [
        {
          kind: "action",
          label: "Open Speechmatics Portal",
          action: { type: "open-url", url: "https://portal.speechmatics.com/" },
          variant: "ghost",
        },
      ],
      metricsCapability: { defaultTimeRangeMs: 30 * 86_400_000 },
      speechPanel: {
        modes: ["stt"],
        tabLabel: "Speech",
        subtitle: `Speechmatics batch transcription · ${region} · results are kept for 7 days`,
        helpText:
          "Record or upload a clip and it is submitted as a batch job with ?wait=60, so the " +
          "transcript comes back in the same request. Longer clips fall back to polling, capped " +
          "at two minutes. Melia-1 is multilingual only — picking it forces the language to “multi”.",
        languages: discovery.languages,
        defaultLanguage: "en",
        languageLabel: "Language pack",
        models: discovery.models,
        defaultModel: "enhanced",
        modelLabel: "Model",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        maxAudioBytes: MAX_AUDIO_BYTES,
        transcribeLabel: "Transcribe",
      },
    };
  }

  private renderProjectDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Speechmatics project",
      status: {
        kind: "status-dot",
        status: f["isActive"] === false ? "degraded" : "healthy",
        label: f["isDefault"] === true ? "Default" : "Active",
      },
      sections: [
        {
          kind: "section",
          title: "Project",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Project ID", value: String(f["projectId"] ?? ""), copyable: true },
                { key: "Name", value: String(f["name"] ?? "") },
                { key: "Description", value: String(f["description"] || "—") },
                { key: "Default project", value: f["isDefault"] === true ? "Yes" : "No" },
                { key: "Active", value: f["isActive"] === false ? "No" : "Yes" },
                { key: "Created", value: String(f["createdAt"] || "—") },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Projects isolate API keys, transcripts and usage from each other. They are read " +
                "through the Management API (https://mp.api.speechmatics.com/v1) using the account's " +
                "management token — the batch API key cannot see them.",
            },
          ],
        },
      ],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Speechmatics API key",
      status: { kind: "status-dot", status: "info", label: "API key" },
      sections: [
        {
          kind: "section",
          title: "API key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key ID", value: String(f["apiKeyId"] ?? ""), copyable: true },
                { key: "Name", value: String(f["name"] ?? "") },
                { key: "Client reference", value: String(f["clientRef"] || "—") },
                { key: "Created", value: String(f["createdAt"] || "—") },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "Speechmatics only reveals the key value once, when it is created, so only metadata " +
                "is shown here. Deleting a key takes effect immediately for every client using it.",
            },
          ],
        },
      ],
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function jobStatusDot(
  status: string,
): "healthy" | "degraded" | "error" | "unknown" | "provisioning" | "info" {
  switch (status) {
    case "done":
      return "healthy";
    case "running":
      return "provisioning";
    case "rejected":
      return "error";
    case "expired":
      return "degraded";
    case "deleted":
      return "unknown";
    default:
      return "info";
  }
}

/** Rough container guess for the multipart filename. Speechmatics sniffs the data anyway. */
function extensionForMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/aac":
      return "aac";
    case "audio/ogg":
    case "audio/webm":
      return "ogg";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/amr":
      return "amr";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "video/mp4":
      return "mp4";
    default:
      return "audio";
  }
}

/**
 * Reduce the discovery payload down to picker options.
 *
 * Language ids come from `batch.transcription[].languages` (the packs the batch
 * engine will actually accept), labelled from
 * `metadata.language_pack_info[id].language_description`. `multi` is appended
 * because melia-1 needs it and discovery does not list it as a pack.
 */
function condenseDiscovery(data: DiscoveryFeatures): StashedDiscovery {
  const packInfo = data.metadata?.language_pack_info ?? {};
  const batchLanguages = data.batch?.transcription?.[0]?.languages ?? [];
  const ids = batchLanguages.length > 0 ? batchLanguages : Object.keys(packInfo);

  const languages: SpeechPanelOption[] = ids
    .map((id) => {
      const description = packInfo[id]?.language_description;
      return { id, label: description ? `${description} (${id})` : id };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  if (languages.length === 0) return { languages: FALLBACK_LANGUAGES, models: MODEL_OPTIONS };

  languages.push({
    id: MULTILINGUAL_LANGUAGE,
    label: "Multilingual (multi)",
    description: "Required by the melia-1 model.",
  });

  return { languages, models: MODEL_OPTIONS };
}

function parseStashedDiscovery(raw: string | undefined): StashedDiscovery {
  if (!raw) return { languages: FALLBACK_LANGUAGES, models: MODEL_OPTIONS };
  try {
    const parsed = JSON.parse(raw) as Partial<StashedDiscovery>;
    const languages =
      Array.isArray(parsed.languages) && parsed.languages.length > 0
        ? parsed.languages
        : FALLBACK_LANGUAGES;
    const models =
      Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed.models : MODEL_OPTIONS;
    return { languages, models };
  } catch {
    return { languages: FALLBACK_LANGUAGES, models: MODEL_OPTIONS };
  }
}

/**
 * Pull word timings out of a json-v2 transcript. Only `type: "word"` items
 * become rows — punctuation carries no useful timing for the table — and the
 * mean of their confidences stands in for an overall score, which the API
 * does not report directly.
 */
function extractWords(transcript: TranscriptJsonV2): {
  words: TranscriptWord[];
  confidence: number | undefined;
} {
  const words: TranscriptWord[] = [];
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const result of transcript.results ?? []) {
    if (result.type !== "word") continue;
    const alt = result.alternatives?.[0];
    const content = alt?.content;
    if (!content) continue;
    const word: TranscriptWord = { text: content };
    if (typeof result.start_time === "number") word.start = result.start_time;
    if (typeof result.end_time === "number") word.end = result.end_time;
    const speaker = alt?.speaker ?? result.channel;
    if (speaker) word.speaker = speaker;
    words.push(word);
    if (typeof alt?.confidence === "number") {
      confidenceSum += alt.confidence;
      confidenceCount++;
    }
  }

  return {
    words,
    confidence:
      confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(4)) : undefined,
  };
}
