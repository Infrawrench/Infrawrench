import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
  SpeechPanelOption,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import {
  base64ToBytes,
  externalIdOf,
  buildMultipartBody,
  ListTruncatedError,
  pathEncode,
  requireListPage,
  rethrowIncompleteList,
} from "@infrawrench/plugin-base";
import {
  BASE_URL,
  createGladiaApi,
  deleteJobRequest,
  postAudioUpload,
  VENDOR,
  type GladiaApi,
  type GladiaConnection,
  type GladiaJob,
  type GladiaJobParams,
  type InitTranscriptionBody,
} from "./api.js";
import {
  GLADIA_AUTO_LANGUAGE,
  GLADIA_DEFAULT_MODEL,
  GLADIA_LANGUAGE_OPTIONS,
  GLADIA_MODEL_OPTIONS,
} from "./languages.js";

/** The single workspace pseudo-resource's external id. */
const WORKSPACE_ID = "default";

/** Page size for the job lists; the envelope carries no total and the document no maximum. */
const PAGE_SIZE = 50;

/** 50,000 jobs per list. A sync prunes what a list leaves out, so past this it throws. */
const MAX_LIST_PAGES = 1000;

/** The workspace's activity panel sums a sample of 200 jobs per list, and says so. */
const MAX_SAMPLE_PAGES = 4;

/** Page size and page cap for the Metrics walk: at most 2,000 jobs per endpoint. */
const METRICS_PAGE_SIZE = 100;
const MAX_METRICS_PAGES = 20;
const DAY_MS = 86_400_000;

/** Poll cadence for a pre-recorded job. The docs' own sample polls at 1 s. */
const POLL_INTERVAL_MS = 3000;

/** Total budget for the submit → poll → fetch cycle inside one panel request. */
const MAX_POLL_WAIT_MS = 120_000;

/**
 * Largest clip the Speech panel will accept, in bytes.
 *
 * This is deliberately far below the provider's own ceiling. The panel ships
 * audio base64-encoded inside a JSON body, and base64 inflates by 4/3: with
 * the web ingress at `proxy-body-size: 36m` the real raw-audio ceiling is
 * ~27 MB, and a clip large enough to matter also blows up `FileReader`
 * (`RangeError: Invalid string length`) before it ever reaches the network.
 * The transport is the binding constraint here, not the API.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Gladia accepts 1000 MB; our transport does not.
const MAX_AUDIO_MINUTES = 135;

/**
 * The two job collections. Pre-recorded and live jobs share one response
 * shape (`kind` tells them apart) but live under different paths, and a live
 * job is only ever created over the streaming handshake, never from here.
 */
type JobTypeId = "transcription" | "live-session";
const JOB_PATHS = {
  transcription: "/v2/pre-recorded",
  "live-session": "/v2/live",
} as const;

function isJobType(typeId: string): typeId is JobTypeId {
  return typeId === "transcription" || typeId === "live-session";
}

const ACCEPTED_AUDIO_TYPES = [
  "audio/*",
  "video/*",
  ".aac",
  ".ac3",
  ".eac3",
  ".flac",
  ".m4a",
  ".mp2",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
];

function num(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusDot(status: string): "healthy" | "degraded" | "error" | "provisioning" | "info" {
  switch (status) {
    case "done":
      return "healthy";
    case "error":
      return "error";
    case "processing":
      return "provisioning";
    case "queued":
      return "degraded";
    default:
      return "info";
  }
}

/**
 * Gladia plugin client.
 *
 * Auth is `x-gladia-key: <key>`: Gladia does not use Bearer. Every endpoint
 * used here is verified against https://docs.gladia.io/api-reference (see the
 * per-method comments).
 */
export class GladiaClient implements PluginClient {
  private readonly connection: GladiaConnection;
  private readonly api: GladiaApi;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Gladia plugin: missing apiKey credential");
    this.connection = { apiKey, caCert: credentials["caCert"] ?? "", http: services?.http };
    this.api = createGladiaApi(this.connection);
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "workspace":
          return [await this.buildWorkspace(accountId)];
        case "transcription":
        case "live-session": {
          const jobs = await this.fetchJobs(typeId);
          return jobs.map((job) => this.mapJob(accountId, job, typeId));
        }
        default:
          throw new Error(`Gladia plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "workspace") return this.buildWorkspace(accountId);

      if (isJobType(typeId)) {
        const job = await this.fetchJob(externalIdOf(resourceId), typeId);
        return this.mapJob(accountId, job, typeId);
      }

      throw new Error(`Gladia plugin: unknown resource type "${typeId}"`);
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    _accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (typeId === "workspace" && outputKey === "endpoint") return BASE_URL;

      if (isJobType(typeId)) {
        const id = externalIdOf(resourceId);
        if (outputKey === "transcriptionId" || outputKey === "sessionId") return id;
        if (outputKey === "resultUrl") return `${BASE_URL}${JOB_PATHS[typeId]}/${id}`;
        if (outputKey === "fullTranscript") {
          const job = await this.fetchJob(id, typeId);
          // `result` is null unless status === "done": optional-chain it.
          return str(job.result?.transcription?.full_transcript);
        }
      }

      throw new Error(`Gladia plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const resource = await runPluginEffect(
        this.getResource(resourceTypeId, resourceId, accountId),
      );
      const fields = resource.fields;

      if (resourceTypeId === "workspace") {
        const billed = Number(fields["sampledBillingTime"] ?? 0);
        const errored = Number(fields["erroredJobs"] ?? 0);
        return [
          { label: "Recent jobs", value: String(fields["recentJobs"] ?? 0) },
          { label: "Billed (sampled)", value: `${round(billed / 60, 1)} min` },
          {
            label: "Errored",
            value: String(errored),
            variant: errored > 0 ? "status-degraded" : "default",
          },
        ];
      }

      if (isJobType(resourceTypeId)) {
        const status = String(fields["status"] ?? "");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "error"
                ? "status-error"
                : status === "done"
                  ? "status-healthy"
                  : "default",
          },
          { label: "Duration", value: `${round(Number(fields["audioDuration"] ?? 0), 1)} s` },
          { label: "Billed", value: `${round(Number(fields["billingTime"] ?? 0), 1)} s` },
        ];
      }

      return [];
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    if (resource.resourceTypeId === "workspace") return this.renderWorkspaceDetail(resource);
    if (isJobType(resource.resourceTypeId)) return this.renderTranscriptionDetail(resource);
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

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (isJobType(resource.resourceTypeId)) {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: statusDot(String(resource.fields["status"] ?? "")) },
      };
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      if (!isJobType(typeId)) {
        throw new Error(`Gladia plugin: cannot delete type "${typeId}"`);
      }
      // DELETE /v2/pre-recorded/{id} and DELETE /v2/live/{id}: verified against
      // https://docs.gladia.io/api-reference/v2/pre-recorded/delete and
      // https://docs.gladia.io/api-reference/v2/live/delete. Both answer 202
      // Accepted on success and 403 when the job is not in a deletable state.
      await deleteJobRequest(
        this.connection,
        `${JOB_PATHS[typeId]}/${pathEncode(externalIdOf(resourceId))}`,
      );
    });
  }

  /**
   * Full submit → poll → fetch cycle for the Speech tab's STT half.
   *
   * Gladia is async-only: upload the bytes, create a pre-recorded job, then
   * poll. The panel is one request/response, so the whole thing happens here
   * inside a bounded loop rather than handing a job id back to the UI.
   */
  transcribeAudio(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): PluginEffect<TranscribeAudioResult> {
    return attempt(async () => {
      if (typeId !== "workspace") {
        throw new Error(`Gladia plugin: cannot transcribe audio for type "${typeId}"`);
      }

      const bytes = base64ToBytes(payload.audioBase64);
      if (bytes.byteLength === 0) throw new Error("Gladia plugin: empty audio payload");
      if (bytes.byteLength > MAX_AUDIO_BYTES) {
        throw new Error(
          `Gladia plugin: clip is ${bytes.byteLength} bytes, over the documented ${MAX_AUDIO_BYTES}-byte limit`,
        );
      }

      const started = Date.now();
      const upload = await this.uploadAudio(bytes, payload.fileName ?? "clip", payload.mimeType);
      const audioUrl = str(upload.audio_url);
      if (!audioUrl) throw new Error("Gladia plugin: /v2/upload returned no audio_url");

      const model =
        payload.modelId && payload.modelId.length > 0 ? payload.modelId : GLADIA_DEFAULT_MODEL;
      const body: InitTranscriptionBody = {
        audio_url: audioUrl,
        diarization: true,
        model,
        // `language_config` is an object, and the docs explicitly warn against
        // enabling `code_switching` alongside an empty `languages` list, so for
        // auto-detect we omit the whole key rather than sending an empty one.
        ...(payload.language && payload.language !== GLADIA_AUTO_LANGUAGE
          ? { language_config: { languages: [payload.language], code_switching: false } }
          : {}),
      };

      const init = await this.initTranscription(body);
      const jobId = str(init.id);
      if (!jobId) throw new Error("Gladia plugin: /v2/pre-recorded returned no job id");

      const job = await this.pollJob(jobId);
      const elapsedMs = Date.now() - started;

      const transcription = job.result?.transcription;
      const metadata = job.result?.metadata;
      const utterances = transcription?.utterances ?? [];

      const words: TranscriptWord[] = [];
      for (const utterance of utterances) {
        const speaker =
          typeof utterance.speaker === "number" ? `Speaker ${utterance.speaker}` : undefined;
        for (const word of utterance.words ?? []) {
          const text = str(word.word);
          if (!text) continue;
          words.push({
            text,
            ...(num(word.start) !== undefined ? { start: num(word.start)! } : {}),
            ...(num(word.end) !== undefined ? { end: num(word.end)! } : {}),
            ...(speaker ? { speaker } : {}),
          });
        }
      }

      const confidences = utterances
        .map((utterance) => num(utterance.confidence))
        .filter((value): value is number => value !== undefined);
      const confidence =
        confidences.length > 0
          ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
          : undefined;

      const duration = num(metadata?.audio_duration);
      const billing = num(metadata?.billing_time);
      const language = transcription?.languages?.[0];

      const summaryParts = [model];
      if (duration !== undefined) summaryParts.push(`${round(duration, 1)} s of audio`);
      if (billing !== undefined) summaryParts.push(`${round(billing, 1)} s billed`);
      summaryParts.push(`${round(elapsedMs / 1000, 1)} s round-trip`);

      return {
        text: str(transcription?.full_transcript),
        summary: summaryParts.join(" · "),
        ...(language ? { language } : {}),
        ...(duration !== undefined ? { durationSeconds: duration } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
        ...(words.length > 0 ? { words } : {}),
        ...(jobId ? { requestId: jobId } : {}),
      };
    });
  }

  /**
   * POST /v2/upload: verified 2026-07-28 against
   * https://docs.gladia.io/api-reference/v2/upload/audio-file
   *
   * multipart/form-data with a single part named `audio`. The body is encoded
   * by hand (see ./multipart.ts) rather than handed to `FormData`, so the call
   * still goes through the host HTTP service and keeps bastion routing + CA.
   * The clip's Content-Type is whatever MediaRecorder or the file picker
   * produced: forwarded verbatim, never transcoded.
   */
  private uploadAudio(bytes: Uint8Array, filename: string, mimeType: string) {
    return postAudioUpload(
      this.connection,
      buildMultipartBody([
        {
          kind: "file",
          name: "audio",
          fileName: sanitizeUploadFilename(filename),
          contentType: mimeType || "application/octet-stream",
          data: bytes,
        },
      ]),
    );
  }

  /**
   * POST /v2/pre-recorded: verified 2026-07-28 against
   * https://docs.gladia.io/api-reference/v2/pre-recorded/init
   * Returns 201 `{id, result_url}`.
   */
  private initTranscription(body: InitTranscriptionBody) {
    return this.api.post("/v2/pre-recorded", { body });
  }

  /**
   * Poll `GET /v2/pre-recorded/{id}` until the job leaves `queued`/`processing`.
   *
   * A *failed* job comes back as HTTP 200 with `status: "error"`, so the body
   * is what decides success, never the status code.
   */
  private async pollJob(jobId: string): Promise<GladiaJob> {
    const deadline = Date.now() + MAX_POLL_WAIT_MS;

    for (;;) {
      const job = await this.fetchJob(jobId);
      const status = str(job.status);

      if (status === "done") return job;
      if (status === "error") {
        const code = num(job.error_code);
        throw new Error(
          `Gladia transcription ${jobId} failed${code !== undefined ? ` (error_code ${code})` : ""}. ` +
            'Gladia reports failures as HTTP 200 with status "error"; check the job in the Gladia dashboard for detail.',
        );
      }

      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        throw new Error(
          `Gladia transcription ${jobId} was still "${status || "queued"}" after ` +
            `${Math.round(MAX_POLL_WAIT_MS / 1000)} s. The job is still running; open it under ` +
            "Transcriptions once it finishes.",
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * GET /v2/pre-recorded/{id}: verified 2026-07-28 against
   * https://docs.gladia.io/api-reference/v2/pre-recorded/get
   */
  private async fetchJob(jobId: string, typeId: JobTypeId = "transcription"): Promise<GladiaJob> {
    return this.api.get(`${JOB_PATHS[typeId]}/${pathEncode(jobId)}`);
  }

  /**
   * GET /v2/pre-recorded and GET /v2/live: verified against
   * https://docs.gladia.io/api-reference/v2/pre-recorded/list and
   * https://docs.gladia.io/api-reference/v2/live/list
   *
   * The envelope is `{first, current, next, items}` with **no total**, so
   * paging follows `next` until it is null. A list that outruns `maxPages` throws
   * unless the read is `partial`.
   */
  private async walkJobs(
    typeId: JobTypeId,
    {
      pageSize = PAGE_SIZE,
      maxPages = MAX_LIST_PAGES,
      partial = false,
      window,
    }: {
      pageSize?: number;
      maxPages?: number;
      partial?: boolean;
      window?: { after_date: string; before_date: string };
    } = {},
  ): Promise<GladiaJob[]> {
    const path = JOB_PATHS[typeId];
    const out: GladiaJob[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      const body = await this.api.get(path, {
        query: { offset, limit: pageSize, ...window },
      });
      const items = requireListPage<GladiaJob>(body.items, {
        vendor: VENDOR,
        path,
        key: "items",
        page: body,
      });
      out.push(...items);
      if (!body.next || items.length === 0) return out;
      offset += items.length;
    }
    if (partial) return out;
    throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
  }

  /** Every job of one kind, for the inventory. */
  private fetchJobs(typeId: JobTypeId): Promise<GladiaJob[]> {
    return this.walkJobs(typeId);
  }

  /** The first jobs of one kind, for the workspace's activity sample. */
  private sampleJobs(typeId: JobTypeId): Promise<GladiaJob[]> {
    return this.walkJobs(typeId, { maxPages: MAX_SAMPLE_PAGES, partial: true }).catch(
      (err): GladiaJob[] => {
        rethrowIncompleteList(err);
        return [];
      },
    );
  }

  /**
   * Jobs of one kind created inside a window, using the list endpoints' own
   * `after_date`/`before_date` filters so the walk never pages past it. A chart
   * of a busy window draws what the cap holds.
   */
  private fetchJobsBetween(
    typeId: JobTypeId,
    startMs: number,
    endMs: number,
  ): Promise<GladiaJob[]> {
    return this.walkJobs(typeId, {
      pageSize: METRICS_PAGE_SIZE,
      maxPages: MAX_METRICS_PAGES,
      partial: true,
      window: {
        after_date: new Date(startMs).toISOString(),
        before_date: new Date(endMs).toISOString(),
      },
    });
  }

  /**
   * The workspace's Metrics tab. Gladia has no usage endpoint, so this is the
   * job history bucketed by day: pre-recorded jobs, failures, billed minutes
   * (`result.metadata.billing_time`, which is audio duration times distinct
   * channels) split by model when more than one is in use, processing time
   * (`transcription_time`), and the same counts for live sessions.
   * https://docs.gladia.io/api-reference/v2/pre-recorded/list
   * https://docs.gladia.io/api-reference/v2/live/list
   */
  fetchMetricSeries(
    resourceTypeId: string,
    _resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "workspace") return [];
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - 30 * DAY_MS;
      const [jobs, live] = await Promise.all([
        this.fetchJobsBetween("transcription", startMs, endMs),
        // Live history is a separate list; a failure there keeps the batch charts.
        this.fetchJobsBetween("live-session", startMs, endMs).catch((err): GladiaJob[] => {
          rethrowIncompleteList(err);
          return [];
        }),
      ]);

      const stamps: number[] = [];
      for (let t = Math.floor(startMs / DAY_MS) * DAY_MS; t <= endMs; t += DAY_MS) stamps.push(t);
      const dayOf = (job: GladiaJob): number | undefined => {
        const at = Date.parse(str(job.created_at));
        if (!Number.isFinite(at) || at < startMs || at > endMs) return undefined;
        return Math.floor(at / DAY_MS) * DAY_MS;
      };
      const tally = (items: GladiaJob[], read: (job: GladiaJob) => number): Map<number, number> => {
        const out = new Map<number, number>();
        for (const job of items) {
          const day = dayOf(job);
          if (day !== undefined) out.set(day, (out.get(day) ?? 0) + read(job));
        }
        return out;
      };
      const line = (label: string, unit: string, values: Map<number, number>): MetricSeries => ({
        label,
        unit,
        points: stamps.map((t) => ({
          timestamp: t,
          value: Number((values.get(t) ?? 0).toFixed(2)),
        })),
      });
      const billedMinutes = (job: GladiaJob): number =>
        (num(job.result?.metadata?.billing_time) ?? 0) / 60;

      const series: MetricSeries[] = [
        line(
          "Transcriptions",
          "count",
          tally(jobs, () => 1),
        ),
        line(
          "Failed transcriptions",
          "count",
          tally(jobs, (j) => (str(j.status) === "error" ? 1 : 0)),
        ),
        line("Billed minutes", "minutes", tally(jobs, billedMinutes)),
      ];
      const models = [...new Set(jobs.map((j) => str(j.request_params?.model)).filter(Boolean))];
      if (models.length > 1) {
        for (const model of models.sort()) {
          series.push(
            line(
              `Billed minutes: ${model}`,
              "minutes",
              tally(jobs, (j) => (str(j.request_params?.model) === model ? billedMinutes(j) : 0)),
            ),
          );
        }
      }
      // Average processing time per finished job; days without one are omitted
      // rather than plotted as zero.
      const processing = new Map<number, { sum: number; count: number }>();
      for (const job of jobs) {
        const day = dayOf(job);
        const seconds = num(job.result?.metadata?.transcription_time);
        if (day === undefined || seconds === undefined || str(job.status) !== "done") continue;
        const acc = processing.get(day) ?? { sum: 0, count: 0 };
        acc.sum += seconds;
        acc.count += 1;
        processing.set(day, acc);
      }
      if (processing.size > 0) {
        series.push({
          label: "Avg processing time",
          unit: "seconds",
          points: [...processing.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([timestamp, acc]) => ({
              timestamp,
              value: Number((acc.sum / acc.count).toFixed(1)),
            })),
        });
      }
      if (live.some((j) => dayOf(j) !== undefined)) {
        series.push(
          line(
            "Live sessions",
            "count",
            tally(live, () => 1),
          ),
          line("Live billed minutes", "minutes", tally(live, billedMinutes)),
        );
      }
      return series;
    });
  }

  private mapJob(
    accountId: string,
    job: GladiaJob,
    typeId: JobTypeId = "transcription",
  ): ResourceInstance {
    const id = str(job.id);
    const createdAt = str(job.created_at) || new Date().toISOString();
    const completedAt = typeof job.completed_at === "string" ? job.completed_at : "";
    const filename = str(job.file?.filename);
    const metadata = job.result?.metadata;
    const languages = job.result?.transcription?.languages ?? [];

    const params: GladiaJobParams | null | undefined = job.request_params;
    const streamFormat =
      typeId === "live-session"
        ? [
            params?.encoding,
            num(params?.sample_rate) ? `${params?.sample_rate} Hz` : undefined,
            num(params?.bit_depth) ? `${params?.bit_depth}-bit` : undefined,
            num(params?.channels) ? `${params?.channels} ch` : undefined,
          ]
            .filter(Boolean)
            .join(" · ")
        : "";

    return {
      id: `${accountId}:${typeId}:${id}`,
      pluginId: "gladia",
      resourceTypeId: typeId,
      accountId,
      displayName:
        filename ||
        (typeId === "live-session" && createdAt ? `Live ${createdAt.slice(0, 19)}` : "") ||
        id ||
        typeId,
      externalId: id,
      fields: {
        status: str(job.status),
        filename,
        audioDuration: num(job.file?.audio_duration) ?? num(metadata?.audio_duration) ?? 0,
        billingTime: num(metadata?.billing_time) ?? 0,
        transcriptionTime: num(metadata?.transcription_time) ?? 0,
        languages: languages.join(", "),
        channels:
          num(job.file?.number_of_channels) ?? num(metadata?.number_of_distinct_channels) ?? 0,
        createdAt,
        completedAt,
        errorCode: num(job.error_code) ?? 0,
        requestId: str(job.request_id),
        kind: str(job.kind),
        model: str(params?.model),
        ...(typeId === "live-session" ? { streamFormat } : {}),
      },
      resolvedOutputs: {
        // renderDetail is synchronous, so the transcript is stashed here by the
        // same call that fetched the job (Cloudflare's `__consumers__` pattern).
        __transcript__: str(job.result?.transcription?.full_transcript),
        __model__: str(job.request_params?.model),
      },
      secretStates: [],
      createdAt,
      updatedAt: completedAt || createdAt,
    };
  }

  private async buildWorkspace(accountId: string): Promise<ResourceInstance> {
    // A brand-new key with no history (or a transient list failure) should
    // still leave the workspace navigable and the Speech tab usable.
    const [jobs, liveJobs] = await Promise.all([
      this.sampleJobs("transcription"),
      this.sampleJobs("live-session"),
    ]);
    let liveBilling = 0;
    for (const job of liveJobs) liveBilling += num(job.result?.metadata?.billing_time) ?? 0;

    let done = 0;
    let errored = 0;
    let running = 0;
    let billing = 0;
    let audio = 0;
    let oldest = "";

    for (const job of jobs) {
      const status = str(job.status);
      if (status === "done") done++;
      else if (status === "error") errored++;
      else running++;

      billing += num(job.result?.metadata?.billing_time) ?? 0;
      audio += num(job.file?.audio_duration) ?? num(job.result?.metadata?.audio_duration) ?? 0;

      const createdAt = str(job.created_at);
      if (createdAt && (!oldest || createdAt < oldest)) oldest = createdAt;
    }

    const now = new Date().toISOString();
    return {
      id: `${accountId}:workspace:${WORKSPACE_ID}`,
      pluginId: "gladia",
      resourceTypeId: "workspace",
      accountId,
      displayName: "Gladia",
      externalId: WORKSPACE_ID,
      fields: {
        endpoint: BASE_URL,
        recentJobs: jobs.length,
        doneJobs: done,
        erroredJobs: errored,
        runningJobs: running,
        sampledBillingTime: round(billing, 2),
        sampledAudioDuration: round(audio, 2),
        oldestSampledAt: oldest,
        liveSessions: liveJobs.length,
        sampledLiveBillingTime: round(liveBilling, 2),
      },
      resolvedOutputs: { endpoint: BASE_URL },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private renderWorkspaceDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const sampled = Number(fields["recentJobs"] ?? 0);
    const billed = Number(fields["sampledBillingTime"] ?? 0);
    const audio = Number(fields["sampledAudioDuration"] ?? 0);
    const oldest = String(fields["oldestSampledAt"] ?? "");
    const liveBilled = Number(fields["sampledLiveBillingTime"] ?? 0);

    const languages: SpeechPanelOption[] = GLADIA_LANGUAGE_OPTIONS;

    return {
      title: "Gladia",
      subtitle: "Speech-to-text workspace",
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Endpoint",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "API Base", value: String(fields["endpoint"] ?? BASE_URL), copyable: true },
                { key: "Auth Header", value: "x-gladia-key" },
                { key: "Max Duration", value: `${MAX_AUDIO_MINUTES} minutes per request` },
                { key: "Max File Size", value: "1000 MB" },
              ],
            },
          ],
        },
        {
          kind: "section",
          // Deliberately not called "Usage": Gladia exposes no usage or quota
          // endpoint, so this is a sum over the transcription history and
          // nothing more.
          title: "Activity (derived from recent history)",
          children: [
            {
              kind: "text",
              content:
                "Gladia has no usage or quota endpoint. These figures are summed from the " +
                `${sampled} most recent job${sampled === 1 ? "" : "s"} returned by /v2/pre-recorded, ` +
                "not from a billing API, so they are a lower bound on real usage.",
              variant: "muted",
            },
            {
              kind: "key-value-list",
              items: [
                { key: "Jobs sampled", value: String(sampled) },
                { key: "Completed", value: String(fields["doneJobs"] ?? 0) },
                { key: "Errored", value: String(fields["erroredJobs"] ?? 0) },
                { key: "Queued / processing", value: String(fields["runningJobs"] ?? 0) },
                {
                  key: "Billed time (sampled)",
                  value: `${round(billed, 1)} s (${round(billed / 60, 1)} min)`,
                },
                {
                  key: "Audio duration (sampled)",
                  value: `${round(audio, 1)} s (${round(audio / 60, 1)} min)`,
                },
                { key: "Oldest job sampled", value: oldest || "—" },
                { key: "Live sessions sampled", value: String(fields["liveSessions"] ?? 0) },
                {
                  key: "Live billed time (sampled)",
                  value: `${round(liveBilled, 1)} s (${round(liveBilled / 60, 1)} min)`,
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      // Daily jobs, failures, billed minutes and processing time, bucketed
      // from the pre-recorded and live job history.
      metricsCapability: { defaultTimeRangeMs: 30 * DAY_MS },
      speechPanel: {
        modes: ["stt"],
        tabLabel: "Speech",
        subtitle: "Transcribe a clip with Gladia's pre-recorded API",
        helpText:
          "Gladia is asynchronous: the clip is uploaded, a job is created, and this panel polls " +
          `it for up to ${Math.round(MAX_POLL_WAIT_MS / 1000)} seconds. Diarization is on, so ` +
          `speaker labels appear in the word table. Limits are ${MAX_AUDIO_MINUTES} minutes and 1000 MB per request.`,
        languages,
        defaultLanguage: GLADIA_AUTO_LANGUAGE,
        languageLabel: "Language",
        models: GLADIA_MODEL_OPTIONS,
        defaultModel: GLADIA_DEFAULT_MODEL,
        modelLabel: "Model",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        maxAudioBytes: MAX_AUDIO_BYTES,
        transcribeLabel: "Transcribe",
      },
    };
  }

  private renderTranscriptionDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "");
    const transcript = String(resource.resolvedOutputs["__transcript__"] ?? "");
    const model = String(resource.resolvedOutputs["__model__"] ?? "");
    const errorCode = Number(fields["errorCode"] ?? 0);
    const isLive = resource.resourceTypeId === "live-session";
    const streamFormat = String(fields["streamFormat"] ?? "");

    const sections: DetailViewSchema["sections"] = [
      {
        kind: "section",
        title: "Job",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Status", value: status || "—" },
              { key: "Kind", value: String(fields["kind"] ?? "—") },
              { key: "Model", value: model || "—" },
              { key: "File", value: String(fields["filename"] ?? "—") },
              { key: "Created", value: String(fields["createdAt"] ?? "—") },
              { key: "Completed", value: String(fields["completedAt"] ?? "") || "—" },
              { key: "Request ID", value: String(fields["requestId"] ?? "—"), copyable: true },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Audio",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Duration", value: `${round(Number(fields["audioDuration"] ?? 0), 2)} s` },
              { key: "Channels", value: String(fields["channels"] ?? 0) },
              { key: "Billed Time", value: `${round(Number(fields["billingTime"] ?? 0), 2)} s` },
              {
                key: "Processing Time",
                value: `${round(Number(fields["transcriptionTime"] ?? 0), 2)} s`,
              },
              { key: "Languages", value: String(fields["languages"] ?? "") || "—" },
              ...(isLive ? [{ key: "Stream Format", value: streamFormat || "—" }] : []),
            ],
          },
        ],
      },
    ];

    if (status === "error") {
      sections.push({
        kind: "section",
        title: "Failure",
        children: [
          {
            kind: "text",
            content:
              `Gladia returned status "error"` +
              (errorCode ? ` with error_code ${errorCode}.` : ".") +
              " Failed jobs are reported as HTTP 200 with an error status, so the job body is the source of truth.",
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
                status === "done"
                  ? "Gladia returned no transcript text for this job."
                  : isLive
                    ? 'The transcript appears once the stream is closed and the session reaches status "done".'
                    : 'The transcript appears once the job reaches status "done".',
              variant: "muted",
            },
      ],
    });

    return {
      title: resource.displayName,
      subtitle: `${isLive ? "Gladia live session" : "Gladia transcription"} · ${status || "unknown"}`,
      status: { kind: "status-dot", status: statusDot(status) },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }
}

/**
 * Filenames arrive from a browser file picker, so they are untrusted: replace
 * anything that would break the `Content-Disposition` header, and never send
 * an empty name.
 */
function sanitizeUploadFilename(filename: string): string {
  const cleaned = filename.replace(/[\r\n"\\]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "audio";
}
