import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
  SpeechPanelCapability,
  SpeechPanelOption,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

const PLUGIN_ID = "assemblyai";
const TRANSCRIPT_TYPE = "transcript";

/**
 * The singleton pseudo-resource that stands in for the API key itself.
 *
 * Transcripts only exist once the key has been used, and are purged after 90
 * days, so they cannot be the only place the Speech tab lives — a fresh (or
 * long-idle) account would have nothing to open. `listResources` always returns
 * exactly one of these, whatever else is in the account.
 */
const ACCOUNT_TYPE = "account";
const ACCOUNT_ID = "default";

/** Hosts. https://www.assemblyai.com/docs/faq/do-you-offer-servers-in-the-eu */
const HOSTS: Record<string, string> = {
  us: "https://api.assemblyai.com",
  eu: "https://api.eu.assemblyai.com",
};

/**
 * How many transcripts a sync pulls. `limit` is capped at 200 by the API, and
 * the account's history is a rolling 90-day window anyway, so there is no
 * "complete" number to reach for — this is a recent-activity window.
 */
const LIST_LIMIT = 100;

/** Parallelism for the per-transcript hydration pass. Deliberately modest: a
 *  rate-limit violation comes back as a 403 that is indistinguishable from an
 *  auth failure, so it is not worth racing the ceiling. */
const HYDRATE_CONCURRENCY = 5;

/** Speech tab poll cadence and ceiling. AssemblyAI's own docs poll at 3 s. */
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 120_000;

/**
 * The Speech panel ships the clip base64-encoded inside an ordinary JSON
 * request, so the practical ceiling is far below the API's own 2.2 GB upload
 * cap. 64 MB of audio is minutes of speech — well past what a playground tab
 * is for — while still fitting comfortably in a JSON body.
 */
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
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // AssemblyAI accepts 2.2 GB; our transport does not.

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** https://www.assemblyai.com/docs/api-reference/transcripts/list */
interface TranscriptListItem {
  id: string;
  resource_url?: string;
  status?: string;
  created?: string;
  completed?: string | null;
  audio_url?: string;
  error?: string | null;
}

interface TranscriptListResponse {
  page_details?: {
    limit?: number;
    result_count?: number;
    current_url?: string;
    prev_url?: string | null;
    next_url?: string | null;
  };
  transcripts?: TranscriptListItem[];
}

/** https://www.assemblyai.com/docs/api-reference/transcripts/get */
interface TranscriptWordWire {
  text?: string;
  /** Milliseconds from the start of the clip — not seconds. */
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: string | null;
}

interface Transcript extends TranscriptListItem {
  text?: string | null;
  words?: TranscriptWordWire[] | null;
  confidence?: number | null;
  audio_duration?: number | null;
  language_code?: string | null;
  language_detection?: boolean;
  speaker_labels?: boolean;
  punctuate?: boolean;
  format_text?: boolean;
  speech_model?: string | null;
  speech_models?: string[] | null;
}

/** https://www.assemblyai.com/docs/api-reference/files/upload */
interface UploadResponse {
  upload_url?: string;
}

// ---------------------------------------------------------------------------
// Speech panel option lists
// ---------------------------------------------------------------------------

/**
 * The only two model ids the v2 API accepts. `slam-1` was retired and the
 * singular `speech_model` parameter is deprecated in favour of the
 * priority-ordered `speech_models` array.
 * https://www.assemblyai.com/docs/api-reference/transcripts/submit
 */
const SPEECH_MODELS: SpeechPanelOption[] = [
  {
    id: "universal-3-5-pro",
    label: "Universal-3.5 Pro",
    description:
      "Highest accuracy, 18 languages, keyterm prompts up to 1000 terms. First entry of AssemblyAI's own default model list.",
  },
  {
    id: "universal-2",
    label: "Universal-2",
    description:
      "Broadest coverage — 99 languages — and the model AssemblyAI falls back to when Universal-3.5 Pro cannot serve a request.",
  },
];

const DEFAULT_MODEL = "universal-3-5-pro";

/** Sentinel for "let AssemblyAI detect it" — sent as `language_detection: true`
 *  rather than a `language_code`, because the two are mutually exclusive. */
const AUTO_LANGUAGE = "auto";

/**
 * `language_code` is ISO-639-1 with an *underscored* region (`en_us`), not the
 * hyphenated BCP-47 tag most other providers want.
 * https://www.assemblyai.com/docs/speech-to-text/pre-recorded-audio/supported-languages
 */
const LANGUAGES: SpeechPanelOption[] = [
  {
    id: AUTO_LANGUAGE,
    label: "Auto-detect",
    description: "Sets language_detection instead of pinning a code.",
  },
  { id: "en", label: "English (global)" },
  { id: "en_us", label: "English (US)" },
  { id: "en_uk", label: "English (UK)" },
  { id: "en_au", label: "English (Australia)" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "ar", label: "Arabic" },
  { id: "hi", label: "Hindi" },
  { id: "ja", label: "Japanese" },
  { id: "zh", label: "Chinese" },
  { id: "tr", label: "Turkish" },
  { id: "vi", label: "Vietnamese" },
  { id: "da", label: "Danish" },
  { id: "fi", label: "Finnish" },
  { id: "he", label: "Hebrew" },
  { id: "no", label: "Norwegian" },
  { id: "sv", label: "Swedish" },
  { id: "ko", label: "Korean", description: "Universal-2 only." },
  { id: "pl", label: "Polish", description: "Universal-2 only." },
  { id: "ru", label: "Russian", description: "Universal-2 only." },
  { id: "uk", label: "Ukrainian", description: "Universal-2 only." },
  { id: "id", label: "Indonesian", description: "Universal-2 only." },
  { id: "th", label: "Thai", description: "Universal-2 only." },
];

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * AssemblyAI plugin client. One per account (per API key + region).
 *
 * Everything here goes through `authorization: <key>` with **no** `Bearer`
 * prefix — AssemblyAI's async API takes the bare key, and adding `Bearer`
 * fails auth.
 */
export class AssemblyAIClient implements PluginClient {
  private readonly apiKey: string;
  private readonly region: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("AssemblyAI plugin: missing apiKey credential");
    this.apiKey = apiKey;
    const region = (credentials["region"] ?? "us").toLowerCase();
    this.region = region in HOSTS ? region : "us";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private get baseUrl(): string {
    return HOSTS[this.region] ?? HOSTS["us"]!;
  }

  /** Bare key, no `Bearer`. */
  private get authHeaders(): Record<string, string> {
    return { authorization: this.apiKey, Accept: "application/json" };
  }

  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "AssemblyAI",
        url: `${this.baseUrl}${path}`,
        errorPath: path,
        headers: this.authHeaders,
        ...(options ? { init: options } : {}),
        ...(this.services?.http
          ? { http: this.services.http, ...(this.caCert ? { caCert: this.caCert } : {}) }
          : {}),
      });
    } catch (err) {
      throw annotateError(err);
    }
  }

  /**
   * Upload raw audio bytes. https://www.assemblyai.com/docs/api-reference/files/upload
   *
   * Deliberately not routed through `jsonRestFetch`: the body is the raw file
   * with `Content-Type: application/octet-stream` (**not** multipart), and the
   * shared helper's JSON defaults would fight that. It still prefers
   * `services.http` when the host provides one, so bastion egress routing and
   * a custom CA keep working — that transport accepts a `Uint8Array` body and
   * hands back the (small, JSON) response as a string.
   */
  private async uploadAudio(bytes: Uint8Array): Promise<string> {
    const url = `${this.baseUrl}/v2/upload`;
    const headers = { ...this.authHeaders, "Content-Type": "application/octet-stream" };

    let status: number;
    let body: string;
    if (this.services?.http) {
      const res = await this.services.http.request({
        url,
        method: "POST",
        headers,
        body: bytes,
        ...(this.caCert ? { caCert: this.caCert } : {}),
      });
      status = res.status;
      body = res.body;
    } else {
      const res = await fetch(url, { method: "POST", headers, body: bytes as BodyInit });
      status = res.status;
      body = await res.text();
    }

    if (status < 200 || status >= 300) {
      throw annotateError(new Error(`AssemblyAI API error ${status} for /v2/upload: ${body}`));
    }
    const parsed = JSON.parse(body) as UploadResponse;
    if (!parsed.upload_url) {
      throw new Error("AssemblyAI plugin: /v2/upload returned no upload_url");
    }
    return parsed.upload_url;
  }

  // -------------------------------------------------------------------------
  // Resource surface
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    // Exactly one account, always — including on a key that has never
    // transcribed anything. That is the point of it.
    if (typeId === ACCOUNT_TYPE) return [await this.buildAccount(accountId)];
    if (typeId !== TRANSCRIPT_TYPE) {
      throw new Error(`AssemblyAI plugin: unknown resource type "${typeId}"`);
    }
    const data = await this.fetch<TranscriptListResponse>(`/v2/transcript?limit=${LIST_LIMIT}`);
    const items = data.transcripts ?? [];

    // The list endpoint only returns id/status/created/completed/audio_url/error.
    // Model, duration, language and confidence live on the full record, so
    // hydrate each one — bounded, and tolerant of individual failures so one
    // purged transcript doesn't blank the whole listing.
    const hydrated = await mapWithConcurrency(items, HYDRATE_CONCURRENCY, async (item) => {
      try {
        return await this.fetch<Transcript>(`/v2/transcript/${encodeURIComponent(item.id)}`);
      } catch {
        return item as Transcript;
      }
    });

    return hydrated.map((t) => this.mapTranscript(t, accountId));
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === ACCOUNT_TYPE) return this.buildAccount(accountId);
    if (typeId !== TRANSCRIPT_TYPE) {
      throw new Error(`AssemblyAI plugin: unknown resource type "${typeId}"`);
    }
    const id = transcriptIdOf(resourceId);
    const data = await this.fetch<Transcript>(`/v2/transcript/${encodeURIComponent(id)}`);
    return this.mapTranscript(data, accountId);
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId !== TRANSCRIPT_TYPE && typeId !== ACCOUNT_TYPE) {
      throw new Error(`AssemblyAI plugin: unknown resource type "${typeId}"`);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value === undefined) {
      throw new Error(
        `AssemblyAI plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    }
    return value;
  }

  /**
   * Permanently removes the transcript text and, for clips that came in via
   * /v2/upload, the stored media alongside it.
   * https://www.assemblyai.com/docs/api-reference/transcripts/delete
   */
  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== TRANSCRIPT_TYPE) {
      throw new Error(`AssemblyAI plugin: deleteResource not supported for type "${typeId}"`);
    }
    const id = transcriptIdOf(resourceId);
    await this.fetch<Transcript>(`/v2/transcript/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const fields = resource.fields;

    if (resourceTypeId === ACCOUNT_TYPE) {
      const failed = Number(fields["erroredTranscripts"] ?? 0);
      return [
        { label: "Transcripts sampled", value: String(fields["sampledTranscripts"] ?? 0) },
        { label: "Completed", value: String(fields["completedTranscripts"] ?? 0) },
        {
          label: "Failed",
          value: String(failed),
          variant: failed > 0 ? "status-degraded" : "default",
        },
        { label: "Region", value: String(fields["region"] ?? "") },
      ];
    }

    const status = String(fields["status"] ?? "");
    return [
      {
        label: "Status",
        value: status,
        variant:
          status === "completed"
            ? "status-healthy"
            : status === "error"
              ? "status-error"
              : "status-degraded",
      },
      { label: "Model", value: String(fields["speechModel"] ?? "—") },
      { label: "Duration", value: formatDuration(Number(fields["audioDuration"] ?? 0)) },
      { label: "Language", value: String(fields["languageCode"] ?? "—") },
    ];
  }

  /**
   * `renderDetail` is synchronous, so the one number that needs an extra API
   * call is fetched here and stashed as a JSON blob under a
   * `__doubleUnderscore__` output key for the renderer to parse back out.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== TRANSCRIPT_TYPE) return resource;
    const data = await this.fetch<TranscriptListResponse>(`/v2/transcript?limit=${LIST_LIMIT}`);
    const items = data.transcripts ?? [];
    // The list endpoint doesn't carry audio_duration, so the only honest
    // cheap number here is how many jobs are in the retention window and how
    // they landed. Anything spend-shaped would need per-transcript fan-out.
    const counts = { completed: 0, error: 0, pending: 0 };
    for (const item of items) {
      if (item.status === "completed") counts.completed += 1;
      else if (item.status === "error") counts.error += 1;
      else counts.pending += 1;
    }
    return {
      ...resource,
      resolvedOutputs: {
        ...resource.resolvedOutputs,
        __recentActivity__: JSON.stringify({ sampled: items.length, ...counts }),
      },
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    if (resource.resourceTypeId === ACCOUNT_TYPE) return this.renderAccountDetail(resource);
    return this.renderTranscriptDetail(resource);
  }

  /**
   * The account view. Everything here is derived — AssemblyAI exposes no
   * account, usage, billing or quota endpoint — but it is always renderable,
   * which is what makes it a safe home for the Speech tab.
   */
  private renderAccountDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const sampled = Number(fields["sampledTranscripts"] ?? 0);
    const oldest = String(fields["oldestSampledAt"] ?? "");

    return {
      title: resource.displayName,
      subtitle: `AssemblyAI account · ${String(fields["region"] ?? "us")} region`,
      status: { kind: "status-dot", status: "healthy", label: "Connected" },
      sections: [
        {
          kind: "section",
          title: "Endpoint",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "API Base", value: String(fields["endpoint"] ?? ""), copyable: true },
                { key: "Region", value: String(fields["region"] ?? "") },
                // Documented gotcha, not decoration: `Bearer` fails auth here.
                { key: "Auth Header", value: "authorization: <key> (no Bearer prefix)" },
              ],
            },
            {
              kind: "text",
              content:
                "Transcripts live on the host they were created against — an account pointed at EU cannot see transcripts submitted through the default host, and vice versa.",
              variant: "muted",
            },
          ],
        },
        {
          kind: "section",
          // Named for what it actually is. AssemblyAI has no usage, billing or
          // quota endpoint, so this counts jobs in the 90-day retention window —
          // it is not a spend figure and does not include anything already purged.
          title: "Recent activity (90-day retention window)",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Transcripts sampled", value: String(sampled) },
                { key: "Completed", value: String(fields["completedTranscripts"] ?? 0) },
                { key: "Failed", value: String(fields["erroredTranscripts"] ?? 0) },
                { key: "Queued / processing", value: String(fields["pendingTranscripts"] ?? 0) },
                { key: "Oldest sampled", value: oldest || "—" },
              ],
            },
            {
              kind: "text",
              content:
                "AssemblyAI exposes no usage, billing, or quota API — spend is dashboard-only. This is a count of jobs still inside the 90-day retention window, not billed usage.",
              variant: "muted",
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      speechPanel: this.speechPanel(),
    };
  }

  private renderTranscriptDetail(resource: ResourceInstance): DetailViewSchema {
    const fields = resource.fields;
    const status = String(fields["status"] ?? "unknown");
    const duration = Number(fields["audioDuration"] ?? 0);
    const confidence = Number(fields["confidence"] ?? 0);
    const model = String(fields["speechModel"] ?? "");

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Transcript",
        children: [
          {
            kind: "key-value-list",
            items: [
              {
                key: "Transcript ID",
                value: resource.externalId ?? transcriptIdOf(resource.id),
                copyable: true,
              },
              { key: "Status", value: status },
              { key: "Speech Model", value: model || "—" },
              { key: "Language", value: String(fields["languageCode"] ?? "—") },
              { key: "Audio Duration", value: formatDuration(duration) },
              {
                key: "Confidence",
                value: confidence > 0 ? `${(confidence * 100).toFixed(1)}%` : "—",
              },
              { key: "Words", value: String(fields["wordCount"] ?? 0) },
              { key: "Speaker Labels", value: fields["speakerLabels"] ? "Enabled" : "Disabled" },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Source",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Audio URL", value: String(fields["audioUrl"] ?? "—"), copyable: true },
              { key: "Created", value: String(fields["created"] ?? "—") },
              { key: "Completed", value: String(fields["completed"] ?? "—") },
              ...(fields["errorMessage"]
                ? [{ key: "Error", value: String(fields["errorMessage"]) }]
                : []),
            ],
          },
        ],
      },
    ];

    const preview = String(fields["textPreview"] ?? "");
    if (preview) {
      sections.push({
        kind: "section",
        title: "Text",
        children: [{ kind: "text", content: preview, copyable: true }],
      });
    }

    const activity = parseRecentActivity(resource.resolvedOutputs["__recentActivity__"]);
    if (activity) {
      sections.push({
        kind: "section",
        // Named for what it actually is. AssemblyAI has no usage, billing or
        // quota endpoint, so this counts jobs in the 90-day retention window —
        // it is not a spend figure and does not include anything already purged.
        title: "Recent activity (90-day retention window)",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Transcripts sampled", value: String(activity.sampled) },
              { key: "Completed", value: String(activity.completed) },
              { key: "Failed", value: String(activity.error) },
              { key: "Queued / processing", value: String(activity.pending) },
            ],
          },
          {
            kind: "text",
            content:
              "AssemblyAI exposes no usage, billing, or quota API — spend is dashboard-only. This is a count of jobs still inside the 90-day retention window, not billed usage.",
            variant: "muted",
          },
        ],
      });
    }

    return {
      title: resource.displayName,
      subtitle: model ? `AssemblyAI transcript · ${model}` : "AssemblyAI transcript",
      status: {
        kind: "status-dot",
        status: statusDot(status),
        label: status,
      },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      // Also offered here, where it doubles as "re-run this one with different
      // settings". The account copy above is the one that is always reachable.
      speechPanel: this.speechPanel(),
    };
  }

  /** One panel definition, shared by the account and transcript detail views. */
  private speechPanel(): SpeechPanelCapability {
    return {
      modes: ["stt"],
      tabLabel: "Speech",
      subtitle:
        "Record or upload a clip and AssemblyAI transcribes it — upload, submit, and poll all happen in this one request.",
      helpText:
        "The v2 API is async-only, so this runs three calls back to back: POST /v2/upload with the raw bytes, POST /v2/transcript with the returned URL, then GET /v2/transcript/{id} every 3 seconds until it completes. It gives up after 120 seconds — long recordings are better submitted from the dashboard. Punctuation, text formatting, and speaker diarization are all on. The API itself accepts files up to 2.2 GB; this panel caps lower because the clip travels base64-encoded inside a JSON request.",
      models: SPEECH_MODELS,
      defaultModel: DEFAULT_MODEL,
      modelLabel: "Speech model",
      languages: LANGUAGES,
      defaultLanguage: AUTO_LANGUAGE,
      languageLabel: "Language",
      acceptedAudioTypes: ["audio/*", "video/*"],
      maxAudioBytes: MAX_AUDIO_BYTES,
      transcribeLabel: "Transcribe",
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === ACCOUNT_TYPE) {
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: "info", label: "Account" },
      };
    }
    const status = String(resource.fields["status"] ?? "unknown");
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: statusDot(status), label: status },
    };
  }

  // -------------------------------------------------------------------------
  // Speech tab
  // -------------------------------------------------------------------------

  /**
   * Upload → submit → poll, all inside one call.
   *
   * - https://www.assemblyai.com/docs/api-reference/files/upload
   * - https://www.assemblyai.com/docs/api-reference/transcripts/submit
   * - https://www.assemblyai.com/docs/api-reference/transcripts/get
   *
   * `payload.mimeType` is whatever `MediaRecorder` produced (webm/opus on
   * Chromium, mp4 on Safari) — AssemblyAI sniffs the container itself, so the
   * bytes go up untouched and the type is only used for the summary line.
   */
  async transcribeAudio(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    // Both hosts of the Speech tab, and nothing else — the guard stays explicit
    // about which types are valid rather than accepting anything.
    if (typeId !== ACCOUNT_TYPE && typeId !== TRANSCRIPT_TYPE) {
      throw new Error(`AssemblyAI plugin: transcribeAudio not supported for type "${typeId}"`);
    }

    const startedAt = Date.now();
    // Plugins run in Node (server / Electron main), so Buffer — not atob.
    const bytes = Buffer.from(payload.audioBase64, "base64");
    if (bytes.length === 0) throw new Error("AssemblyAI plugin: empty audio payload");
    if (bytes.length > MAX_AUDIO_BYTES) {
      throw new Error(
        `AssemblyAI plugin: clip is ${formatBytes(bytes.length)}, above this panel's ${formatBytes(MAX_AUDIO_BYTES)} limit.`,
      );
    }

    const audioUrl = await this.uploadAudio(bytes);

    const model = payload.modelId ?? DEFAULT_MODEL;
    const body: Record<string, unknown> = {
      audio_url: audioUrl,
      // `speech_models` is an array of models in priority order, replacing the
      // deprecated singular `speech_model`. Asking for Universal-3.5 Pro also
      // lists Universal-2 behind it — matching AssemblyAI's own default — so a
      // language outside 3.5 Pro's 18 still transcribes instead of erroring.
      speech_models: model === DEFAULT_MODEL ? [DEFAULT_MODEL, "universal-2"] : [model],
      punctuate: true,
      format_text: true,
      // Diarization requires punctuate: true, which is set above.
      speaker_labels: true,
    };
    const language = payload.language ?? AUTO_LANGUAGE;
    if (language === AUTO_LANGUAGE) {
      body["language_detection"] = true;
    } else {
      // ISO-639-1 with an underscored region (`en_us`), not `en-US`.
      body["language_code"] = language;
    }

    const submitted = await this.fetch<Transcript>("/v2/transcript", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!submitted.id) throw new Error("AssemblyAI plugin: /v2/transcript returned no job id");

    const finished = await this.pollTranscript(submitted.id);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;

    const words: TranscriptWord[] = (finished.words ?? []).map((w) => ({
      text: w.text ?? "",
      // The API reports word boundaries in milliseconds; the panel wants seconds.
      ...(typeof w.start === "number" ? { start: w.start / 1000 } : {}),
      ...(typeof w.end === "number" ? { end: w.end / 1000 } : {}),
      ...(w.speaker ? { speaker: w.speaker } : {}),
    }));

    const duration = finished.audio_duration ?? undefined;
    const summaryParts = [
      `Model ${modelOf(finished) || model}`,
      duration != null ? `${formatDuration(duration)} of audio` : null,
      `${words.length} words`,
      finished.confidence != null ? `${(finished.confidence * 100).toFixed(1)}% confidence` : null,
      `${elapsedSeconds.toFixed(1)}s round trip`,
    ].filter((part): part is string => part !== null);

    return {
      text: finished.text ?? "",
      summary: summaryParts.join(" · "),
      ...(finished.language_code ? { language: finished.language_code } : {}),
      ...(duration != null ? { durationSeconds: duration } : {}),
      ...(finished.confidence != null ? { confidence: finished.confidence } : {}),
      ...(words.length > 0 ? { words } : {}),
      requestId: finished.id,
    };
  }

  /**
   * Poll a submitted job to a terminal state. Status is one of
   * `queued | processing | completed | error`; a failed job comes back as a
   * perfectly ordinary 200 with `status: "error"`, so the body is what decides,
   * not the HTTP code.
   */
  private async pollTranscript(id: string): Promise<Transcript> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const current = await this.fetch<Transcript>(`/v2/transcript/${encodeURIComponent(id)}`);
      if (current.status === "completed") return current;
      if (current.status === "error") {
        throw new Error(
          `AssemblyAI transcription failed: ${current.error ?? "no error message returned"} (transcript ${id})`,
        );
      }
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        throw new Error(
          `AssemblyAI transcription did not finish within ${POLL_TIMEOUT_MS / 1000}s — transcript ${id} is still "${current.status ?? "queued"}". The job is still running on AssemblyAI's side; it will appear in this account's transcript list once it completes.`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  /**
   * The singleton account resource.
   *
   * There is no endpoint that describes an AssemblyAI key, so the only honest
   * content is the same retention-window count `enrichDetail` computes. A
   * listing failure is swallowed on purpose: the account has to stay navigable
   * — and the Speech tab usable — on a key that has never transcribed anything.
   */
  private async buildAccount(accountId: string): Promise<ResourceInstance> {
    let items: TranscriptListItem[] = [];
    try {
      const data = await this.fetch<TranscriptListResponse>(`/v2/transcript?limit=${LIST_LIMIT}`);
      items = data.transcripts ?? [];
    } catch {
      items = [];
    }

    let completed = 0;
    let error = 0;
    let pending = 0;
    let oldest = "";
    for (const item of items) {
      if (item.status === "completed") completed += 1;
      else if (item.status === "error") error += 1;
      else pending += 1;
      const created = item.created ?? "";
      if (created && (!oldest || created < oldest)) oldest = created;
    }

    const now = new Date().toISOString();
    return {
      id: `${accountId}:${ACCOUNT_TYPE}:${ACCOUNT_ID}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: ACCOUNT_TYPE,
      accountId,
      displayName: "AssemblyAI",
      fields: {
        endpoint: this.baseUrl,
        region: this.region,
        sampledTranscripts: items.length,
        completedTranscripts: completed,
        erroredTranscripts: error,
        pendingTranscripts: pending,
        oldestSampledAt: oldest,
      },
      resolvedOutputs: { endpoint: this.baseUrl, region: this.region },
      secretStates: [],
      externalId: ACCOUNT_ID,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapTranscript(t: Transcript, accountId: string): ResourceInstance {
    const status = t.status ?? "queued";
    const text = t.text ?? "";
    const created = t.created ?? new Date().toISOString();
    const displayName = buildDisplayName(t, text);

    return {
      id: `${accountId}:${TRANSCRIPT_TYPE}:${t.id}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: TRANSCRIPT_TYPE,
      accountId,
      displayName,
      fields: {
        status,
        speechModel: modelOf(t),
        audioDuration: t.audio_duration ?? 0,
        languageCode: t.language_code ?? "",
        confidence: t.confidence ?? 0,
        wordCount: t.words?.length ?? 0,
        speakerLabels: t.speaker_labels ?? false,
        audioUrl: t.audio_url ?? "",
        textPreview: text.length > 500 ? `${text.slice(0, 500)}…` : text,
        errorMessage: t.error ?? "",
        created,
        completed: t.completed ?? "",
      },
      resolvedOutputs: {
        transcriptId: t.id,
        resourceUrl: t.resource_url ?? `${this.baseUrl}/v2/transcript/${t.id}`,
        audioUrl: t.audio_url ?? "",
        languageCode: t.language_code ?? "",
        text,
      },
      secretStates: [],
      externalId: t.id,
      createdAt: created,
      updatedAt: t.completed ?? created,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * AssemblyAI answers **rate-limit violations with 403, not 429**, and also
 * returns 403 when a key from a different project than the uploader's is used.
 * A bare 403 is therefore ambiguous — say so rather than letting the user
 * conclude their key is wrong. Nothing in this plugin retries off 429.
 */
function annotateError(err: unknown): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  if (!/\b403\b/.test(error.message)) return error;
  return new Error(
    `${error.message} — AssemblyAI uses 403 for rate-limit violations (not 429), and also when the API key belongs to a different project than the one that uploaded the audio. Check both before assuming the key is invalid.`,
  );
}

function transcriptIdOf(resourceId: string): string {
  // `{accountId}:transcript:{id}` — ids are UUIDs, so the tail is unambiguous.
  const parts = resourceId.split(":");
  const id = parts.length > 2 ? parts.slice(2).join(":") : resourceId;
  if (!id) throw new Error(`AssemblyAI plugin: cannot parse transcript id from "${resourceId}"`);
  return id;
}

function modelOf(t: Transcript): string {
  // Submissions use the `speech_models` array; older records and some
  // responses still carry the deprecated singular `speech_model`.
  const first = t.speech_models?.[0];
  return first ?? t.speech_model ?? "";
}

function buildDisplayName(t: Transcript, text: string): string {
  const snippet = text.trim().split(/\s+/).slice(0, 8).join(" ");
  if (snippet) return snippet.length > 60 ? `${snippet.slice(0, 60)}…` : snippet;
  const created = t.created ? t.created.slice(0, 19).replace("T", " ") : "";
  return created ? `Transcript ${created}` : `Transcript ${t.id.slice(0, 8)}`;
}

function statusDot(status: string): "healthy" | "error" | "provisioning" | "unknown" {
  switch (status) {
    case "completed":
      return "healthy";
    case "error":
      return "error";
    case "queued":
    case "processing":
      return "provisioning";
    default:
      return "unknown";
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface RecentActivity {
  sampled: number;
  completed: number;
  error: number;
  pending: number;
}

function parseRecentActivity(raw: string | undefined): RecentActivity | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RecentActivity>;
    return {
      sampled: parsed.sampled ?? 0,
      completed: parsed.completed ?? 0,
      error: parsed.error ?? 0,
      pending: parsed.pending ?? 0,
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
