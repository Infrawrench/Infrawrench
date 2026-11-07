import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  KVItem,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  SpeechPanelCapability,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TableRow,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
  CreditBalance,
} from "@infrawrench/plugin-base";
import {
  CostSetupError,
  CreditAccessError,
  bytesToBase64,
  hostFetch,
  joinSubtitle,
  pathEncode,
  withAiCostTags,
} from "@infrawrench/plugin-base";
import {
  BASE_URL,
  createOpenRouterApi,
  type OpenRouterApi,
  type OrActivityItem,
  type OrAnalyticsAnswer,
  type OrAnalyticsFilter,
  type OrByokCredential,
  type OrCredits,
  type OrEndpoint,
  type OrGuardrail,
  type OrKey,
  type OrKeyCreate,
  type OrKeyUpdate,
  type OrModel,
  type OrModelFields,
  type OrProvider,
  type OrSpeechRequest,
  type OrTranscription,
  type OrTranscriptionRequest,
  type OrWorkspace,
} from "./api.js";
import {
  byokBody,
  byokCreateConfig,
  guardrailBody,
  guardrailCreateConfig,
  mapByok,
  mapGuardrail,
  mapWorkspace,
  parseList,
  renderByokDetail,
  renderGuardrailDetail,
  renderWorkspaceDetail,
  workspaceBody,
  workspaceBudgetChanges,
  workspaceCreateConfig,
  type PickerSources,
} from "./management.js";

/** Resource types only a management key can list. */
const MANAGEMENT_ONLY_TYPES = new Set(["api-key", "guardrail", "workspace", "byok-credential"]);

/** GET /models caps `limit` at 1000. Pagination is offset+limit, not a cursor. */
const MODELS_PAGE_SIZE = 1000;

/**
 * Listing every provider endpoint for every model would be one request per
 * model across a ~500-model catalogue. The top-level Model Endpoints list is
 * therefore capped to the most popular models; a model's own detail page always
 * shows all of its endpoints.
 */
const ENDPOINT_FANOUT_MODELS = 25;
const ENDPOINT_FANOUT_CONCURRENCY = 5;

/** GET /activity only covers the last 30 completed UTC days. */
const ACTIVITY_WINDOW_DAYS = 30;

const HOUR_MS = 60 * 60 * 1000;

/** Latency and throughput metrics refuse a time range wider than 31 days. */
const ANALYTICS_LATENCY_MAX_DAYS = 31;

interface AnalyticsMetric {
  name: string;
  label: string;
  unit: string;
  /** Multiplier applied to each value: rates come back as 0 to 1 ratios. */
  scale?: number;
}

/**
 * Metric names and units from OpenRouter's analytics guides: spend metrics
 * are USD, token metrics native tokens, `cache_hit_rate` a 0 to 1 ratio.
 * https://openrouter.ai/docs/cookbook/administration/analytics-cost-control
 * https://github.com/OpenRouterTeam/skills/tree/main/skills/openrouter-analytics
 */
const ANALYTICS_USAGE_METRICS: AnalyticsMetric[] = [
  { name: "request_count", label: "Requests", unit: "requests" },
  { name: "total_usage", label: "Spend", unit: "USD" },
  { name: "byok_usage", label: "BYOK spend", unit: "USD" },
  { name: "tokens_prompt", label: "Prompt tokens", unit: "tokens" },
  { name: "tokens_completion", label: "Completion tokens", unit: "tokens" },
  { name: "reasoning_tokens", label: "Reasoning tokens", unit: "tokens" },
  { name: "cache_hit_rate", label: "Cache hit rate", unit: "%", scale: 100 },
];

/**
 * `*_latency` is the provider's time to first token and `*_throughput`
 * completion tokens per second; both in the same guides as above.
 */
const ANALYTICS_PERFORMANCE_METRICS: AnalyticsMetric[] = [
  { name: "p50_latency", label: "Time to first token p50", unit: "ms" },
  { name: "p90_latency", label: "Time to first token p90", unit: "ms" },
  { name: "p50_throughput", label: "Throughput p50", unit: "tokens/s" },
];

/**
 * One series per metric. Each row carries its bucket under `date__<g>` or
 * `created_at__<g>` depending on the data source the query resolved to;
 * unused metrics are `null` rather than 0 and are skipped.
 */
function analyticsSeries(
  response: OrAnalyticsAnswer,
  metrics: AnalyticsMetric[],
  granularity: string,
): MetricSeries[] {
  const rows = response.data?.data ?? [];
  const series: MetricSeries[] = [];
  for (const metric of metrics) {
    const points: Array<{ timestamp: number; value: number }> = [];
    for (const row of rows) {
      const bucket = row[`date__${granularity}`] ?? row[`created_at__${granularity}`];
      const timestamp = typeof bucket === "string" ? Date.parse(bucket) : NaN;
      const raw = row[metric.name];
      if (!Number.isFinite(timestamp) || raw === null || raw === undefined || raw === "") continue;
      const value = Number(raw) * (metric.scale ?? 1);
      if (Number.isFinite(value)) points.push({ timestamp, value });
    }
    if (points.length === 0) continue;
    points.sort((a, b) => a.timestamp - b.timestamp);
    series.push({ label: metric.label, unit: metric.unit, points });
  }
  return series;
}

const STT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Fallbacks for the Speech tab when the live model lists can't be reached.
 * Both ids were verified against GET /models?output_modalities=speech and
 * ?output_modalities=transcription.
 */
const FALLBACK_TTS_MODEL = "mistralai/voxtral-mini-tts-2603";
const FALLBACK_TTS_VOICE = "en_paul_neutral";
const FALLBACK_STT_MODEL = "openai/whisper-large-v3";

const DASH = "—";

/** Guardrail, workspace and BYOK listings cap `limit` at 100. */
const MANAGEMENT_PAGE_SIZE = 100;

/**
 * OpenRouter plugin client.
 *
 * Two credentials, because OpenRouter genuinely needs two:
 *   - the **management key** (formerly "provisioning key") is the only thing
 *     `/credits`, `/activity` and `/keys*` accept: a plain key 403s;
 *   - a normal **inference key** is the only thing `/audio/speech` and
 *     `/audio/transcriptions` accept; management keys are rejected by the
 *     completion endpoints.
 *
 * The inference key is optional; without it every list still works and the
 * Speech tab renders with a `disabledReason` instead of failing.
 *
 * Spec: https://openrouter.ai/openapi.json
 */
export class OpenRouterClient implements PluginClient {
  private readonly managementKey: string;
  private readonly inferenceKey: string | undefined;
  /**
   * False for an account holding only an inference key (Connect with
   * OpenRouter mints one of those): the console objects below answer 403 to
   * it, so their lists are empty instead of failing every sync.
   */
  private readonly hasManagementKey: boolean;
  private readonly caCert: string | undefined;
  private readonly services: HostServices | undefined;
  /** Everything the management key reads; `/audio/*` takes the inference key instead. */
  private readonly api: OpenRouterApi;
  private speechModelsPromise: Promise<{ tts: OrModel[]; stt: OrModel[] }> | undefined;
  private canonicalSlugs: Promise<Map<string, string>> | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const managementKey = credentials["managementKey"] || credentials["apiKey"];
    if (!managementKey)
      throw new Error("OpenRouter plugin: enter a management key or an inference API key");
    this.managementKey = managementKey;
    this.hasManagementKey = Boolean(credentials["managementKey"]);
    this.inferenceKey = credentials["apiKey"] || undefined;
    this.caCert = credentials["caCert"] || undefined;
    this.services = services;
    this.api = this.apiWith(managementKey);
  }

  // ------------------------------------------------------------------ HTTP

  private apiWith(key: string): OpenRouterApi {
    return createOpenRouterApi({ key, caCert: this.caCert, http: this.services?.http });
  }

  /** Inference endpoints reject management keys outright. */
  private requireInferenceKey(): string {
    if (!this.inferenceKey) {
      throw new Error(
        "OpenRouter plugin: this needs an inference API key. Management keys are rejected by completion endpoints. Add one under the account's credentials (openrouter.ai/settings/keys).",
      );
    }
    return this.inferenceKey;
  }

  // ------------------------------------------------------------------ list

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      if (!this.hasManagementKey && MANAGEMENT_ONLY_TYPES.has(typeId)) return [];
      switch (typeId) {
        case "model":
          return this.listModels(accountId);
        case "model-endpoint":
          return this.listModelEndpoints(accountId);
        case "provider":
          return this.listProviders(accountId);
        case "api-key":
          return this.listApiKeys(accountId);
        case "guardrail":
          return (await this.listPaged((query) => this.api.get("/guardrails", { query }))).map(
            (g) => mapGuardrail(accountId, g),
          );
        case "workspace":
          return (await this.listPaged((query) => this.api.get("/workspaces", { query }))).map(
            (w) => mapWorkspace(accountId, w),
          );
        case "byok-credential":
          return (await this.listPaged((query) => this.api.get("/byok", { query }))).map((b) =>
            mapByok(accountId, b),
          );
        default:
          throw new Error(`OpenRouter plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  /**
   * GET /models. `output_modalities=all` is needed to see image, speech,
   * transcription and embedding models: the endpoint defaults to text only.
   */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const models = await this.fetchAllModels();
    const now = new Date().toISOString();
    return models.map((m) => this.mapModel(accountId, now, m));
  }

  private async fetchAllModels(): Promise<OrModel[]> {
    const out: OrModel[] = [];
    // offset+limit, not a cursor.
    for (let offset = 0; offset < 20 * MODELS_PAGE_SIZE; offset += MODELS_PAGE_SIZE) {
      const data = await this.api.get("/models", {
        query: { limit: MODELS_PAGE_SIZE, offset, output_modalities: "all" },
      });
      const page = data.data ?? [];
      out.push(...page);
      if (page.length < MODELS_PAGE_SIZE) break;
    }
    return out;
  }

  private mapModel(accountId: string, now: string, m: OrModelFields): ResourceInstance {
    const arch: Partial<OrModel["architecture"]> = m.architecture ?? {};
    const pricing: Partial<OrModel["pricing"]> = m.pricing ?? {};
    const voices = m.supported_voices ?? [];
    return {
      id: `${accountId}:model:${m.id}`,
      pluginId: "openrouter",
      resourceTypeId: "model",
      accountId,
      displayName: m.name || m.id,
      externalId: m.id,
      fields: {
        modelId: m.id,
        name: m.name ?? "",
        canonicalSlug: m.canonical_slug ?? "",
        author: m.id.includes("/") ? (m.id.split("/")[0] ?? "") : "",
        contextLength: m.context_length ?? 0,
        modality: arch.modality ?? "",
        inputModalities: (arch.input_modalities ?? []).join(", "),
        outputModalities: (arch.output_modalities ?? []).join(", "),
        tokenizer: arch.tokenizer ?? "",
        created: m.created ? new Date(m.created * 1000).toISOString() : "",
        knowledgeCutoff: m.knowledge_cutoff ?? "",
        expirationDate: m.expiration_date ?? "",
        huggingFaceId: m.hugging_face_id ?? "",
        description: (m.description ?? "").slice(0, 500),
        promptPricePerMillion: perMillion(pricing.prompt),
        completionPricePerMillion: perMillion(pricing.completion),
        imagePrice: numeric(pricing.image),
        requestPrice: numeric(pricing.request),
        webSearchPrice: numeric(pricing.web_search),
        supportedParameters: (m.supported_parameters ?? []).join(", "),
        supportedVoices: voices.join(", "),
        topProviderContextLength: m.top_provider?.context_length ?? 0,
        topProviderMaxCompletionTokens: m.top_provider?.max_completion_tokens ?? 0,
        isModerated: m.top_provider?.is_moderated === true,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * GET /models/{author}/{slug}/endpoints, fanned out over the most popular
   * models only: see {@link ENDPOINT_FANOUT_MODELS}.
   */
  private async listModelEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const listing = await this.api.get("/models", {
      query: { limit: ENDPOINT_FANOUT_MODELS, sort: "most-popular", output_modalities: "all" },
    });
    const ids = (listing.data ?? []).map((m) => m.id);
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];

    for (let i = 0; i < ids.length; i += ENDPOINT_FANOUT_CONCURRENCY) {
      const slice = ids.slice(i, i + ENDPOINT_FANOUT_CONCURRENCY);
      const results = await Promise.all(
        slice.map(async (id) => ({ id, endpoints: await this.fetchModelEndpoints(id) })),
      );
      for (const { id, endpoints } of results) {
        for (const ep of endpoints) out.push(this.mapEndpoint(accountId, now, id, ep));
      }
    }
    return out;
  }

  private async fetchModelEndpoints(modelId: string): Promise<OrEndpoint[]> {
    const [author, ...rest] = modelId.split("/");
    const slug = rest.join("/");
    if (!author || !slug) return [];
    try {
      const data = await this.api.get(
        `/models/${pathEncode(author)}/${pathEncode(slug)}/endpoints`,
      );
      return data.data?.endpoints ?? [];
    } catch {
      return [];
    }
  }

  private mapEndpoint(
    accountId: string,
    now: string,
    modelId: string,
    ep: OrEndpoint,
  ): ResourceInstance {
    const externalId = `${modelId}|${ep.name}`;
    const latency = ep.latency_last_30m ?? {};
    const throughput = ep.throughput_last_30m ?? {};
    const pricing = ep.pricing ?? {};
    return {
      id: `${accountId}:model-endpoint:${externalId}`,
      pluginId: "openrouter",
      resourceTypeId: "model-endpoint",
      accountId,
      displayName: ep.name,
      externalId,
      parentResourceId: `${accountId}:model:${modelId}`,
      fields: {
        endpointName: ep.name,
        modelId: ep.model_id ?? modelId,
        providerName: ep.provider_name ?? "",
        tag: ep.tag ?? "",
        contextLength: ep.context_length ?? 0,
        maxPromptTokens: ep.max_prompt_tokens ?? 0,
        maxCompletionTokens: ep.max_completion_tokens ?? 0,
        quantization: ep.quantization ?? "",
        status: endpointStatusLabel(ep.status),
        promptPricePerMillion: perMillion(pricing.prompt),
        completionPricePerMillion: perMillion(pricing.completion),
        uptimeLast5m: ep.uptime_last_5m ?? 0,
        uptimeLast30m: ep.uptime_last_30m ?? 0,
        uptimeLast1d: ep.uptime_last_1d ?? 0,
        latencyP50: percentile(latency, "p50"),
        latencyP75: percentile(latency, "p75"),
        latencyP90: percentile(latency, "p90"),
        latencyP99: percentile(latency, "p99"),
        throughputP50: percentile(throughput, "p50"),
        throughputP90: percentile(throughput, "p90"),
        supportsImplicitCaching: ep.supports_implicit_caching === true,
        supportedParameters: (ep.supported_parameters ?? []).join(", "),
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Offset + limit listing used by the management collections, which report
   * `total_count` alongside each page. A hand loop rather than `getAll`, which has
   * no way to stop at `total_count`.
   */
  private async listPaged<T>(
    readPage: (query: {
      offset: number;
      limit: number;
    }) => Promise<{ data?: T[]; total_count?: number }>,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; offset < 50 * MANAGEMENT_PAGE_SIZE; offset += MANAGEMENT_PAGE_SIZE) {
      const data = await readPage({ offset, limit: MANAGEMENT_PAGE_SIZE });
      const page = data.data ?? [];
      out.push(...page);
      if (page.length < MANAGEMENT_PAGE_SIZE) break;
      if (data.total_count !== undefined && out.length >= data.total_count) break;
    }
    return out;
  }

  /** GET /providers */
  private async listProviders(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.api.get("/providers");
    const now = new Date().toISOString();
    return (data.data ?? []).map((p) => ({
      id: `${accountId}:provider:${p.slug}`,
      pluginId: "openrouter",
      resourceTypeId: "provider",
      accountId,
      displayName: p.name || p.slug,
      externalId: p.slug,
      fields: {
        slug: p.slug,
        name: p.name ?? "",
        headquarters: p.headquarters ?? "",
        datacenters: (p.datacenters ?? []).join(", "),
        privacyPolicyUrl: p.privacy_policy_url ?? "",
        termsOfServiceUrl: p.terms_of_service_url ?? "",
        statusPageUrl: p.status_page_url ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    }));
  }

  /** GET /keys: offset-paginated, management key required. */
  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    const pageSize = 100;

    for (let offset = 0; offset < 50 * pageSize; offset += pageSize) {
      const data = await this.api.get("/keys", { query: { offset, include_disabled: true } });
      const page = data.data ?? [];
      for (const k of page) out.push(this.mapKey(accountId, now, k));
      if (page.length === 0) break;
      // The API doesn't report a total, so stop as soon as a page repeats the
      // last hash we already have.
      if (page.length < pageSize) break;
    }
    return out;
  }

  private mapKey(accountId: string, now: string, k: OrKey): ResourceInstance {
    return {
      id: `${accountId}:api-key:${k.hash}`,
      pluginId: "openrouter",
      resourceTypeId: "api-key",
      accountId,
      displayName: k.name || k.label || k.hash.slice(0, 12),
      externalId: k.hash,
      fields: {
        hash: k.hash,
        name: k.name ?? "",
        label: k.label ?? "",
        disabled: k.disabled === true,
        limit: k.limit ?? 0,
        limitRemaining: k.limit_remaining ?? 0,
        limitReset: k.limit_reset ?? "",
        usage: k.usage ?? 0,
        usageDaily: k.usage_daily ?? 0,
        usageWeekly: k.usage_weekly ?? 0,
        usageMonthly: k.usage_monthly ?? 0,
        byokUsage: k.byok_usage ?? 0,
        includeByokInLimit: k.include_byok_in_limit === true,
        expiresAt: k.expires_at ?? "",
        createdAt: k.created_at ?? "",
        updatedAt: k.updated_at ?? "",
        workspaceId: k.workspace_id ?? "",
        creatorUserId: k.creator_user_id ?? "",
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  // ------------------------------------------------------------------- get

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = resourceId.split(":").slice(2).join(":");
      const now = new Date().toISOString();

      if (typeId === "api-key") {
        const data = await this.api.get(`/keys/${pathEncode(externalId)}`);
        return this.mapKey(accountId, now, data.data);
      }

      if (typeId === "guardrail") {
        const id = pathEncode(externalId);
        const [data, assignments] = await Promise.all([
          this.api.get(`/guardrails/${id}`),
          this.listPaged((query) =>
            this.api.get(`/guardrails/${id}/assignments/keys`, { query }),
          ).catch(() => undefined),
        ]);
        return mapGuardrail(accountId, data.data, assignments);
      }

      if (typeId === "workspace") {
        const id = pathEncode(externalId);
        const [data, budgets, members] = await Promise.all([
          this.api.get(`/workspaces/${id}`),
          this.api.get(`/workspaces/${id}/budgets`).catch(() => undefined),
          this.api.get(`/workspaces/${id}/members`, { query: { limit: 1 } }).catch(() => undefined),
        ]);
        return mapWorkspace(
          accountId,
          data.data,
          budgets,
          members ? (members.total_count ?? members.data?.length) : undefined,
        );
      }

      if (typeId === "byok-credential") {
        const data = await this.api.get(`/byok/${pathEncode(externalId)}`);
        return mapByok(accountId, data.data);
      }

      if (typeId === "model-endpoint") {
        const [modelId, endpointName] = splitEndpointExternalId(externalId);
        const endpoints = await this.fetchModelEndpoints(modelId);
        const found = endpoints.find((e) => e.name === endpointName);
        if (!found) throw new Error(`OpenRouter plugin: endpoint ${externalId} not found`);
        return this.mapEndpoint(accountId, now, modelId, found);
      }

      if (typeId === "model") {
        const [author, ...rest] = externalId.split("/");
        const slug = rest.join("/");
        if (author && slug) {
          const data = await this.api.get(
            `/models/${pathEncode(author)}/${pathEncode(slug)}/endpoints`,
          );
          if (data.data) {
            const resource = this.mapModel(accountId, now, data.data);
            // `renderDetail` is synchronous, so anything it needs from an extra
            // call is stashed here. Same pattern as Cloudflare Queues'
            // `__consumers__`.
            const stash: Record<string, string> = {
              __endpoints__: JSON.stringify(data.data.endpoints ?? []),
            };
            if (isAudioModel(data.data)) {
              try {
                const speech = await this.speechCatalogue();
                stash["__speech__"] = JSON.stringify(speech);
              } catch {
                // fall back to the verified defaults in the panel
              }
            }
            resource.resolvedOutputs = stash;
            return resource;
          }
        }
      }

      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId);
      if (!found) throw new Error(`OpenRouter plugin: resource ${typeId}/${resourceId} not found`);
      return found;
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const stored = resource.resolvedOutputs[outputKey];
      if (stored !== undefined) return stored;
      const direct = resource.fields[outputKey];
      if (direct !== undefined) return String(direct);
      throw new Error(
        `OpenRouter plugin: cannot resolve output "${outputKey}" for type "${typeId}"`,
      );
    });
  }

  // --------------------------------------------------------------- credits

  /**
   * `GET /credits` → `{ total_credits, total_usage }`, both lifetime totals in
   * USD; what remains is the difference.
   *
   * Needs a provisioning key: an inference key 403s here, which the manifest
   * declares so the host can call it a permission gap rather than a failure.
   * `total_credits` is everything ever added, so it *is* an honest `granted`:
   * "spent 38 of 50" is exactly what those two numbers mean.
   */
  fetchCreditBalance(): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      let body: OrCredits;
      try {
        body = await this.api.get("/credits");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/40[13]/.test(message)) {
          throw new CreditAccessError(
            "OpenRouter only exposes the account credit balance to a provisioning key. Add one to this account to track credits.",
            {
              label: "Create a provisioning key",
              url: "https://openrouter.ai/settings/provisioning-keys",
            },
          );
        }
        throw err;
      }
      const granted = body.data?.total_credits ?? 0;
      const used = body.data?.total_usage ?? 0;
      return [
        {
          key: "default",
          label: "Account credits",
          remaining: granted - used,
          currency: "USD",
          granted,
        },
      ];
    });
  }

  // ------------------------------------------------------------- dashboard

  /** GET /credits → `{ total_credits, total_usage }` (management key only). */
  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      if (resourceTypeId === "api-key") {
        const resource = await runPluginEffect(
          this.getResource(resourceTypeId, resourceId, accountId),
        );
        const f = resource.fields;
        const stats: DashboardStat[] = [
          { label: "Usage", value: `$${Number(f["usage"] ?? 0).toFixed(4)}` },
          {
            label: "Limit",
            value: Number(f["limit"] ?? 0) > 0 ? `$${Number(f["limit"]).toFixed(2)}` : "unlimited",
          },
          {
            label: "Status",
            value: f["disabled"] === true ? "disabled" : "active",
            variant: f["disabled"] === true ? "status-degraded" : "status-healthy",
          },
        ];
        try {
          const credits = await this.api.get("/credits");
          const total = credits.data?.total_credits ?? 0;
          const used = credits.data?.total_usage ?? 0;
          stats.push({ label: "Account credits left", value: `$${(total - used).toFixed(2)}` });
        } catch {
          // /credits needs a management key; skip the stat rather than fail.
        }
        return stats;
      }

      if (resourceTypeId === "model") {
        const resource = await runPluginEffect(
          this.getResource(resourceTypeId, resourceId, accountId),
        );
        const f = resource.fields;
        return [
          { label: "Context", value: Number(f["contextLength"] ?? 0).toLocaleString() },
          { label: "Prompt", value: `$${Number(f["promptPricePerMillion"] ?? 0).toFixed(2)}/M` },
          {
            label: "Completion",
            value: `$${Number(f["completionPricePerMillion"] ?? 0).toFixed(2)}/M`,
          },
        ];
      }

      if (resourceTypeId === "model-endpoint") {
        const resource = await runPluginEffect(
          this.getResource(resourceTypeId, resourceId, accountId),
        );
        const f = resource.fields;
        const uptime = Number(f["uptimeLast1d"] ?? 0);
        return [
          { label: "Provider", value: String(f["providerName"] ?? "") },
          {
            label: "Uptime (1d)",
            value: `${(uptime * 100).toFixed(1)}%`,
            variant:
              uptime >= 0.99 ? "status-healthy" : uptime >= 0.9 ? "default" : "status-degraded",
          },
          { label: "p50 latency", value: `${Math.round(Number(f["latencyP50"] ?? 0))} ms` },
        ];
      }

      return [];
    });
  }

  // ----------------------------------------------------------- usage/costs

  /**
   * GET /activity: daily rows for the last 30 completed UTC days, broken down
   * by model + provider. Management key required; a plain key 403s.
   */
  fetchCostData(accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      // Normalized AI dimensions (`ai:provider`, and `ai:model` /
      // `ai:token_type` where the billing API says), so request logs can be
      // reconciled against this bill. See plugin-base `ai-requests.ts`.
      return withAiCostTags(await this.fetchUntaggedCostRows(accountId, range), (row) => {
        return { provider: "openrouter", model: row.resourceId || undefined };
      });
    });
  }

  private async fetchUntaggedCostRows(
    _accountId: string,
    range: CostFetchRange,
  ): Promise<CostRow[]> {
    const items = await this.fetchActivity();
    return items
      .filter((item) => item.date >= range.fromDate && item.date <= range.toDate)
      .map((item) => ({
        date: item.date,
        service: item.provider_name || "OpenRouter",
        resourceId: item.model || item.model_permaslug || "",
        currency: "USD",
        // `usage` is spend in credits, which are USD. BYOK inference is billed
        // upstream, so it is added separately rather than double-counted.
        amount: (item.usage ?? 0) + (item.byok_usage_inference ?? 0),
        ...(item.requests !== undefined
          ? { usageAmount: item.requests, usageUnit: "Requests" }
          : {}),
      }));
  }

  private async fetchActivity(): Promise<OrActivityItem[]> {
    try {
      const data = await this.api.get("/activity");
      return data.data ?? [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("403") || message.includes("401")) {
        throw new CostSetupError(
          "OpenRouter's /activity endpoint only accepts a management key. Replace this account's credential with a management key to collect spend.",
          {
            label: "Create a management key",
            url: "https://openrouter.ai/settings/management-keys",
          },
        );
      }
      throw err;
    }
  }

  /**
   * Metrics tabs for models, API keys and workspaces, from the Analytics API
   * (`POST /analytics/query`, management key, the programmatic form of the
   * Activity dashboard's Explore view). Models fall back to the daily
   * `GET /activity` rows when the query endpoint refuses the key.
   * https://openrouter.ai/docs/api/api-reference/analytics/query-analytics-data
   */
  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const id = resourceId.split(":").slice(2).join(":");
      if (!id) return [];
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

      let filter: OrAnalyticsFilter;
      switch (resourceTypeId) {
        case "model": {
          // Filters match the model's permaslug (`canonical_slug`), which often
          // differs from the catalogue id (dated snapshots), so pass both.
          const canonical = await this.canonicalSlugOf(id).catch(() => "");
          filter = {
            field: "model",
            operator: "in",
            value: canonical && canonical !== id ? [id, canonical] : [id],
          };
          break;
        }
        case "api-key":
          // `api_key_id` accepts the key hash and resolves it server-side.
          filter = { field: "api_key_id", operator: "eq", value: id };
          break;
        case "workspace":
          filter = { field: "workspace", operator: "eq", value: id };
          break;
        default:
          return [];
      }

      try {
        return await this.queryAnalyticsSeries(filter, startMs, endMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/\b(401|403|404)\b/.test(message)) throw err;
        return resourceTypeId === "model" ? this.activitySeries(id, startMs, endMs) : [];
      }
    });
  }

  /**
   * Two queries over the same buckets: usage metrics for any range, and the
   * latency and throughput percentiles, which OpenRouter only computes for
   * ranges up to 31 days. The second one failing never hides the first.
   */
  private async queryAnalyticsSeries(
    filter: OrAnalyticsFilter,
    startMs: number,
    endMs: number,
  ): Promise<MetricSeries[]> {
    const span = endMs - startMs;
    const granularity = span <= 6 * HOUR_MS ? "minute" : span <= 7 * 24 * HOUR_MS ? "hour" : "day";
    const run = (metrics: AnalyticsMetric[]) =>
      this.api.post("/analytics/query", {
        body: {
          metrics: metrics.map((m) => m.name),
          filters: [filter],
          granularity,
          limit: 1000,
          time_range: {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
          },
        },
      });

    const usage = await run(ANALYTICS_USAGE_METRICS);
    const performance =
      span <= ANALYTICS_LATENCY_MAX_DAYS * 24 * HOUR_MS
        ? await run(ANALYTICS_PERFORMANCE_METRICS).catch((): OrAnalyticsAnswer => ({}))
        : {};

    return [
      ...analyticsSeries(usage, ANALYTICS_USAGE_METRICS, granularity),
      ...analyticsSeries(performance, ANALYTICS_PERFORMANCE_METRICS, granularity),
    ];
  }

  /** The model's `canonical_slug`, from the catalogue, cached for the client's life. */
  private async canonicalSlugOf(modelId: string): Promise<string> {
    if (!this.canonicalSlugs) {
      this.canonicalSlugs = this.fetchAllModels().then(
        (models) => new Map(models.map((m) => [m.id, m.canonical_slug ?? ""])),
      );
      // A failed catalogue fetch shouldn't poison every later lookup.
      this.canonicalSlugs.catch(() => {
        this.canonicalSlugs = undefined;
      });
    }
    return (await this.canonicalSlugs).get(modelId) ?? "";
  }

  /** Daily spend, requests and tokens for one model, read off GET /activity. */
  private async activitySeries(
    modelId: string,
    startMs: number,
    endMs: number,
  ): Promise<MetricSeries[]> {
    const items = await this.fetchActivity().catch((): OrActivityItem[] => []);

    const keys = [
      ["Spend", "USD", (i: OrActivityItem) => i.usage],
      ["Requests", "requests", (i: OrActivityItem) => i.requests],
      ["Prompt tokens", "tokens", (i: OrActivityItem) => i.prompt_tokens],
      ["Completion tokens", "tokens", (i: OrActivityItem) => i.completion_tokens],
      ["Reasoning tokens", "tokens", (i: OrActivityItem) => i.reasoning_tokens],
    ] as const;
    const sums = keys.map(() => new Map<number, number>());
    for (const item of items) {
      if (item.model !== modelId && item.model_permaslug !== modelId) continue;
      const ts = Date.parse(`${item.date}T00:00:00Z`);
      if (Number.isNaN(ts) || ts < startMs || ts > endMs) continue;
      keys.forEach(([, , pick], index) => {
        const value = pick(item);
        if (value === undefined) return;
        const map = sums[index]!;
        map.set(ts, (map.get(ts) ?? 0) + value);
      });
    }

    const series: MetricSeries[] = [];
    keys.forEach(([label, unit], index) => {
      const map = sums[index]!;
      if (map.size === 0) return;
      series.push({
        label,
        unit,
        points: [...map.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([timestamp, value]) => ({ timestamp, value })),
      });
    });
    return series;
  }

  // ------------------------------------------------------------ create/edit

  /**
   * Live catalogues for the create forms' pickers. Each source degrades to an
   * empty list on its own, so one failing call never blocks the form.
   */
  private async pickerSources(
    need: Partial<Record<keyof PickerSources, boolean>>,
  ): Promise<PickerSources> {
    const [providers, models, keys, workspaces] = await Promise.all([
      need.providers
        ? this.api
            .get("/providers")
            .then((d) => d.data ?? [])
            .catch((): OrProvider[] => [])
        : Promise.resolve<OrProvider[]>([]),
      need.models
        ? this.fetchAllModels().catch((): OrModel[] => [])
        : Promise.resolve<OrModel[]>([]),
      need.keys
        ? this.api
            .get("/keys")
            .then((d) => d.data ?? [])
            .catch((): OrKey[] => [])
        : Promise.resolve<OrKey[]>([]),
      need.workspaces
        ? this.listPaged((query) => this.api.get("/workspaces", { query })).catch(
            (): OrWorkspace[] => [],
          )
        : Promise.resolve<OrWorkspace[]>([]),
    ]);
    return {
      providers: providers.map((p) => ({ slug: p.slug, ...(p.name ? { name: p.name } : {}) })),
      models: models.map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) })),
      keys: keys.map((k) => ({
        hash: k.hash,
        ...(k.name ? { name: k.name } : {}),
        ...(k.label ? { label: k.label } : {}),
      })),
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        ...(w.slug ? { slug: w.slug } : {}),
      })),
    };
  }

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      switch (typeId) {
        case "api-key":
          break;
        case "guardrail":
          return guardrailCreateConfig(
            await this.pickerSources({
              providers: true,
              models: true,
              keys: true,
              workspaces: true,
            }),
          );
        case "workspace":
          return workspaceCreateConfig(await this.pickerSources({ models: true }));
        case "byok-credential":
          return byokCreateConfig(await this.pickerSources({ providers: true, workspaces: true }));
        default:
          throw new Error(`OpenRouter plugin: no create config for type "${typeId}"`);
      }
      const { workspaces } = await this.pickerSources({ workspaces: true });
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          ...(workspaces.length > 0
            ? [
                {
                  key: "workspaceId",
                  label: "Workspace",
                  kind: "select" as const,
                  required: false,
                  options: [
                    { id: "", label: "Default workspace" },
                    ...workspaces.map((w) => ({ id: w.id, label: w.name || w.slug || w.id })),
                  ],
                  defaultValue: "",
                },
              ]
            : []),
          {
            key: "limit",
            label: "Credit limit (USD)",
            kind: "number",
            required: false,
            description: "Leave blank for no limit.",
          },
          {
            key: "limitReset",
            label: "Limit resets",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "Never (lifetime limit)" },
              { id: "daily", label: "Daily" },
              { id: "weekly", label: "Weekly" },
              { id: "monthly", label: "Monthly" },
            ],
            defaultValue: "",
          },
          {
            key: "expiresAt",
            label: "Expires at",
            kind: "datetime",
            required: false,
            description: "Leave blank for a key that never expires.",
          },
          {
            key: "includeByokInLimit",
            label: "Count BYOK usage toward the limit",
            kind: "select",
            required: false,
            options: [
              { id: "false", label: "No" },
              { id: "true", label: "Yes" },
            ],
            defaultValue: "false",
          },
        ],
      };
    });
  }

  /** POST /keys: the plaintext `key` is only ever returned here. */
  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      switch (typeId) {
        case "api-key":
          break;
        case "guardrail":
          return this.createGuardrail(accountId, fields);
        case "workspace":
          return this.createWorkspace(accountId, fields);
        case "byok-credential": {
          if (!fields["provider"]) throw new Error("OpenRouter plugin: pick a provider");
          if (!fields["key"])
            throw new Error("OpenRouter plugin: the provider API key is required");
          const created = await this.api.post("/byok", {
            body: {
              provider: fields["provider"],
              ...(fields["workspaceId"] ? { workspace_id: fields["workspaceId"] } : {}),
              key: fields["key"],
              ...byokBody(fields),
            },
          });
          return mapByok(accountId, created.data);
        }
        default:
          throw new Error(`OpenRouter plugin: cannot create type "${typeId}"`);
      }
      const name = fields["name"];
      if (!name) throw new Error("OpenRouter plugin: missing API key name");

      const body: OrKeyCreate = { name };
      if (fields["workspaceId"]) body.workspace_id = fields["workspaceId"];
      if (fields["limit"]) body.limit = Number(fields["limit"]);
      if (fields["limitReset"]) body.limit_reset = fields["limitReset"];
      if (fields["expiresAt"]) body.expires_at = fields["expiresAt"];
      if (fields["includeByokInLimit"] === "true") body.include_byok_in_limit = true;

      const created = await this.api.post("/keys", { body });
      const resource = this.mapKey(accountId, new Date().toISOString(), created.data);
      if (created.key) resource.resolvedOutputs = { apiKey: created.key };
      return resource;
    });
  }

  /**
   * POST /guardrails, then POST /guardrails/{id}/assignments/keys for the
   * keys picked in the form.
   */
  private async createGuardrail(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (!fields["name"]) throw new Error("OpenRouter plugin: missing guardrail name");
    const { assignedKeys, workspaceId, ...rest } = fields;
    const created = await this.api.post("/guardrails", {
      body: {
        name: fields["name"],
        ...guardrailBody(rest),
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      },
    });
    const keyHashes = parseList(assignedKeys);
    if (keyHashes.length > 0) {
      await this.api.post(`/guardrails/${pathEncode(created.data.id)}/assignments/keys`, {
        body: { key_hashes: keyHashes },
      });
    }
    return mapGuardrail(accountId, created.data);
  }

  /** POST /workspaces, then PUT a monthly budget when one was entered. */
  private async createWorkspace(
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (!fields["name"]) throw new Error("OpenRouter plugin: missing workspace name");
    if (!fields["slug"]) throw new Error("OpenRouter plugin: missing workspace slug");
    const created = await this.api.post("/workspaces", {
      body: { name: fields["name"], slug: fields["slug"], ...workspaceBody(fields) },
    });
    await this.applyWorkspaceBudgets(created.data.id, fields);
    return mapWorkspace(accountId, created.data);
  }

  /**
   * PUT /workspaces/{ref}/budgets/{interval} for each amount the form set, and
   * DELETE for each one it cleared. `include_byok_in_budgets` rides along on
   * the PUT body, which is the only place the API takes it for a workspace.
   */
  private async applyWorkspaceBudgets(
    workspaceId: string,
    fields: Record<string, string>,
  ): Promise<void> {
    const ref = pathEncode(workspaceId);
    const changes = workspaceBudgetChanges(fields);
    const byok =
      fields["includeByokInBudgets"] !== undefined
        ? { include_byok_in_budgets: fields["includeByokInBudgets"] === "true" }
        : {};
    for (const change of changes) {
      const interval = pathEncode(change.interval);
      if (change.limitUsd === null) {
        await this.api.delete(`/workspaces/${ref}/budgets/${interval}`).catch((err: unknown) => {
          // Clearing a budget that never existed is not worth failing the edit over.
          if (!(err instanceof Error && /API error 404\b/.test(err.message))) throw err;
        });
      } else {
        await this.api.put(`/workspaces/${ref}/budgets/${interval}`, {
          body: { limit_usd: change.limitUsd, ...byok },
        });
      }
    }
  }

  /** PATCH /keys/{hash} */
  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = resourceId.split(":").slice(2).join(":");
      switch (typeId) {
        case "api-key":
          break;
        case "guardrail": {
          const body = guardrailBody(fields);
          if (Object.keys(body).length > 0) {
            await this.api.patch(`/guardrails/${pathEncode(externalId)}`, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "workspace": {
          const body = workspaceBody(fields);
          if (Object.keys(body).length > 0) {
            await this.api.patch(`/workspaces/${pathEncode(externalId)}`, { body });
          }
          await this.applyWorkspaceBudgets(externalId, fields);
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "byok-credential": {
          const body = byokBody(fields);
          if (Object.keys(body).length > 0) {
            await this.api.patch(`/byok/${pathEncode(externalId)}`, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        default:
          throw new Error(`OpenRouter plugin: cannot update type "${typeId}"`);
      }
      const hash = externalId;

      const body: OrKeyUpdate = {};
      if (fields["name"] !== undefined) body.name = fields["name"];
      if (fields["disabled"] !== undefined) body.disabled = fields["disabled"] === "true";
      if (fields["limit"] !== undefined) {
        body.limit = fields["limit"] === "" ? null : Number(fields["limit"]);
      }
      if (fields["limitReset"] !== undefined) {
        body.limit_reset = fields["limitReset"] === "" ? null : fields["limitReset"];
      }
      if (fields["includeByokInLimit"] !== undefined) {
        body.include_byok_in_limit = fields["includeByokInLimit"] === "true";
      }
      if (Object.keys(body).length === 0)
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));

      const updated = await this.api.patch(`/keys/${pathEncode(hash)}`, { body });
      return this.mapKey(accountId, new Date().toISOString(), updated.data);
    });
  }

  /** DELETE /keys/{hash}, /guardrails/{id}, /workspaces/{id} or /byok/{id} */
  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const externalId = pathEncode(resourceId.split(":").slice(2).join(":"));
      switch (typeId) {
        case "api-key":
          await this.api.delete(`/keys/${externalId}`);
          return;
        case "guardrail":
          await this.api.delete(`/guardrails/${externalId}`);
          return;
        // The default workspace refuses deletion without an explicit
        // confirmation flag; the plugin deliberately never sends it.
        case "workspace":
          await this.api.delete(`/workspaces/${externalId}`);
          return;
        case "byok-credential":
          await this.api.delete(`/byok/${externalId}`);
          return;
        default:
          throw new Error(`OpenRouter plugin: cannot delete type "${typeId}"`);
      }
    });
  }

  // ---------------------------------------------------------------- speech

  /**
   * The live audio catalogue. OpenRouter reports dedicated audio models with
   * `output_modalities` of `speech` (TTS) and `transcription` (STT), *not*
   * `audio`, which only covers omni chat models.
   */
  private async speechCatalogue(): Promise<{ tts: OrModel[]; stt: OrModel[] }> {
    if (!this.speechModelsPromise) {
      this.speechModelsPromise = Promise.all([
        this.api.get("/models", { query: { output_modalities: "speech" } }),
        this.api.get("/models", { query: { output_modalities: "transcription" } }),
      ])
        .then(([tts, stt]) => ({ tts: tts.data ?? [], stt: stt.data ?? [] }))
        .catch((err: unknown) => {
          this.speechModelsPromise = undefined;
          throw err;
        });
    }
    return this.speechModelsPromise;
  }

  /**
   * POST /audio/speech. Returns **raw binary**, so this bypasses the typed client,
   * which JSON-parses every response.
   *
   * Spec: https://openrouter.ai/openapi.json  → `SpeechRequest`
   */
  synthesizeSpeech(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): PluginEffect<SynthesizeSpeechResult> {
    return attempt(async () => {
      const key = this.requireInferenceKey();
      const model = await this.resolveSpeechModel(payload.modelId, resourceId, "tts");
      const voice = await this.resolveVoice(payload.voiceId, model);
      const started = Date.now();
      const speechRequest: OrSpeechRequest = {
        model,
        input: payload.text,
        voice,
        // The spec's enum is mp3|pcm: ask for mp3, which <audio> can play.
        response_format: "mp3",
      };

      const transport = { http: this.services?.http, caCert: this.caCert };
      const res = await hostFetch(transport, `${BASE_URL}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(speechRequest),
      });
      if (!res.ok) {
        throw new Error(
          `OpenRouter API error ${res.status} for /audio/speech: ${await res.text().catch(() => "")}`,
        );
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      const elapsed = Date.now() - started;

      return {
        audioBase64: bytesToBase64(bytes),
        mimeType: res.headers.get("content-type") ?? "audio/mpeg",
        fileName: `openrouter-${voice}.mp3`,
        summary: `${payload.text.length.toLocaleString()} characters · ${model} · voice ${voice} · ${(bytes.byteLength / 1024).toFixed(0)} KB · ${elapsed} ms`,
        characters: payload.text.length,
      };
    });
  }

  /**
   * POST /audio/transcriptions. The endpoint takes either multipart or a JSON
   * body with base64 `input_audio`: the JSON form is used because the clip
   * already arrives base64 from the browser, so nothing has to be re-encoded.
   *
   * `verbose_json` is only supported by OpenAI-compatible providers, so a
   * failure falls back to the plain `json` shape rather than surfacing an error.
   *
   * Spec: https://openrouter.ai/openapi.json  → `STTRequest`
   */
  transcribeAudio(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): PluginEffect<TranscribeAudioResult> {
    return attempt(async () => {
      const api = this.apiWith(this.requireInferenceKey());
      const sizeBytes = Math.floor((payload.audioBase64.length * 3) / 4);
      if (sizeBytes > STT_MAX_AUDIO_BYTES) {
        throw new Error(
          `OpenRouter plugin: clip is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB, over the ${STT_MAX_AUDIO_BYTES / 1024 / 1024} MB limit`,
        );
      }

      const model = await this.resolveSpeechModel(payload.modelId, resourceId, "stt");
      const base: OrTranscriptionRequest = {
        model,
        input_audio: {
          // Straight through: the browser's MediaRecorder output is not transcoded.
          data: payload.audioBase64,
          format: audioFormatForMime(payload.mimeType),
        },
      };
      if (payload.language && payload.language !== "auto") base.language = payload.language;

      const started = Date.now();
      let res: OrTranscription;
      try {
        res = await api.post("/audio/transcriptions", {
          body: {
            ...base,
            response_format: "verbose_json",
            timestamp_granularities: ["segment", "word"],
          },
        });
      } catch {
        res = await api.post("/audio/transcriptions", { body: base });
      }
      const elapsed = Date.now() - started;

      const words: TranscriptWord[] = (res.words ?? []).map((w) => ({
        text: w.word,
        start: w.start,
        end: w.end,
        ...(w.speaker !== undefined ? { speaker: `Speaker ${w.speaker + 1}` } : {}),
      }));
      const segments: TranscriptWord[] = (res.segments ?? []).map((s) => ({
        text: s.text,
        start: s.start,
        end: s.end,
        ...(s.speaker !== undefined ? { speaker: `Speaker ${s.speaker + 1}` } : {}),
      }));
      const timings = words.length > 0 ? words : segments;

      const duration = res.duration ?? res.usage?.seconds;
      const summary = [
        model,
        duration !== undefined ? `${duration.toFixed(2)}s audio` : undefined,
        res.usage?.cost !== undefined ? `$${res.usage.cost.toFixed(6)}` : undefined,
        `${(sizeBytes / 1024).toFixed(0)} KB uploaded`,
        `${elapsed} ms`,
      ]
        .filter(Boolean)
        .join(" · ");

      return {
        text: res.text ?? "",
        summary,
        ...(res.language ? { language: res.language } : {}),
        ...(duration !== undefined ? { durationSeconds: duration } : {}),
        ...(timings.length > 0 ? { words: timings } : {}),
      };
    });
  }

  /**
   * Pick a model for one half of the Speech tab. The panel only has a single
   * shared model picker, so a selection meant for the other half is ignored in
   * favour of the resource's own model or a verified default.
   */
  private async resolveSpeechModel(
    picked: string | undefined,
    resourceId: string,
    half: "tts" | "stt",
  ): Promise<string> {
    const resourceModel = resourceId.split(":").slice(2).join(":");
    let catalogue: { tts: OrModel[]; stt: OrModel[] } | undefined;
    try {
      catalogue = await this.speechCatalogue();
    } catch {
      catalogue = undefined;
    }
    const valid = new Set((catalogue?.[half] ?? []).map((m) => m.id));

    if (picked && (valid.size === 0 || valid.has(picked))) return picked;
    if (resourceModel && valid.has(resourceModel)) return resourceModel;
    const first = catalogue?.[half]?.[0]?.id;
    return first ?? (half === "tts" ? FALLBACK_TTS_MODEL : FALLBACK_STT_MODEL);
  }

  /** `voice` is required by SpeechRequest, so always resolve one. */
  private async resolveVoice(picked: string | undefined, model: string): Promise<string> {
    let catalogue: { tts: OrModel[]; stt: OrModel[] } | undefined;
    try {
      catalogue = await this.speechCatalogue();
    } catch {
      catalogue = undefined;
    }
    const entry = catalogue?.tts.find((m) => m.id === model);
    const supported = entry?.supported_voices ?? [];
    if (picked && (supported.length === 0 || supported.includes(picked))) return picked;
    return supported[0] ?? picked ?? FALLBACK_TTS_VOICE;
  }

  // ---------------------------------------------------------------- render

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "model":
        return this.renderModelDetail(resource);
      case "model-endpoint":
        return this.renderEndpointDetail(resource);
      case "provider":
        return this.renderProviderDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      case "guardrail":
        return renderGuardrailDetail(resource);
      case "workspace":
        return renderWorkspaceDetail(resource);
      case "byok-credential":
        return renderByokDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
          sections: [],
          headerActions: [],
        };
    }
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const modelId = String(f["modelId"] ?? resource.displayName);

    const identity: KVItem[] = [
      { key: "Model ID", value: modelId, copyable: true },
      { key: "Canonical Slug", value: String(f["canonicalSlug"] || DASH) },
      { key: "Author", value: String(f["author"] || DASH) },
      { key: "Modality", value: String(f["modality"] || DASH) },
      { key: "Input Modalities", value: String(f["inputModalities"] || DASH) },
      { key: "Output Modalities", value: String(f["outputModalities"] || DASH) },
      { key: "Tokenizer", value: String(f["tokenizer"] || DASH) },
      {
        key: "Context Length",
        value: Number(f["contextLength"] ?? 0)
          ? `${Number(f["contextLength"]).toLocaleString()} tokens`
          : DASH,
      },
      { key: "Knowledge Cutoff", value: String(f["knowledgeCutoff"] || DASH) },
      { key: "Created", value: String(f["created"] || DASH) },
      { key: "Expires", value: String(f["expirationDate"] || "never") },
      { key: "Moderated", value: f["isModerated"] === true ? "Yes" : "No" },
    ];

    const priceRows: TableRow[] = [];
    const addPrice = (label: string, key: string, unit: string) => {
      const value = Number(f[key] ?? 0);
      if (!value) return;
      priceRows.push({ cells: { meter: label, price: `$${value.toFixed(4)}`, unit } });
    };
    addPrice("Prompt", "promptPricePerMillion", "per 1M tokens");
    addPrice("Completion", "completionPricePerMillion", "per 1M tokens");
    addPrice("Image", "imagePrice", "per image");
    addPrice("Request", "requestPrice", "per request");
    addPrice("Web search", "webSearchPrice", "per search");

    const endpoints = parseJson<OrEndpoint[]>(resource.resolvedOutputs["__endpoints__"], []);
    const endpointRows: TableRow[] = endpoints.map((ep) => ({
      cells: {
        provider: ep.provider_name ?? ep.name,
        prompt: `$${perMillion(ep.pricing?.prompt).toFixed(3)}`,
        completion: `$${perMillion(ep.pricing?.completion).toFixed(3)}`,
        context: Number(ep.context_length ?? 0).toLocaleString(),
        uptime: formatUptime(ep.uptime_last_1d),
        p50: formatMs(percentile(ep.latency_last_30m ?? {}, "p50")),
        p99: formatMs(percentile(ep.latency_last_30m ?? {}, "p99")),
        throughput: formatThroughput(percentile(ep.throughput_last_30m ?? {}, "p50")),
      },
    }));

    const sections: SectionNode[] = [
      { kind: "section", title: "Model", children: [{ kind: "key-value-list", items: identity }] },
    ];

    if (f["description"]) {
      sections.push({
        kind: "section",
        title: "Description",
        children: [{ kind: "text", content: String(f["description"]) }],
      });
    }

    if (priceRows.length > 0) {
      sections.push({
        kind: "section",
        title: "Pricing",
        children: [
          {
            kind: "table",
            emphasizeFirstColumn: true,
            columns: [
              { key: "meter", label: "Meter" },
              { key: "price", label: "Price", mono: true },
              { key: "unit", label: "Unit" },
            ],
            rows: priceRows,
          },
        ],
      });
    }

    if (endpointRows.length > 0) {
      sections.push({
        kind: "section",
        title: `Provider endpoints (${endpointRows.length})`,
        children: [
          {
            kind: "table",
            emphasizeFirstColumn: true,
            columns: [
              { key: "provider", label: "Provider" },
              { key: "prompt", label: "Prompt /1M", mono: true },
              { key: "completion", label: "Completion /1M", mono: true },
              { key: "context", label: "Context", mono: true },
              { key: "uptime", label: "Uptime 1d", mono: true },
              { key: "p50", label: "p50", mono: true },
              { key: "p99", label: "p99", mono: true },
              { key: "throughput", label: "Throughput", mono: true },
            ],
            rows: endpointRows,
          },
        ],
      });
    }

    const schema: DetailViewSchema = {
      title: resource.displayName,
      subtitle: joinSubtitle("OpenRouter Model", f["author"]),
      status: { kind: "status-dot", status: "healthy" },
      sections,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      metricsCapability: { defaultTimeRangeMs: ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000 },
    };

    const outputs = String(f["outputModalities"] ?? "");
    if (/speech|transcription/.test(outputs)) {
      schema.speechPanel = this.speechPanel(resource);
    }
    return schema;
  }

  private speechPanel(resource: ResourceInstance): SpeechPanelCapability {
    const catalogue = parseJson<{ tts: OrModel[]; stt: OrModel[] }>(
      resource.resolvedOutputs["__speech__"],
      { tts: [], stt: [] },
    );
    const modelId = String(resource.fields["modelId"] ?? "");
    const isTts = String(resource.fields["outputModalities"] ?? "").includes("speech");

    const models: SpeechPanelOption[] = [
      ...catalogue.tts.map((m) => ({
        id: m.id,
        label: m.name || m.id,
        description: `Text-to-speech · $${perMillion(m.pricing?.prompt).toFixed(2)} per 1M`,
      })),
      ...catalogue.stt.map((m) => ({
        id: m.id,
        label: m.name || m.id,
        description: "Transcription",
      })),
    ];
    if (models.length === 0) {
      models.push(
        { id: FALLBACK_TTS_MODEL, label: FALLBACK_TTS_MODEL, description: "Text-to-speech" },
        { id: FALLBACK_STT_MODEL, label: FALLBACK_STT_MODEL, description: "Transcription" },
      );
    }

    const voices: SpeechPanelOption[] = [];
    const seen = new Set<string>();
    // The model being viewed goes first so its voices are the obvious pick.
    const ordered = [...catalogue.tts].sort((a, b) =>
      a.id === modelId ? -1 : b.id === modelId ? 1 : 0,
    );
    for (const m of ordered) {
      for (const voice of m.supported_voices ?? []) {
        const key = `${m.id}::${voice}`;
        if (seen.has(key)) continue;
        seen.add(key);
        voices.push({ id: voice, label: voice, description: `for ${m.name || m.id}` });
      }
    }
    if (voices.length === 0) {
      voices.push({ id: FALLBACK_TTS_VOICE, label: FALLBACK_TTS_VOICE });
    }

    const panel: SpeechPanelCapability = {
      modes: ["tts", "stt"],
      subtitle: isTts
        ? `Synthesis runs on ${modelId}; pick any transcription model for the other half`
        : `Transcription runs on ${modelId}; pick any speech model for the other half`,
      helpText:
        "Audio comes back as MP3. Transcription posts the clip as base64 JSON, so nothing is re-encoded on the way out.",
      ...(this.inferenceKey
        ? {}
        : {
            disabledReason:
              "OpenRouter rejects management keys on the completion endpoints. Add an inference API key to this account to use the Speech tab.",
          }),
      voices,
      ...(voices[0] ? { defaultVoice: voices[0].id } : {}),
      voiceLabel: "Voice",
      models,
      defaultModel: models.some((m) => m.id === modelId) ? modelId : (models[0]?.id ?? ""),
      modelLabel: "Model",
      maxAudioBytes: STT_MAX_AUDIO_BYTES,
      acceptedAudioTypes: [
        "audio/wav",
        "audio/mpeg",
        "audio/ogg",
        "audio/flac",
        "audio/mp4",
        "audio/webm",
        ".wav",
        ".mp3",
        ".ogg",
        ".flac",
        ".m4a",
        ".mp4",
        ".webm",
      ],
      languages: [
        { id: "auto", label: "Auto-detect" },
        { id: "en", label: "English" },
        { id: "es", label: "Spanish" },
        { id: "fr", label: "French" },
        { id: "de", label: "German" },
        { id: "it", label: "Italian" },
        { id: "pt", label: "Portuguese" },
        { id: "nl", label: "Dutch" },
        { id: "pl", label: "Polish" },
        { id: "ru", label: "Russian" },
        { id: "tr", label: "Turkish" },
        { id: "ar", label: "Arabic" },
        { id: "hi", label: "Hindi" },
        { id: "zh", label: "Chinese" },
        { id: "ja", label: "Japanese" },
        { id: "ko", label: "Korean" },
      ],
      defaultLanguage: "auto",
      languageLabel: "Transcription language",
    };
    return panel;
  }

  private renderEndpointDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const uptime1d = Number(f["uptimeLast1d"] ?? 0);

    return {
      title: resource.displayName,
      subtitle: joinSubtitle("OpenRouter Endpoint", f["modelId"]),
      status: {
        kind: "status-dot",
        status: uptime1d >= 0.99 ? "healthy" : uptime1d >= 0.9 ? "degraded" : "error",
      },
      sections: [
        {
          kind: "section",
          title: "Endpoint",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Provider", value: String(f["providerName"] || DASH) },
                { key: "Model", value: String(f["modelId"] || DASH), copyable: true },
                { key: "Tag", value: String(f["tag"] || DASH) },
                { key: "Status", value: String(f["status"] || DASH) },
                { key: "Quantization", value: String(f["quantization"] || DASH) },
                {
                  key: "Context Length",
                  value: Number(f["contextLength"] ?? 0)
                    ? Number(f["contextLength"]).toLocaleString()
                    : DASH,
                },
                {
                  key: "Max Completion Tokens",
                  value: Number(f["maxCompletionTokens"] ?? 0)
                    ? Number(f["maxCompletionTokens"]).toLocaleString()
                    : DASH,
                },
                {
                  key: "Implicit Caching",
                  value: f["supportsImplicitCaching"] === true ? "Yes" : "No",
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Pricing",
          children: [
            {
              kind: "key-value-list",
              items: [
                {
                  key: "Prompt",
                  value: `$${Number(f["promptPricePerMillion"] ?? 0).toFixed(4)} per 1M tokens`,
                },
                {
                  key: "Completion",
                  value: `$${Number(f["completionPricePerMillion"] ?? 0).toFixed(4)} per 1M tokens`,
                },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Reliability & speed (last 30m unless noted)",
          children: [
            {
              kind: "table",
              emphasizeFirstColumn: true,
              columns: [
                { key: "metric", label: "Metric" },
                { key: "value", label: "Value", mono: true },
              ],
              rows: [
                { cells: { metric: "Uptime 5m", value: formatUptime(f["uptimeLast5m"]) } },
                { cells: { metric: "Uptime 30m", value: formatUptime(f["uptimeLast30m"]) } },
                { cells: { metric: "Uptime 1d", value: formatUptime(f["uptimeLast1d"]) } },
                { cells: { metric: "Latency p50", value: formatMs(f["latencyP50"]) } },
                { cells: { metric: "Latency p75", value: formatMs(f["latencyP75"]) } },
                { cells: { metric: "Latency p90", value: formatMs(f["latencyP90"]) } },
                { cells: { metric: "Latency p99", value: formatMs(f["latencyP99"]) } },
                {
                  cells: { metric: "Throughput p50", value: formatThroughput(f["throughputP50"]) },
                },
                {
                  cells: { metric: "Throughput p90", value: formatThroughput(f["throughputP90"]) },
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderProviderDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const links: SchemaNode[] = [];
    for (const [label, key] of [
      ["Privacy policy", "privacyPolicyUrl"],
      ["Terms of service", "termsOfServiceUrl"],
      ["Status page", "statusPageUrl"],
    ] as const) {
      const url = String(f[key] ?? "");
      if (url) links.push({ kind: "link", label, url });
    }

    return {
      title: resource.displayName,
      subtitle: "OpenRouter Provider",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Provider",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Slug", value: String(f["slug"] || DASH), copyable: true },
                { key: "Name", value: String(f["name"] || DASH) },
                { key: "Headquarters", value: String(f["headquarters"] || DASH) },
                { key: "Datacenters", value: String(f["datacenters"] || DASH) },
              ],
            },
          ],
        },
        ...(links.length > 0
          ? [{ kind: "section" as const, title: "Links", children: links }]
          : []),
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const disabled = f["disabled"] === true;
    const limit = Number(f["limit"] ?? 0);
    const remaining = Number(f["limitRemaining"] ?? 0);

    return {
      metricsCapability: { defaultTimeRangeMs: ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000 },
      title: resource.displayName,
      subtitle: "OpenRouter API Key",
      status: { kind: "status-dot", status: disabled ? "degraded" : "healthy" },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Hash", value: String(f["hash"] || DASH), copyable: true },
                { key: "Name", value: String(f["name"] || DASH) },
                { key: "Label", value: String(f["label"] || DASH) },
                { key: "Status", value: disabled ? "Disabled" : "Active" },
                { key: "Expires", value: String(f["expiresAt"] || "never") },
                { key: "Created", value: String(f["createdAt"] || DASH) },
                { key: "Updated", value: String(f["updatedAt"] || DASH) },
                { key: "Workspace", value: String(f["workspaceId"] || DASH) },
                { key: "Created By", value: String(f["creatorUserId"] || DASH) },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Spend",
          children: [
            {
              kind: "table",
              emphasizeFirstColumn: true,
              columns: [
                { key: "meter", label: "Meter" },
                { key: "value", label: "USD", mono: true },
              ],
              rows: [
                { cells: { meter: "Limit", value: limit > 0 ? `$${limit.toFixed(2)}` : "none" } },
                {
                  cells: {
                    meter: "Remaining",
                    value: limit > 0 ? `$${remaining.toFixed(4)}` : DASH,
                  },
                },
                { cells: { meter: "Reset", value: String(f["limitReset"] || "never") } },
                {
                  cells: { meter: "Total usage", value: `$${Number(f["usage"] ?? 0).toFixed(4)}` },
                },
                { cells: { meter: "Today", value: `$${Number(f["usageDaily"] ?? 0).toFixed(4)}` } },
                {
                  cells: {
                    meter: "This week",
                    value: `$${Number(f["usageWeekly"] ?? 0).toFixed(4)}`,
                  },
                },
                {
                  cells: {
                    meter: "This month",
                    value: `$${Number(f["usageMonthly"] ?? 0).toFixed(4)}`,
                  },
                },
                {
                  cells: {
                    meter: `BYOK${f["includeByokInLimit"] === true ? " (counts toward limit)" : ""}`,
                    value: `$${Number(f["byokUsage"] ?? 0).toFixed(4)}`,
                  },
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === "api-key" || resource.resourceTypeId === "byok-credential") {
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: resource.fields["disabled"] === true ? "degraded" : "healthy",
        },
      };
    }
    if (resource.resourceTypeId === "model-endpoint") {
      const uptime = Number(resource.fields["uptimeLast1d"] ?? 0);
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: uptime >= 0.99 ? "healthy" : uptime >= 0.9 ? "degraded" : "error",
        },
      };
    }
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info" },
    };
  }
}

// -------------------------------------------------------------- helpers

function isAudioModel(m: OrModelFields): boolean {
  const outputs = m.architecture?.output_modalities ?? [];
  return outputs.includes("speech") || outputs.includes("transcription");
}

/** OpenRouter prices are decimal strings in USD per token. */
function perMillion(price: string | undefined): number {
  const n = Number(price ?? 0);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function numeric(value: string | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function percentile(stats: Record<string, number | null> | null, key: string): number {
  const value = stats?.[key];
  return typeof value === "number" ? value : 0;
}

function endpointStatusLabel(status: number | undefined): string {
  // Spec enum: 0 | -1 | -2 | -3 | -5 | -10, where 0 is healthy and
  // increasingly negative values mean increasingly deprioritised.
  if (status === undefined || status === 0) return "healthy";
  return `deprioritised (${status})`;
}

/** A resource field, or an API value on its way to being shown like one. */
type FieldValue = ResourceInstance["fields"][string] | null | undefined;

function formatUptime(value: FieldValue): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return DASH;
  return `${(n * 100).toFixed(2)}%`;
}

function formatMs(value: FieldValue): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return DASH;
  return `${Math.round(n)} ms`;
}

function formatThroughput(value: FieldValue): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return DASH;
  return `${n.toFixed(1)} tok/s`;
}

/**
 * `<modelId>|<endpointName>`. Split on the *first* pipe: a model id never
 * contains one, but endpoint names routinely do ("OpenAI | openai/gpt-4").
 */
function splitEndpointExternalId(externalId: string): [string, string] {
  const idx = externalId.indexOf("|");
  if (idx < 0) return [externalId, ""];
  return [externalId.slice(0, idx), externalId.slice(idx + 1)];
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** `input_audio.format` is the container name, derived from the browser's MIME type. */
function audioFormatForMime(mimeType: string): string {
  const base = (mimeType || "").split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    {
      "audio/webm": "webm",
      "audio/ogg": "ogg",
      "audio/opus": "opus",
      "audio/mp4": "mp4",
      "audio/m4a": "m4a",
      "audio/x-m4a": "m4a",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/wave": "wav",
      "audio/flac": "flac",
      "audio/aac": "aac",
    }[base] ?? "wav"
  );
}
