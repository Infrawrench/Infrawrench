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
  jsonRestFetch,
} from "@infrawrench/plugin-base";

const BASE_URL = "https://openrouter.ai/api/v1";

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

// ---------------------------------------------------------------- API shapes

interface OrPricing {
  prompt?: string;
  completion?: string;
  image?: string;
  request?: string;
  web_search?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  audio?: string;
  audio_output?: string;
}

interface OrModel {
  id: string;
  canonical_slug?: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number | null;
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
  hugging_face_id?: string | null;
  architecture?: {
    modality?: string;
    tokenizer?: string;
    instruct_type?: string | null;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: OrPricing;
  supported_parameters?: string[];
  supported_voices?: string[] | null;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
    is_moderated?: boolean;
  };
}

interface OrEndpoint {
  name: string;
  model_id?: string;
  model_name?: string;
  provider_name?: string;
  tag?: string;
  context_length?: number;
  max_prompt_tokens?: number | null;
  max_completion_tokens?: number | null;
  quantization?: string | null;
  status?: number;
  pricing?: OrPricing;
  supported_parameters?: string[];
  supports_implicit_caching?: boolean;
  uptime_last_5m?: number | null;
  uptime_last_30m?: number | null;
  uptime_last_1d?: number | null;
  latency_last_30m?: Record<string, number | null> | null;
  throughput_last_30m?: Record<string, number | null> | null;
}

interface OrProvider {
  slug: string;
  name?: string;
  headquarters?: string | null;
  datacenters?: string[] | null;
  privacy_policy_url?: string | null;
  terms_of_service_url?: string | null;
  status_page_url?: string | null;
}

interface OrKey {
  hash: string;
  name?: string;
  label?: string;
  disabled?: boolean;
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  byok_usage?: number;
  include_byok_in_limit?: boolean;
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string | null;
  workspace_id?: string;
  creator_user_id?: string | null;
}

interface OrActivityItem {
  date: string;
  model?: string;
  model_permaslug?: string;
  endpoint_id?: string;
  provider_name?: string;
  usage?: number;
  byok_usage_inference?: number;
  requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
}

interface OrSttResponse {
  text: string;
  task?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number; speaker?: number }>;
  segments?: Array<{ text: string; start: number; end: number; speaker?: number }>;
  usage?: {
    cost?: number;
    seconds?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * OpenRouter plugin client.
 *
 * Two credentials, because OpenRouter genuinely needs two:
 *   - the **management key** (formerly "provisioning key") is the only thing
 *     `/credits`, `/activity` and `/keys*` accept — a plain key 403s;
 *   - a normal **inference key** is the only thing `/audio/speech` and
 *     `/audio/transcriptions` accept — management keys are rejected by the
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
  private readonly caCert: string | undefined;
  private readonly services: HostServices | undefined;
  private speechModelsPromise: Promise<{ tts: OrModel[]; stt: OrModel[] }> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const managementKey = credentials["managementKey"] || credentials["apiKey"];
    if (!managementKey) throw new Error("OpenRouter plugin: missing managementKey credential");
    this.managementKey = managementKey;
    this.inferenceKey = credentials["apiKey"] || undefined;
    this.caCert = credentials["caCert"] || undefined;
    this.services = services;
  }

  // ------------------------------------------------------------------ HTTP

  private async fetch<T>(path: string, options?: RequestInit, key?: string): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "OpenRouter",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: {
        Authorization: `Bearer ${key ?? this.managementKey}`,
        Accept: "application/json",
      },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  /** Inference endpoints reject management keys outright. */
  private requireInferenceKey(): string {
    if (!this.inferenceKey) {
      throw new Error(
        "OpenRouter plugin: this needs an inference API key. Management keys are rejected by the completion endpoints — add one under the account's credentials (openrouter.ai/settings/keys).",
      );
    }
    return this.inferenceKey;
  }

  // ------------------------------------------------------------------ list

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return this.listModels(accountId);
      case "model-endpoint":
        return this.listModelEndpoints(accountId);
      case "provider":
        return this.listProviders(accountId);
      case "api-key":
        return this.listApiKeys(accountId);
      default:
        throw new Error(`OpenRouter plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * GET /models. `output_modalities=all` is needed to see image, speech,
   * transcription and embedding models — the endpoint defaults to text only.
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
      const qs = new URLSearchParams({
        limit: String(MODELS_PAGE_SIZE),
        offset: String(offset),
        output_modalities: "all",
      });
      const data = await this.fetch<{ data?: OrModel[] }>(`/models?${qs.toString()}`);
      const page = data.data ?? [];
      out.push(...page);
      if (page.length < MODELS_PAGE_SIZE) break;
    }
    return out;
  }

  private mapModel(accountId: string, now: string, m: OrModel): ResourceInstance {
    const arch = m.architecture ?? {};
    const pricing = m.pricing ?? {};
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
   * models only — see {@link ENDPOINT_FANOUT_MODELS}.
   */
  private async listModelEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const qs = new URLSearchParams({
      limit: String(ENDPOINT_FANOUT_MODELS),
      sort: "most-popular",
      output_modalities: "all",
    });
    const listing = await this.fetch<{ data?: OrModel[] }>(`/models?${qs.toString()}`);
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
      const data = await this.fetch<{ data?: { endpoints?: OrEndpoint[] } }>(
        `/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`,
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

  /** GET /providers */
  private async listProviders(accountId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<{ data?: OrProvider[] }>("/providers");
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

  /** GET /keys — offset-paginated, management key required. */
  private async listApiKeys(accountId: string): Promise<ResourceInstance[]> {
    const now = new Date().toISOString();
    const out: ResourceInstance[] = [];
    const pageSize = 100;

    for (let offset = 0; offset < 50 * pageSize; offset += pageSize) {
      const qs = new URLSearchParams({
        offset: String(offset),
        include_disabled: "true",
      });
      const data = await this.fetch<{ data?: OrKey[] }>(`/keys?${qs.toString()}`);
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = resourceId.split(":").slice(2).join(":");
    const now = new Date().toISOString();

    if (typeId === "api-key") {
      const data = await this.fetch<{ data: OrKey }>(`/keys/${encodeURIComponent(externalId)}`);
      return this.mapKey(accountId, now, data.data);
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
        const data = await this.fetch<{
          data?: OrModel & { endpoints?: OrEndpoint[] };
        }>(`/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`);
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

    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`OpenRouter plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const stored = resource.resolvedOutputs[outputKey];
    if (stored !== undefined) return stored;
    const direct = resource.fields[outputKey];
    if (direct !== undefined) return String(direct);
    throw new Error(`OpenRouter plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // --------------------------------------------------------------- credits

  /**
   * `GET /credits` → `{ total_credits, total_usage }`, both lifetime totals in
   * USD; what remains is the difference.
   *
   * Needs a provisioning key — an inference key 403s here, which the manifest
   * declares so the host can call it a permission gap rather than a failure.
   * `total_credits` is everything ever added, so it *is* an honest `granted`:
   * "spent 38 of 50" is exactly what those two numbers mean.
   */
  async fetchCreditBalance(): Promise<CreditBalance[]> {
    let body: { data?: { total_credits?: number; total_usage?: number } };
    try {
      body = await this.fetch<{ data?: { total_credits?: number; total_usage?: number } }>(
        "/credits",
      );
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
  }

  // ------------------------------------------------------------- dashboard

  /** GET /credits → `{ total_credits, total_usage }` (management key only). */
  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === "api-key") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
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
        const credits = await this.fetch<{
          data?: { total_credits?: number; total_usage?: number };
        }>("/credits");
        const total = credits.data?.total_credits ?? 0;
        const used = credits.data?.total_usage ?? 0;
        stats.push({ label: "Account credits left", value: `$${(total - used).toFixed(2)}` });
      } catch {
        // /credits needs a management key; skip the stat rather than fail.
      }
      return stats;
    }

    if (resourceTypeId === "model") {
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
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
      const resource = await this.getResource(resourceTypeId, resourceId, accountId);
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
  }

  // ----------------------------------------------------------- usage/costs

  /**
   * GET /activity — daily rows for the last 30 completed UTC days, broken down
   * by model + provider. Management key required; a plain key 403s.
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
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
      const data = await this.fetch<{ data?: OrActivityItem[] }>("/activity");
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

  /** Daily spend and request count for one model, read off GET /activity. */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "model") return [];
    const modelId = resourceId.split(":").slice(2).join(":");
    const items = await this.fetchActivity().catch(() => [] as OrActivityItem[]);

    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const spend = new Map<number, number>();
    const requests = new Map<number, number>();
    for (const item of items) {
      if (item.model !== modelId && item.model_permaslug !== modelId) continue;
      const ts = Date.parse(`${item.date}T00:00:00Z`);
      if (Number.isNaN(ts) || ts < startMs || ts > endMs) continue;
      spend.set(ts, (spend.get(ts) ?? 0) + (item.usage ?? 0));
      requests.set(ts, (requests.get(ts) ?? 0) + (item.requests ?? 0));
    }
    if (spend.size === 0) return [];

    const toPoints = (map: Map<number, number>) =>
      [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([timestamp, value]) => ({ timestamp, value }));

    return [
      { label: `${modelId} spend`, unit: "USD", points: toPoints(spend) },
      { label: `${modelId} requests`, unit: "Requests", points: toPoints(requests) },
    ];
  }

  // ------------------------------------------------------------ create/edit

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "api-key") {
      throw new Error(`OpenRouter plugin: no create config for type "${typeId}"`);
    }
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
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
  }

  /** POST /keys — the plaintext `key` is only ever returned here. */
  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "api-key") throw new Error(`OpenRouter plugin: cannot create type "${typeId}"`);
    const name = fields["name"];
    if (!name) throw new Error("OpenRouter plugin: missing API key name");

    const body: Record<string, unknown> = { name };
    if (fields["limit"]) body["limit"] = Number(fields["limit"]);
    if (fields["limitReset"]) body["limit_reset"] = fields["limitReset"];
    if (fields["expiresAt"]) body["expires_at"] = fields["expiresAt"];
    if (fields["includeByokInLimit"] === "true") body["include_byok_in_limit"] = true;

    const created = await this.fetch<{ data: OrKey; key?: string }>("/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const resource = this.mapKey(accountId, new Date().toISOString(), created.data);
    if (created.key) resource.resolvedOutputs = { apiKey: created.key };
    return resource;
  }

  /** PATCH /keys/{hash} */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "api-key") throw new Error(`OpenRouter plugin: cannot update type "${typeId}"`);
    const hash = resourceId.split(":").slice(2).join(":");

    const body: Record<string, unknown> = {};
    if (fields["name"] !== undefined) body["name"] = fields["name"];
    if (fields["disabled"] !== undefined) body["disabled"] = fields["disabled"] === "true";
    if (fields["limit"] !== undefined) {
      body["limit"] = fields["limit"] === "" ? null : Number(fields["limit"]);
    }
    if (fields["limitReset"] !== undefined) {
      body["limit_reset"] = fields["limitReset"] === "" ? null : fields["limitReset"];
    }
    if (fields["includeByokInLimit"] !== undefined) {
      body["include_byok_in_limit"] = fields["includeByokInLimit"] === "true";
    }
    if (Object.keys(body).length === 0) return this.getResource(typeId, resourceId, accountId);

    const updated = await this.fetch<{ data: OrKey }>(`/keys/${encodeURIComponent(hash)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return this.mapKey(accountId, new Date().toISOString(), updated.data);
  }

  /** DELETE /keys/{hash} */
  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    if (typeId !== "api-key") throw new Error(`OpenRouter plugin: cannot delete type "${typeId}"`);
    const hash = resourceId.split(":").slice(2).join(":");
    await this.fetch(`/keys/${encodeURIComponent(hash)}`, { method: "DELETE" });
  }

  // ---------------------------------------------------------------- speech

  /**
   * The live audio catalogue. OpenRouter reports dedicated audio models with
   * `output_modalities` of `speech` (TTS) and `transcription` (STT) — *not*
   * `audio`, which only covers omni chat models.
   */
  private async speechCatalogue(): Promise<{ tts: OrModel[]; stt: OrModel[] }> {
    if (!this.speechModelsPromise) {
      this.speechModelsPromise = Promise.all([
        this.fetch<{ data?: OrModel[] }>("/models?output_modalities=speech"),
        this.fetch<{ data?: OrModel[] }>("/models?output_modalities=transcription"),
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
   * POST /audio/speech. Returns **raw binary**, so this deliberately bypasses
   * `jsonRestFetch` (which JSON-parses every response) and the host HTTP
   * service (whose response body is a UTF-8 string and would mangle the bytes).
   * That means this one request is not routed through a bastion — the trade is
   * documented rather than silent.
   *
   * Spec: https://openrouter.ai/openapi.json  → `SpeechRequest`
   */
  async synthesizeSpeech(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    const key = this.requireInferenceKey();
    const model = await this.resolveSpeechModel(payload.modelId, resourceId, "tts");
    const voice = await this.resolveVoice(payload.voiceId, model);
    const started = Date.now();

    const res = await fetch(`${BASE_URL}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        model,
        input: payload.text,
        voice,
        // The spec's enum is mp3|pcm — ask for mp3, which <audio> can play.
        response_format: "mp3",
      }),
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
  }

  /**
   * POST /audio/transcriptions. The endpoint takes either multipart or a JSON
   * body with base64 `input_audio` — the JSON form is used because the clip
   * already arrives base64 from the browser, so nothing has to be re-encoded.
   *
   * `verbose_json` is only supported by OpenAI-compatible providers, so a
   * failure falls back to the plain `json` shape rather than surfacing an error.
   *
   * Spec: https://openrouter.ai/openapi.json  → `STTRequest`
   */
  async transcribeAudio(
    _typeId: string,
    resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    const key = this.requireInferenceKey();
    const sizeBytes = Math.floor((payload.audioBase64.length * 3) / 4);
    if (sizeBytes > STT_MAX_AUDIO_BYTES) {
      throw new Error(
        `OpenRouter plugin: clip is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB, over the ${STT_MAX_AUDIO_BYTES / 1024 / 1024} MB limit`,
      );
    }

    const model = await this.resolveSpeechModel(payload.modelId, resourceId, "stt");
    const base: Record<string, unknown> = {
      model,
      input_audio: {
        // Straight through — the browser's MediaRecorder output is not transcoded.
        data: payload.audioBase64,
        format: audioFormatForMime(payload.mimeType),
      },
    };
    if (payload.language && payload.language !== "auto") base["language"] = payload.language;

    const started = Date.now();
    let res: OrSttResponse;
    try {
      res = await this.fetch<OrSttResponse>(
        "/audio/transcriptions",
        {
          method: "POST",
          body: JSON.stringify({
            ...base,
            response_format: "verbose_json",
            timestamp_granularities: ["segment", "word"],
          }),
        },
        key,
      );
    } catch {
      res = await this.fetch<OrSttResponse>(
        "/audio/transcriptions",
        { method: "POST", body: JSON.stringify(base) },
        key,
      );
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
      subtitle: `OpenRouter Model · ${String(f["author"] || "")}`.trim(),
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
      subtitle: `OpenRouter Endpoint · ${String(f["modelId"] ?? "")}`,
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
    if (resource.resourceTypeId === "api-key") {
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

function isAudioModel(m: OrModel): boolean {
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

function formatUptime(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return DASH;
  return `${(n * 100).toFixed(2)}%`;
}

function formatMs(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return DASH;
  return `${Math.round(n)} ms`;
}

function formatThroughput(value: unknown): string {
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
