import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";
import { buildMultipartBody } from "./multipart.js";
import {
  baseUrlForRegion,
  REVAI_DEFAULT_LANGUAGE,
  REVAI_DEFAULT_TRANSCRIBER,
  REVAI_LANGUAGE_OPTIONS,
  REVAI_PANEL_TRANSCRIBER_OPTIONS,
  REVAI_REGIONS,
} from "./options.js";

/** The single account pseudo-resource's external id. */
const ACCOUNT_ID = "self";

/**
 * One of only two transcript formats Rev AI accepts (the other is
 * `text/plain`). The wildcard Accept header that both `fetch` and curl send by
 * default is rejected with **406**, so an explicit Accept is mandatory on
 * `/jobs/{id}/transcript`.
 */
const TRANSCRIPT_JSON_ACCEPT = "application/vnd.rev.transcript.v1.0+json";

const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 5;

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_WAIT_MS = 120_000;

/**
 * Largest clip the Speech panel will accept, in bytes.
 *
 * This is deliberately far below the provider's own ceiling. The panel ships
 * audio base64-encoded inside a JSON body, and base64 inflates by 4/3 — with
 * the web ingress at `proxy-body-size: 36m` the real raw-audio ceiling is
 * ~27 MB, and a clip large enough to matter also blows up `FileReader`
 * (`RangeError: Invalid string length`) before it ever reaches the network.
 * The transport is the binding constraint here, not the API.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Rev AI accepts 2 GB; our transport does not.
const MAX_AUDIO_HOURS = 17;

const ACCEPTED_AUDIO_TYPES = [
  "audio/*",
  "video/*",
  ".mp3",
  ".mp4",
  ".m4a",
  ".wav",
  ".flac",
  ".ogg",
  ".opus",
  ".webm",
  ".mov",
];

interface RevAiAccount {
  email?: string;
  free_balance?: number;
  purchased_balance?: number;
  total_balance?: number;
  invoiced_balance?: number;
  hipaa_enabled?: boolean;
}

interface RevAiJob {
  id?: string;
  status?: string;
  type?: string;
  created_on?: string;
  completed_on?: string;
  duration_seconds?: number;
  media_url?: string;
  name?: string;
  metadata?: string;
  language?: string;
  transcriber?: string;
  failure?: string;
  failure_detail?: string;
  delete_after_seconds?: number;
  custom_vocabulary_id?: string;
}

interface RevAiVocabulary {
  id?: string;
  status?: string;
  created_on?: string;
  completed_on?: string;
  metadata?: string;
  failure?: string;
  failure_detail?: string;
  callback_url?: string;
}

interface RevAiTranscriptElement {
  type?: string;
  value?: string;
  ts?: number;
  end_ts?: number;
  confidence?: number;
}

interface RevAiTranscript {
  monologues?: Array<{ speaker?: number; elements?: RevAiTranscriptElement[] }>;
}

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function usd(value: unknown): string {
  const n = num(value);
  return n === undefined ? "—" : `$${n.toFixed(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobStatusDot(status: string): "healthy" | "error" | "provisioning" | "info" {
  if (status === "transcribed") return "healthy";
  if (status === "failed") return "error";
  if (status === "in_progress") return "provisioning";
  return "info";
}

function vocabularyStatusDot(status: string): "healthy" | "error" | "provisioning" | "info" {
  // The enum is `complete`, not `completed`.
  if (status === "complete") return "healthy";
  if (status === "failed") return "error";
  if (status === "in_progress") return "provisioning";
  return "info";
}

/**
 * Assemble the transcript exactly the way Rev AI intends.
 *
 * Every element is concatenated — including the `punct` ones, which is where
 * the spaces live. Joining with `" "` instead would double every space and
 * push punctuation off its word.
 */
export function assembleTranscript(transcript: RevAiTranscript): string {
  return (transcript.monologues ?? [])
    .flatMap((monologue) => monologue.elements ?? [])
    .map((element) => str(element.value))
    .join("");
}

/**
 * Rev AI plugin client.
 *
 * Auth is `Authorization: Bearer <token>`. Jobs live in the deployment they
 * were submitted to, so the account's region selects the host for every call.
 */
export class RevAiClient implements PluginClient {
  private readonly accessToken: string;
  private readonly region: string;
  private readonly baseUrl: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const accessToken = credentials["accessToken"];
    if (!accessToken) throw new Error("Rev AI plugin: missing accessToken credential");
    this.accessToken = accessToken;
    this.region = credentials["region"] || "us";
    this.baseUrl = baseUrlForRegion(this.region);
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** Custom vocabularies are a US-deployment-only collection. */
  private get supportsVocabularies(): boolean {
    return this.region !== "eu";
  }

  private headers(accept = "application/json"): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, Accept: accept };
  }

  private async fetch<T>(path: string, options?: RequestInit, accept?: string): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "Rev AI",
        url: `${this.baseUrl}${path}`,
        errorPath: path,
        headers: this.headers(accept),
        ...(options ? { init: options } : {}),
        ...(this.services?.http ? { http: this.services.http } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
    } catch (error) {
      throw this.explainError(error, path);
    }
  }

  /**
   * Issue a request whose response body we do not want parsed as JSON — the
   * `DELETE` endpoints answer 204 with no body.
   */
  private async requestVoid(path: string, method: string): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    let status: number;
    let body: string;

    if (this.services?.http) {
      const result = await this.services.http.request({
        url,
        method,
        headers: this.headers(),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      status = result.status;
      body = result.body;
    } else {
      const res = await fetch(url, { method, headers: this.headers() });
      status = res.status;
      body = res.ok ? "" : await res.text();
    }

    if (status < 200 || status >= 300) {
      throw this.explainError(new Error(`Rev AI API error ${status} for ${path}: ${body}`), path);
    }
  }

  /**
   * Rewrite Rev AI's less obvious status codes into something a user can act
   * on. 405 in particular does not mean "method not allowed" here — Rev AI
   * uses it for "Invalid Job Properties".
   */
  private explainError(error: unknown, path: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);

    if (status === 405) {
      return new Error(
        `Rev AI rejected the job's properties for ${path} (HTTP 405 — Rev AI uses 405 for ` +
          `"Invalid Job Properties", not "method not allowed"). Check transcriber, language and ` +
          `diarization options against the job. Original: ${message}`,
      );
    }
    if (status === 406) {
      return new Error(
        `Rev AI refused the requested output format for ${path} (HTTP 406). The transcript ` +
          `endpoint only accepts "${TRANSCRIPT_JSON_ACCEPT}" or "text/plain" — "*/*" is rejected. ` +
          `Original: ${message}`,
      );
    }
    if (status === 409) {
      return new Error(
        `Rev AI job is in the wrong state for ${path} (HTTP 409). A job can only be fetched or ` +
          `deleted once it is "transcribed" or "failed". Original: ${message}`,
      );
    }
    if (status === 413) {
      return new Error(
        `Rev AI rejected the upload for ${path} as too large (HTTP 413). Multipart uploads are ` +
          `capped at 2 GB. Original: ${message}`,
      );
    }
    return error instanceof Error ? error : new Error(message);
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "account":
        return [await this.buildAccount(accountId)];
      case "job": {
        const jobs = await this.fetchJobs();
        return jobs.map((job) => this.mapJob(accountId, job));
      }
      case "vocabulary": {
        if (!this.supportsVocabularies) return [];
        const vocabularies = await this.fetchVocabularies();
        return vocabularies.map((vocabulary) => this.mapVocabulary(accountId, vocabulary));
      }
      default:
        throw new Error(`Rev AI plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "account") return this.buildAccount(accountId);

    if (typeId === "job") {
      const job = await this.fetchJob(externalId);
      const resource = this.mapJob(accountId, job);
      // renderDetail is synchronous, so the transcript has to be fetched here
      // and stashed in resolvedOutputs (Cloudflare's `__consumers__` pattern).
      if (str(job.status) === "transcribed") {
        try {
          const transcript = await this.fetchTranscript(externalId);
          resource.resolvedOutputs["__transcript__"] = assembleTranscript(transcript);
        } catch {
          // A transcript that can't be fetched shouldn't blank the whole page.
          resource.resolvedOutputs["__transcript__"] = "";
        }
      }
      return resource;
    }

    if (typeId === "vocabulary") {
      const vocabulary = await this.fetchVocabulary(externalId);
      return this.mapVocabulary(accountId, vocabulary);
    }

    throw new Error(`Rev AI plugin: unknown resource type "${typeId}"`);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "account") {
      if (outputKey === "endpoint") return this.baseUrl;
      if (outputKey === "email") return str((await this.fetchAccount()).email);
    }

    if (typeId === "job") {
      if (outputKey === "jobId") return externalId;
      if (outputKey === "transcriptUrl") {
        return `${this.baseUrl}/jobs/${encodeURIComponent(externalId)}/transcript`;
      }
      if (outputKey === "transcriptText") {
        const job = await this.fetchJob(externalId);
        if (str(job.status) !== "transcribed") return "";
        return assembleTranscript(await this.fetchTranscript(externalId));
      }
    }

    if (typeId === "vocabulary" && outputKey === "vocabularyId") return externalId;

    throw new Error(`Rev AI plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === "account") {
      // The USD balances are the live numbers; `balance_seconds` is deprecated
      // and always 0, so it is never shown.
      const account = await this.fetchAccount();
      const total = num(account.total_balance) ?? 0;
      return [
        {
          label: "Total balance",
          value: usd(account.total_balance),
          variant: total <= 0 ? "status-degraded" : "status-healthy",
        },
        { label: "Free", value: usd(account.free_balance) },
        { label: "Purchased", value: usd(account.purchased_balance) },
      ];
    }

    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const fields = resource.fields;

    if (resourceTypeId === "job") {
      const status = String(fields["status"] ?? "");
      return [
        {
          label: "Status",
          value: status,
          variant:
            status === "failed"
              ? "status-error"
              : status === "transcribed"
                ? "status-healthy"
                : "default",
        },
        { label: "Duration", value: `${round(Number(fields["durationSeconds"] ?? 0), 1)} s` },
        { label: "Transcriber", value: String(fields["transcriber"] ?? "—") },
      ];
    }

    if (resourceTypeId === "vocabulary") {
      return [
        { label: "Status", value: String(fields["status"] ?? "—") },
        { label: "Created", value: String(fields["createdOn"] ?? "—") },
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "account":
        return this.renderAccountDetail(resource);
      case "job":
        return this.renderJobDetail(resource);
      case "vocabulary":
        return this.renderVocabularyDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
          sections: [
            {
              kind: "section",
              title: "Resource",
              children: [{ kind: "text", content: resource.resourceTypeId }],
            },
          ],
          headerActions: [],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const status = String(resource.fields["status"] ?? "");
    if (resource.resourceTypeId === "job") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: jobStatusDot(status) },
      };
    }
    if (resource.resourceTypeId === "vocabulary") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: vocabularyStatusDot(status) },
      };
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "vocabulary") {
      if (!this.supportsVocabularies) {
        throw new Error(
          "Rev AI plugin: the EU deployment has no /vocabularies collection — supply phrases " +
            "inline on the job via `custom_vocabularies` instead.",
        );
      }
      return {
        fields: [
          {
            key: "phrases",
            label: "Phrases",
            kind: "string-list",
            required: true,
            description:
              "Technical jargon, proper nouns and uncommon phrases Rev AI should bias toward.",
          },
          {
            key: "metadata",
            label: "Metadata",
            kind: "text",
            required: false,
            description: "Optional free-text label echoed back on the vocabulary (max 512 chars).",
          },
        ],
      };
    }

    throw new Error(`Rev AI plugin: no create config for type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "vocabulary") {
      throw new Error(`Rev AI plugin: cannot create type "${typeId}"`);
    }

    const phrases = (fields["phrases"] ?? "")
      .split(",")
      .map((phrase) => phrase.trim())
      .filter(Boolean);
    if (phrases.length === 0) {
      throw new Error("Rev AI plugin: a custom vocabulary needs at least one phrase");
    }

    const metadata = fields["metadata"] ?? "";
    // POST /vocabularies — verified 2026-07-28 against
    // https://docs.rev.ai/api/custom-vocabulary/reference/vocabularies/submitcustomvocabulary.md
    const created = await this.fetch<RevAiVocabulary>("/vocabularies", {
      method: "POST",
      body: JSON.stringify({
        custom_vocabularies: [{ phrases }],
        ...(metadata ? { metadata } : {}),
      }),
    });

    return this.mapVocabulary(accountId, created);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "job") {
      // DELETE /jobs/{id} — 204 No Content. 409 when the job is still
      // in_progress: only transcribed/failed jobs are deletable.
      await this.requestVoid(`/jobs/${encodeURIComponent(externalId)}`, "DELETE");
      return;
    }

    if (typeId === "vocabulary") {
      if (!this.supportsVocabularies) {
        throw new Error("Rev AI plugin: the EU deployment has no /vocabularies collection");
      }
      // DELETE /vocabularies/{id} — 204 No Content, 409 while in_progress.
      await this.requestVoid(`/vocabularies/${encodeURIComponent(externalId)}`, "DELETE");
      return;
    }

    throw new Error(`Rev AI plugin: cannot delete type "${typeId}"`);
  }

  /**
   * Full submit → poll → fetch cycle for the Speech tab's STT half.
   *
   * Rev AI is async-only, so the whole thing happens inside this one call with
   * a bounded poll loop; the panel is one request/response and never gets a
   * job id to poll on its own.
   */
  async transcribeAudio(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    if (typeId !== "account") {
      throw new Error(`Rev AI plugin: cannot transcribe audio for type "${typeId}"`);
    }

    const bytes = new Uint8Array(Buffer.from(payload.audioBase64, "base64"));
    if (bytes.byteLength === 0) throw new Error("Rev AI plugin: empty audio payload");
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(
        `Rev AI plugin: clip is ${bytes.byteLength} bytes, over the documented 2 GB multipart limit`,
      );
    }

    const transcriber =
      payload.modelId && payload.modelId.length > 0 ? payload.modelId : REVAI_DEFAULT_TRANSCRIBER;
    const options: Record<string, unknown> = {
      transcriber,
      metadata: "Infrawrench Speech tab",
    };
    if (payload.language) options["language"] = payload.language;

    const started = Date.now();
    const submitted = await this.submitJob(
      bytes,
      payload.fileName ?? "clip",
      payload.mimeType,
      options,
    );
    const jobId = str(submitted.id);
    if (!jobId) throw new Error("Rev AI plugin: POST /jobs returned no job id");

    const job = await this.pollJob(jobId);
    const transcript = await this.fetchTranscript(jobId);
    const elapsedMs = Date.now() - started;

    const words: TranscriptWord[] = [];
    for (const monologue of transcript.monologues ?? []) {
      const speaker =
        typeof monologue.speaker === "number" ? `Speaker ${monologue.speaker}` : undefined;
      for (const element of monologue.elements ?? []) {
        // Only `text` elements carry timings; `punct` and `unknown` are
        // structural and belong in the string, not the word table.
        if (element.type !== "text") continue;
        const text = str(element.value);
        if (!text) continue;
        words.push({
          text,
          ...(num(element.ts) !== undefined ? { start: num(element.ts)! } : {}),
          ...(num(element.end_ts) !== undefined ? { end: num(element.end_ts)! } : {}),
          ...(speaker ? { speaker } : {}),
        });
      }
    }

    const confidences = (transcript.monologues ?? [])
      .flatMap((monologue) => monologue.elements ?? [])
      .map((element) => num(element.confidence))
      .filter((value): value is number => value !== undefined);
    const confidence =
      confidences.length > 0
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : undefined;

    const duration = num(job.duration_seconds);
    const language = str(job.language) || undefined;

    const summaryParts = [`transcriber ${str(job.transcriber) || transcriber}`];
    if (duration !== undefined) summaryParts.push(`${round(duration, 1)} s of audio`);
    summaryParts.push(`${words.length} words`);
    summaryParts.push(`${round(elapsedMs / 1000, 1)} s round-trip`);

    return {
      text: assembleTranscript(transcript),
      summary: summaryParts.join(" · "),
      ...(language ? { language } : {}),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(words.length > 0 ? { words } : {}),
      requestId: jobId,
    };
  }

  /**
   * POST /jobs (multipart) — verified 2026-07-28 against
   * https://docs.rev.ai/api/asynchronous/reference/jobs/submittranscriptionjob.md
   *
   * Exactly two parts: `media` (the bytes) and `options` (a JSON **string**).
   * The response is HTTP **200**, not 201, and omits every null property.
   *
   * The body is encoded by hand (see ./multipart.ts) instead of using
   * `FormData`, so the call still routes through the host HTTP service and
   * keeps bastion egress + a custom CA. The clip's Content-Type is whatever
   * MediaRecorder or the file picker produced — forwarded verbatim.
   */
  private async submitJob(
    bytes: Uint8Array,
    filename: string,
    mimeType: string,
    options: Record<string, unknown>,
  ): Promise<RevAiJob> {
    const { body, contentType } = buildMultipartBody([
      {
        name: "media",
        filename,
        contentType: mimeType || "application/octet-stream",
        data: bytes,
      },
      { name: "options", value: JSON.stringify(options) },
    ]);

    return this.fetch<RevAiJob>("/jobs", {
      method: "POST",
      headers: { "Content-Type": contentType },
      // `BodyInit` in the DOM lib doesn't admit a plain `Uint8Array<ArrayBufferLike>`,
      // but both `fetch` and `bodyForHostHttp` handle one at runtime — the latter
      // has an explicit `instanceof Uint8Array` branch, which is the path that
      // keeps this upload on the host's bastion-routed HTTP service.
      body: body as unknown as BodyInit,
    });
  }

  /** Poll `GET /jobs/{id}` until it leaves `in_progress`. Only 3 statuses exist. */
  private async pollJob(jobId: string): Promise<RevAiJob> {
    const deadline = Date.now() + MAX_POLL_WAIT_MS;

    for (;;) {
      const job = await this.fetchJob(jobId);
      const status = str(job.status);

      if (status === "transcribed") return job;
      if (status === "failed") {
        const reason = str(job.failure_detail) || str(job.failure) || "no reason reported";
        throw new Error(`Rev AI job ${jobId} failed: ${reason}`);
      }

      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        throw new Error(
          `Rev AI job ${jobId} was still "${status || "in_progress"}" after ` +
            `${Math.round(MAX_POLL_WAIT_MS / 1000)} s. The job is still running — open it under ` +
            "Transcription Jobs once it finishes.",
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * GET /jobs/{id} — verified 2026-07-28 against
   * https://docs.rev.ai/api/asynchronous/reference/
   */
  private async fetchJob(jobId: string): Promise<RevAiJob> {
    return this.fetch<RevAiJob>(`/jobs/${encodeURIComponent(jobId)}`);
  }

  /**
   * GET /jobs — verified 2026-07-28. Returns a **bare JSON array** (no
   * envelope), newest first, covering only the last 30 days. Paging walks the
   * last id of each page through `starting_after`.
   */
  private async fetchJobs(): Promise<RevAiJob[]> {
    const out: RevAiJob[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) query.set("starting_after", cursor);
      const jobs = await this.fetch<RevAiJob[]>(`/jobs?${query.toString()}`);
      if (!Array.isArray(jobs) || jobs.length === 0) break;
      out.push(...jobs);
      const last = jobs[jobs.length - 1];
      const lastId = str(last?.id);
      if (!lastId || jobs.length < PAGE_SIZE) break;
      cursor = lastId;
    }

    return out;
  }

  /**
   * GET /jobs/{id}/transcript — verified 2026-07-28.
   *
   * The output format is an **Accept header**, and the wildcard Accept that
   * `fetch` and curl send by default is rejected with 406, so the header is
   * always set explicitly here.
   */
  private async fetchTranscript(jobId: string): Promise<RevAiTranscript> {
    return this.fetch<RevAiTranscript>(
      `/jobs/${encodeURIComponent(jobId)}/transcript`,
      undefined,
      TRANSCRIPT_JSON_ACCEPT,
    );
  }

  /**
   * GET /account — verified 2026-07-28. Returns the USD balances;
   * `balance_seconds` is deprecated and always 0, so it is never read.
   */
  private async fetchAccount(): Promise<RevAiAccount> {
    return this.fetch<RevAiAccount>("/account");
  }

  /** GET /vocabularies — most recent custom vocabularies. US deployment only. */
  private async fetchVocabularies(): Promise<RevAiVocabulary[]> {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    const list = await this.fetch<RevAiVocabulary[]>(`/vocabularies?${query.toString()}`);
    return Array.isArray(list) ? list : [];
  }

  /** GET /vocabularies/{id}. */
  private async fetchVocabulary(id: string): Promise<RevAiVocabulary> {
    return this.fetch<RevAiVocabulary>(`/vocabularies/${encodeURIComponent(id)}`);
  }

  private async buildAccount(accountId: string): Promise<ResourceInstance> {
    let account: RevAiAccount = {};
    try {
      account = await this.fetchAccount();
    } catch {
      // Keep the account navigable (and the Speech tab usable) even when
      // /account is unreachable.
      account = {};
    }

    const now = new Date().toISOString();
    return {
      id: `${accountId}:account:${ACCOUNT_ID}`,
      pluginId: "revai",
      resourceTypeId: "account",
      accountId,
      displayName: str(account.email) || "Rev AI",
      externalId: ACCOUNT_ID,
      fields: {
        email: str(account.email),
        region: this.region,
        endpoint: this.baseUrl,
        freeBalance: num(account.free_balance) ?? 0,
        purchasedBalance: num(account.purchased_balance) ?? 0,
        totalBalance: num(account.total_balance) ?? 0,
        invoicedBalance: num(account.invoiced_balance) ?? 0,
        hipaaEnabled: account.hipaa_enabled === true,
      },
      resolvedOutputs: { endpoint: this.baseUrl, email: str(account.email) },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapJob(accountId: string, job: RevAiJob): ResourceInstance {
    const id = str(job.id);
    const createdOn = str(job.created_on) || new Date().toISOString();
    const completedOn = str(job.completed_on);

    return {
      id: `${accountId}:job:${id}`,
      pluginId: "revai",
      resourceTypeId: "job",
      accountId,
      displayName: str(job.name) || str(job.metadata) || id || "job",
      externalId: id,
      // Every property here is optional on the wire: Rev AI omits nulls from
      // responses rather than sending them, so a missing key is normal.
      fields: {
        status: str(job.status),
        name: str(job.name),
        durationSeconds: num(job.duration_seconds) ?? 0,
        transcriber: str(job.transcriber),
        language: str(job.language),
        createdOn,
        completedOn,
        failure: str(job.failure),
        failureDetail: str(job.failure_detail),
        mediaUrl: str(job.media_url),
        metadata: str(job.metadata),
        deleteAfterSeconds: num(job.delete_after_seconds) ?? 0,
        type: str(job.type),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: createdOn,
      updatedAt: completedOn || createdOn,
    };
  }

  private mapVocabulary(accountId: string, vocabulary: RevAiVocabulary): ResourceInstance {
    const id = str(vocabulary.id);
    const createdOn = str(vocabulary.created_on) || new Date().toISOString();
    const completedOn = str(vocabulary.completed_on);

    return {
      id: `${accountId}:vocabulary:${id}`,
      pluginId: "revai",
      resourceTypeId: "vocabulary",
      accountId,
      displayName: str(vocabulary.metadata) || id || "vocabulary",
      externalId: id,
      fields: {
        status: str(vocabulary.status),
        metadata: str(vocabulary.metadata),
        createdOn,
        completedOn,
        failure: str(vocabulary.failure),
        failureDetail: str(vocabulary.failure_detail),
        callbackUrl: str(vocabulary.callback_url),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: createdOn,
      updatedAt: completedOn || createdOn,
    };
  }

  private renderAccountDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const region = String(fields["region"] ?? "us");
    const regionInfo = REVAI_REGIONS.find((candidate) => candidate.id === region);

    return {
      title: resource.displayName,
      subtitle: `Rev AI · ${regionInfo ? regionInfo.location : region}`,
      status: {
        kind: "status-dot",
        status: Number(fields["totalBalance"] ?? 0) > 0 ? "healthy" : "degraded",
      },
      sections: [
        {
          kind: "section",
          title: "Account",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Email", value: String(fields["email"] ?? "") || "—" },
                {
                  key: "Deployment",
                  value: regionInfo ? `${regionInfo.flag} ${regionInfo.location}` : region,
                },
                { key: "API Base", value: String(fields["endpoint"] ?? ""), copyable: true },
                { key: "HIPAA", value: fields["hipaaEnabled"] === true ? "Enabled" : "Disabled" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Balance",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Total", value: usd(fields["totalBalance"]) },
                { key: "Free", value: usd(fields["freeBalance"]) },
                { key: "Purchased", value: usd(fields["purchasedBalance"]) },
                { key: "Invoiced", value: usd(fields["invoicedBalance"]) },
              ],
            },
            {
              kind: "text",
              // Deliberately absent: `balance_seconds`. It is deprecated and
              // always returns 0, so showing it would read as "out of credit".
              content:
                "Balances are USD. Rev AI's `balance_seconds` field is deprecated and always " +
                "returns 0, so it is not shown here.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      speechPanel: {
        modes: ["stt"],
        tabLabel: "Speech",
        subtitle: `Transcribe a clip with Rev AI (${regionInfo ? regionInfo.label : region} deployment)`,
        helpText:
          "Rev AI is asynchronous: the clip is posted to /jobs as multipart, then this panel " +
          `polls the job for up to ${Math.round(MAX_POLL_WAIT_MS / 1000)} seconds and fetches the ` +
          `transcript. Limits are 2 GB and ${MAX_AUDIO_HOURS} hours per request. Only the ` +
          "automatic transcribers are offered here — human transcription takes hours to come " +
          "back, bills at human rates the moment the job is accepted, and could only ever time " +
          "out in this panel; order it through Rev AI directly.",
        languages: REVAI_LANGUAGE_OPTIONS,
        defaultLanguage: REVAI_DEFAULT_LANGUAGE,
        languageLabel: "Language",
        models: REVAI_PANEL_TRANSCRIBER_OPTIONS,
        defaultModel: REVAI_DEFAULT_TRANSCRIBER,
        modelLabel: "Transcriber",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        maxAudioBytes: MAX_AUDIO_BYTES,
        transcribeLabel: "Transcribe",
      },
    };
  }

  private renderJobDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const transcript = String(resource.resolvedOutputs["__transcript__"] ?? "");

    const sections: DetailViewSchema["sections"] = [
      {
        kind: "section",
        title: "Job",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Status", value: status || "—" },
              { key: "Transcriber", value: String(fields["transcriber"] ?? "") || "—" },
              { key: "Language", value: String(fields["language"] ?? "") || "—" },
              { key: "Type", value: String(fields["type"] ?? "") || "—" },
              { key: "Created", value: String(fields["createdOn"] ?? "") || "—" },
              { key: "Completed", value: String(fields["completedOn"] ?? "") || "—" },
              { key: "Metadata", value: String(fields["metadata"] ?? "") || "—" },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Media",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(fields["name"] ?? "") || "—" },
              {
                key: "Duration",
                value: `${round(Number(fields["durationSeconds"] ?? 0), 2)} s`,
              },
              { key: "Media URL", value: String(fields["mediaUrl"] ?? "") || "— (uploaded file)" },
              {
                key: "Auto-delete After",
                value: Number(fields["deleteAfterSeconds"] ?? 0)
                  ? `${fields["deleteAfterSeconds"]} s`
                  : "—",
              },
            ],
          },
        ],
      },
    ];

    if (status === "failed") {
      sections.push({
        kind: "section",
        title: "Failure",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Reason", value: String(fields["failure"] ?? "") || "—" },
              { key: "Detail", value: String(fields["failureDetail"] ?? "") || "—" },
            ],
          },
        ],
      });
    }

    sections.push({
      kind: "section",
      title: "Transcript",
      children: [
        transcript
          ? { kind: "text", content: transcript, variant: "body", copyable: true }
          : {
              kind: "text",
              content:
                status === "transcribed"
                  ? "Rev AI returned no transcript text for this job."
                  : 'The transcript appears once the job reaches status "transcribed".',
              variant: "muted",
            },
      ],
    });

    return {
      title: resource.displayName,
      subtitle: `Rev AI job · ${status || "unknown"}`,
      status: { kind: "status-dot", status: jobStatusDot(status) },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderVocabularyDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `Rev AI custom vocabulary · ${status || "unknown"}`,
      status: { kind: "status-dot", status: vocabularyStatusDot(status) },
      sections: [
        {
          kind: "section",
          title: "Vocabulary",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "ID", value: resource.externalId ?? "", copyable: true },
                { key: "Status", value: status || "—" },
                { key: "Metadata", value: String(fields["metadata"] ?? "") || "—" },
                { key: "Created", value: String(fields["createdOn"] ?? "") || "—" },
                { key: "Completed", value: String(fields["completedOn"] ?? "") || "—" },
                { key: "Callback URL", value: String(fields["callbackUrl"] ?? "") || "—" },
              ],
            },
            {
              kind: "text",
              content:
                "Reference this id as `custom_vocabulary_id` when submitting a job. Rev AI does " +
                "not return the stored phrase list, so it cannot be shown here.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}
