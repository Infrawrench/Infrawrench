import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * AssemblyAI's Voice Agent API and LLM Gateway catalogue: the two surfaces
 * beyond `/v2/transcript` that carry inventory worth listing.
 *
 * Voice agents live on their own host, `https://agents.assemblyai.com/v1`
 * (agents, sessions, webhook subscriptions), and accept the same bare API key
 * as the transcription API. The LLM Gateway's `GET /models` is a public
 * catalogue with per-region hosts.
 *
 * Verified 2026-10-03 against
 * https://www.assemblyai.com/docs/voice-agents/voice-agent-api/api-spec/create-agent
 * (and the list/get/update/delete, sessions and webhook-subscription pages
 * beside it) and
 * https://www.assemblyai.com/docs/llm-gateway/api-reference/list-available-models
 */

export const VOICE_AGENT_TYPE = "voice-agent";
export const AGENT_SESSION_TYPE = "agent-session";
export const WEBHOOK_TYPE = "webhook-subscription";
export const LLM_MODEL_TYPE = "llm-model";

export const VOICE_AGENT_TYPES = new Set([
  VOICE_AGENT_TYPE,
  AGENT_SESSION_TYPE,
  WEBHOOK_TYPE,
  LLM_MODEL_TYPE,
]);

const AGENTS_BASE_URL = "https://agents.assemblyai.com/v1";
const LLM_GATEWAY_HOSTS: Record<string, string> = {
  us: "https://llm-gateway.assemblyai.com/v1",
  eu: "https://llm-gateway.eu.assemblyai.com/v1",
};

/** `GET /v1/sessions` caps `limit` at 200. */
const SESSION_PAGE_SIZE = 200;
const MAX_SESSION_PAGES = 5;
/** `GET /v1/webhook-subscriptions` caps `limit` at 100. */
const WEBHOOK_PAGE_SIZE = 100;
const MAX_WEBHOOK_PAGES = 5;

/**
 * The documented voice ids. There is no voice-listing endpoint, so this is the
 * table from https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices
 */
export const VOICES: Array<{ id: string; label: string; description: string }> = [
  { id: "alba", label: "Alba", description: "English (American)" },
  { id: "eve", label: "Eve", description: "English (American)" },
  { id: "george", label: "George", description: "English (American)" },
  { id: "jane", label: "Jane", description: "English (American)" },
  { id: "jean", label: "Jean", description: "English (American)" },
  { id: "mary", label: "Mary", description: "English (American)" },
  { id: "michael", label: "Michael", description: "English (American)" },
  { id: "anna", label: "Anna", description: "English (British)" },
  { id: "charles", label: "Charles", description: "English (British)" },
  { id: "paul", label: "Paul", description: "English (British)" },
  { id: "vera", label: "Vera", description: "English (British)" },
  { id: "giovanni", label: "Giovanni", description: "Italian" },
  { id: "lola", label: "Lola", description: "Spanish" },
  { id: "juergen", label: "Juergen", description: "German" },
  { id: "rafael", label: "Rafael", description: "Portuguese" },
  { id: "estelle", label: "Estelle", description: "French" },
];

/** `WebhookEvent`, with the boolean field each one is edited through. */
export const WEBHOOK_EVENTS: Array<{ id: string; field: string; label: string }> = [
  { id: "session.started", field: "eventSessionStarted", label: "Session started" },
  { id: "session.completed", field: "eventSessionCompleted", label: "Session completed" },
  { id: "call.connected", field: "eventCallConnected", label: "Call connected" },
  { id: "call.ended", field: "eventCallEnded", label: "Call ended" },
  { id: "call.failed", field: "eventCallFailed", label: "Call failed" },
];

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface AgentSummary {
  id: string;
  name?: string;
  deleted_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface AgentTool {
  id?: string;
  name?: string;
  description?: string;
  http?: { url?: string; http_method?: string };
  timeout_seconds?: number;
  execution_mode?: string;
}

interface AudioFormat {
  encoding?: string;
  sample_rate?: number;
}

interface Agent extends AgentSummary {
  system_prompt?: string;
  greeting?: string | null;
  voice?: { voice_id?: string };
  input?: { type?: string; format?: AudioFormat; keyterms?: string[] | null } | null;
  output?: { type?: string; voice?: string; format?: AudioFormat; volume?: number | null } | null;
  tools?: AgentTool[] | null;
  llm?: Array<{ base_url?: string; model?: string }> | null;
  pre_connect_requests?: unknown[] | null;
}

interface Session {
  id: string;
  agent_id?: string | null;
  status?: string;
  public_close_reason?: string | null;
  duration_seconds?: number | null;
  created_at?: string | null;
  ended_at?: string | null;
  artifacts?: Array<{ type?: string; url?: string; content_type?: string }>;
}

interface SessionPage {
  sessions?: Session[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface WebhookSubscription {
  id: string;
  agent_id?: string | null;
  url?: string;
  events?: string[];
  enabled?: boolean;
  secret_version?: number;
  created_at?: string;
  updated_at?: string;
}

interface WebhookPage {
  subscriptions?: WebhookSubscription[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface LlmModel {
  id: string;
  name?: string;
  description?: string;
  creator?: string;
  context_length?: number;
  supported_parameters?: string[];
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  pricing?: Record<string, unknown> & { regional_increase_percent?: number };
  retirement_date?: number | string | null;
  available_regions?: string[];
}

interface ModelPrices {
  prompt?: number;
  completions?: number;
  input_cache_read?: number;
  input_cache_write?: number;
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export interface VoiceAgentDeps {
  apiKey: string;
  region: string;
  caCert: string;
  services: HostServices | undefined;
}

function externalOf(resourceId: string): string {
  const parts = resourceId.split(":");
  return parts.length > 2 ? parts.slice(2).join(":") : resourceId;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function perMillion(value: number | undefined): string {
  return value === undefined ? "—" : `$${value.toFixed(2)} / 1M`;
}

function randomSecret(length = 48): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export class VoiceAgentSurface {
  constructor(private readonly deps: VoiceAgentDeps) {}

  private async request<T>(url: string, path: string, options?: RequestInit): Promise<T> {
    const http = this.deps.services?.http;
    return jsonRestFetch<T>({
      vendor: "AssemblyAI",
      url,
      errorPath: path,
      headers: { authorization: this.deps.apiKey, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(http ? { http, ...(this.deps.caCert ? { caCert: this.deps.caCert } : {}) } : {}),
    });
  }

  private agents<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(`${AGENTS_BASE_URL}${path}`, path, options);
  }

  private get gatewayUrl(): string {
    return LLM_GATEWAY_HOSTS[this.deps.region] ?? LLM_GATEWAY_HOSTS["us"]!;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case VOICE_AGENT_TYPE: {
        const agents = await this.fetchAgents();
        return agents.map((a) => this.mapAgent(accountId, a));
      }
      case AGENT_SESSION_TYPE: {
        const [sessions, agents] = await Promise.all([
          this.fetchSessions(),
          this.fetchAgents().catch(() => [] as AgentSummary[]),
        ]);
        const names = new Map(agents.map((a) => [a.id, a.name ?? a.id]));
        return sessions.map((s) => this.mapSession(accountId, s, names));
      }
      case WEBHOOK_TYPE: {
        const [subs, agents] = await Promise.all([
          this.fetchWebhooks(),
          this.fetchAgents().catch(() => [] as AgentSummary[]),
        ]);
        const names = new Map(agents.map((a) => [a.id, a.name ?? a.id]));
        return subs.map((s) => this.mapWebhook(accountId, s, names));
      }
      case LLM_MODEL_TYPE: {
        const data = await this.request<{ data?: LlmModel[] }>(
          `${this.gatewayUrl}/models`,
          "/models",
        );
        return (data.data ?? []).map((m) => this.mapModel(accountId, m));
      }
      default:
        throw new Error(`AssemblyAI plugin: unknown resource type "${typeId}"`);
    }
  }

  async get(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    if (typeId === VOICE_AGENT_TYPE) {
      const agent = await this.agents<Agent>(`/agents/${encodeURIComponent(id)}`);
      return this.mapAgent(accountId, agent);
    }
    if (typeId === AGENT_SESSION_TYPE) {
      const session = await this.agents<Session>(`/sessions/${encodeURIComponent(id)}`);
      let names = new Map<string, string>();
      if (session.agent_id) {
        const agent = await this.agents<Agent>(
          `/agents/${encodeURIComponent(session.agent_id)}`,
        ).catch(() => undefined);
        if (agent) names = new Map([[agent.id, agent.name ?? agent.id]]);
      }
      return this.mapSession(accountId, session, names);
    }
    const all = await this.list(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`AssemblyAI plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  /** `GET /v1/agents`: lightweight records, newest first; soft-deleted ones are skipped. */
  private async fetchAgents(): Promise<AgentSummary[]> {
    const agents = await this.agents<AgentSummary[]>("/agents");
    return (Array.isArray(agents) ? agents : []).filter((a) => !a.deleted_at);
  }

  /** `GET /v1/sessions`, newest first, walking `response_metadata.next_cursor`. */
  private async fetchSessions(agentId?: string, sinceMs?: number): Promise<Session[]> {
    const out: Session[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_SESSION_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(SESSION_PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      if (agentId) params.set("agent_id", agentId);
      const data = await this.agents<SessionPage>(`/sessions?${params.toString()}`);
      const batch = data.sessions ?? [];
      out.push(...batch);
      cursor = data.response_metadata?.next_cursor ?? "";
      const oldest = Date.parse(str(batch[batch.length - 1]?.created_at));
      if (sinceMs !== undefined && Number.isFinite(oldest) && oldest < sinceMs) break;
      if (!data.has_more || !cursor || batch.length === 0) break;
    }
    return out;
  }

  /** `GET /v1/webhook-subscriptions`, walking `response_metadata.next_cursor`. */
  private async fetchWebhooks(): Promise<WebhookSubscription[]> {
    const out: WebhookSubscription[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_WEBHOOK_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(WEBHOOK_PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      const data = await this.agents<WebhookPage>(`/webhook-subscriptions?${params.toString()}`);
      out.push(...(data.subscriptions ?? []));
      cursor = data.response_metadata?.next_cursor ?? "";
      if (!data.has_more || !cursor) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapAgent(accountId: string, agent: Agent): ResourceInstance {
    const created = agent.created_at ?? new Date().toISOString();
    const tools = agent.tools ?? [];
    const llm = agent.llm?.[0];
    const format = (f: AudioFormat | undefined): string =>
      [f?.encoding, num(f?.sample_rate) ? `${f?.sample_rate} Hz` : ""].filter(Boolean).join(" · ");
    return {
      id: `${accountId}:${VOICE_AGENT_TYPE}:${agent.id}`,
      pluginId: "assemblyai",
      resourceTypeId: VOICE_AGENT_TYPE,
      accountId,
      displayName: agent.name || agent.id,
      fields: {
        name: agent.name ?? "",
        agentId: agent.id,
        voiceId: agent.voice?.voice_id ?? agent.output?.voice ?? "",
        greeting: agent.greeting ?? "",
        systemPrompt: agent.system_prompt ?? "",
        toolCount: tools.length,
        tools: tools
          .map((t) => t.name ?? "")
          .filter(Boolean)
          .join(", "),
        llmModel: llm?.model ?? "",
        llmBaseUrl: llm?.base_url ?? "",
        inputFormat: format(agent.input?.format),
        outputFormat: format(agent.output?.format),
        keyterms: (agent.input?.keyterms ?? []).join(", "),
        createdAt: created,
        updatedAt: agent.updated_at ?? created,
      },
      resolvedOutputs: { agentId: agent.id, agentName: agent.name ?? "" },
      secretStates: [],
      externalId: agent.id,
      createdAt: created,
      updatedAt: agent.updated_at ?? created,
    };
  }

  private mapSession(
    accountId: string,
    session: Session,
    agentNames: Map<string, string>,
  ): ResourceInstance {
    const created = session.created_at ?? new Date().toISOString();
    const agentId = session.agent_id ?? "";
    return {
      id: `${accountId}:${AGENT_SESSION_TYPE}:${session.id}`,
      pluginId: "assemblyai",
      resourceTypeId: AGENT_SESSION_TYPE,
      accountId,
      displayName: `${agentNames.get(agentId) ?? "Session"} · ${created.slice(0, 19).replace("T", " ")}`,
      fields: {
        sessionId: session.id,
        status: session.status ?? "",
        agentId,
        agentName: agentNames.get(agentId) ?? "",
        durationSeconds: num(session.duration_seconds) ?? 0,
        closeReason: session.public_close_reason ?? "",
        createdAt: created,
        endedAt: session.ended_at ?? "",
      },
      resolvedOutputs: {
        sessionId: session.id,
        // Pre-signed and short-lived, so only ever stashed from a fresh read.
        __artifacts__: JSON.stringify(session.artifacts ?? []),
      },
      secretStates: [],
      externalId: session.id,
      createdAt: created,
      updatedAt: session.ended_at ?? created,
    };
  }

  private mapWebhook(
    accountId: string,
    sub: WebhookSubscription,
    agentNames: Map<string, string>,
  ): ResourceInstance {
    const created = sub.created_at ?? new Date().toISOString();
    const events = new Set(sub.events ?? []);
    const agentId = sub.agent_id ?? "";
    const fields: Record<string, string | number | boolean> = {
      url: sub.url ?? "",
      enabled: sub.enabled !== false,
      agentId,
      scope: agentId ? (agentNames.get(agentId) ?? agentId) : "All agents",
      events: [...events].join(", "),
      secretVersion: num(sub.secret_version) ?? 0,
      newSecret: "",
      createdAt: created,
      updatedAt: sub.updated_at ?? created,
    };
    for (const event of WEBHOOK_EVENTS) fields[event.field] = events.has(event.id);
    let host = sub.url ?? sub.id;
    try {
      host = new URL(sub.url ?? "").host || host;
    } catch {
      // Keep the raw value.
    }
    return {
      id: `${accountId}:${WEBHOOK_TYPE}:${sub.id}`,
      pluginId: "assemblyai",
      resourceTypeId: WEBHOOK_TYPE,
      accountId,
      displayName: host,
      fields,
      resolvedOutputs: { subscriptionId: sub.id, url: sub.url ?? "" },
      secretStates: [],
      externalId: sub.id,
      createdAt: created,
      updatedAt: sub.updated_at ?? created,
    };
  }

  private mapModel(accountId: string, model: LlmModel): ResourceInstance {
    const now = new Date().toISOString();
    const pricing = model.pricing ?? {};
    const tier = (pricing["global"] ??
      Object.values(pricing).find((v) => typeof v === "object" && v !== null) ??
      {}) as ModelPrices;
    const retirement = model.retirement_date;
    const retires =
      typeof retirement === "number" && retirement > 0
        ? new Date(retirement * (retirement < 1e12 ? 1000 : 1)).toISOString().slice(0, 10)
        : typeof retirement === "string"
          ? retirement
          : "";
    return {
      id: `${accountId}:${LLM_MODEL_TYPE}:${model.id}`,
      pluginId: "assemblyai",
      resourceTypeId: LLM_MODEL_TYPE,
      accountId,
      displayName: model.name || model.id,
      fields: {
        modelId: model.id,
        name: model.name ?? model.id,
        creator: model.creator ?? "",
        contextLength: num(model.context_length) ?? num(model.top_provider?.context_length) ?? 0,
        maxCompletionTokens: num(model.top_provider?.max_completion_tokens) ?? 0,
        promptPrice: num(tier.prompt) ?? 0,
        completionPrice: num(tier.completions) ?? 0,
        cacheReadPrice: num(tier.input_cache_read) ?? 0,
        regionalIncreasePercent: num(pricing.regional_increase_percent) ?? 0,
        regions: (model.available_regions ?? []).join(", "),
        supportedParameters: (model.supported_parameters ?? []).join(", "),
        retirementDate: retires,
      },
      resolvedOutputs: { modelId: model.id },
      secretStates: [],
      externalId: model.id,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === VOICE_AGENT_TYPE) {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "voiceId",
            label: "Voice",
            kind: "select",
            required: true,
            options: VOICES.map((v) => ({ id: v.id, label: `${v.label} (${v.description})` })),
            defaultValue: "alba",
          },
          {
            key: "systemPrompt",
            label: "System Prompt",
            kind: "text",
            multiline: true,
            required: true,
            description: "How the agent should behave. Keep spoken responses short.",
          },
          {
            key: "greeting",
            label: "Greeting",
            kind: "text",
            required: false,
            description: "What the agent says first. Leave blank to wait for the caller.",
          },
          {
            key: "keyterms",
            label: "Key Terms",
            kind: "string-list",
            required: false,
            placeholder: "term",
            addLabel: "+ Add term",
            description: "Names and jargon the speech recognition should listen for (up to 100).",
          },
        ],
      };
    }

    if (typeId === WEBHOOK_TYPE) {
      const agents = await this.fetchAgents().catch(() => [] as AgentSummary[]);
      return {
        fields: [
          {
            key: "url",
            label: "Delivery URL",
            kind: "text",
            required: true,
            placeholder: "https://example.com/assemblyai/webhooks",
            description: "Must be HTTPS on a public host.",
          },
          {
            key: "agentId",
            label: "Agent",
            kind: "select",
            required: false,
            options: [
              { id: "", label: "All agents (account-wide)" },
              ...agents.map((a) => ({ id: a.id, label: a.name ?? a.id })),
            ],
            defaultValue: "",
          },
          {
            key: "events",
            label: "Events",
            kind: "policy-picker",
            required: true,
            policies: WEBHOOK_EVENTS.map((e) => ({ id: e.id, label: e.label, description: e.id })),
          },
          {
            key: "secret",
            label: "Signing Secret",
            kind: "password",
            required: false,
            description:
              "32 to 256 characters, no whitespace. Leave blank to have one generated; it is shown once.",
          },
        ],
      };
    }

    throw new Error(`AssemblyAI plugin: no create config for type "${typeId}"`);
  }

  async create(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === VOICE_AGENT_TYPE) {
      const name = (fields["name"] ?? "").trim();
      const systemPrompt = (fields["systemPrompt"] ?? "").trim();
      if (!name || !systemPrompt) {
        throw new Error("AssemblyAI plugin: a voice agent needs a name and a system prompt");
      }
      const body: Record<string, unknown> = {
        name,
        system_prompt: systemPrompt,
        voice: { voice_id: fields["voiceId"] || "alba" },
      };
      const greeting = (fields["greeting"] ?? "").trim();
      if (greeting) body["greeting"] = greeting;
      const keyterms = (fields["keyterms"] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 100);
      if (keyterms.length > 0) body["input"] = { keyterms };
      const agent = await this.agents<Agent>("/agents", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return this.mapAgent(accountId, agent);
    }

    if (typeId === WEBHOOK_TYPE) {
      const url = (fields["url"] ?? "").trim();
      if (!url.startsWith("https://")) {
        throw new Error("AssemblyAI plugin: the delivery URL must be HTTPS");
      }
      const events = parseEvents(fields["events"]);
      if (events.length === 0) throw new Error("AssemblyAI plugin: pick at least one event");
      const provided = (fields["secret"] ?? "").trim();
      if (provided && (provided.length < 32 || provided.length > 256 || /\s/.test(provided))) {
        throw new Error(
          "AssemblyAI plugin: the signing secret must be 32 to 256 characters with no whitespace",
        );
      }
      const secret = provided || randomSecret();
      const body: Record<string, unknown> = { url, events, secret, enabled: true };
      if (fields["agentId"]) body["agent_id"] = fields["agentId"];
      const sub = await this.agents<WebhookSubscription>("/webhook-subscriptions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const instance = this.mapWebhook(accountId, sub, new Map());
      // The secret is write-only; this is the only time it can be shown.
      if (!provided) instance.resolvedOutputs["signingSecret"] = secret;
      return instance;
    }

    throw new Error(`AssemblyAI plugin: cannot create type "${typeId}"`);
  }

  async update(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);

    if (typeId === VOICE_AGENT_TYPE) {
      // `PUT /v1/agents/{id}`: every field optional, only the ones sent change.
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined && fields["name"].trim())
        body["name"] = fields["name"].trim();
      if (fields["systemPrompt"] !== undefined && fields["systemPrompt"].trim()) {
        body["system_prompt"] = fields["systemPrompt"];
      }
      if (fields["voiceId"]) body["voice"] = { voice_id: fields["voiceId"] };
      if (fields["greeting"] !== undefined) {
        body["greeting"] = fields["greeting"].trim() ? fields["greeting"] : null;
      }
      if (Object.keys(body).length === 0) return this.get(typeId, resourceId, accountId);
      const agent = await this.agents<Agent>(`/agents/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return this.mapAgent(accountId, agent);
    }

    if (typeId === WEBHOOK_TYPE) {
      // `PATCH /v1/webhook-subscriptions/{id}`: partial; a new secret rotates it.
      const body: Record<string, unknown> = {};
      if (fields["url"]) body["url"] = fields["url"].trim();
      if (fields["enabled"] !== undefined) body["enabled"] = fields["enabled"] === "true";
      if (WEBHOOK_EVENTS.some((e) => fields[e.field] !== undefined)) {
        const current = await this.get(typeId, resourceId, accountId);
        const events = WEBHOOK_EVENTS.filter((e) =>
          fields[e.field] !== undefined
            ? fields[e.field] === "true"
            : current.fields[e.field] === true,
        ).map((e) => e.id);
        if (events.length === 0) {
          throw new Error("AssemblyAI plugin: a webhook subscription needs at least one event");
        }
        body["events"] = events;
      }
      const secret = (fields["newSecret"] ?? "").trim();
      if (secret) {
        if (secret.length < 32 || secret.length > 256 || /\s/.test(secret)) {
          throw new Error(
            "AssemblyAI plugin: the signing secret must be 32 to 256 characters with no whitespace",
          );
        }
        body["secret"] = secret;
      }
      if (Object.keys(body).length === 0) return this.get(typeId, resourceId, accountId);
      const sub = await this.agents<WebhookSubscription>(
        `/webhook-subscriptions/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      return this.mapWebhook(accountId, sub, new Map());
    }

    throw new Error(`AssemblyAI plugin: cannot update type "${typeId}"`);
  }

  async remove(typeId: string, resourceId: string): Promise<void> {
    const id = encodeURIComponent(externalOf(resourceId));
    const path =
      typeId === VOICE_AGENT_TYPE
        ? `/agents/${id}`
        : typeId === AGENT_SESSION_TYPE
          ? `/sessions/${id}`
          : typeId === WEBHOOK_TYPE
            ? `/webhook-subscriptions/${id}`
            : "";
    if (!path) throw new Error(`AssemblyAI plugin: cannot delete type "${typeId}"`);
    await this.agents<void>(path, { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Stats and metrics
  // -------------------------------------------------------------------------

  stats(resource: ResourceInstance): DashboardStat[] {
    const f = resource.fields;
    switch (resource.resourceTypeId) {
      case VOICE_AGENT_TYPE:
        return [
          { label: "Voice", value: String(f["voiceId"] || "—") },
          { label: "Tools", value: String(f["toolCount"] ?? 0) },
          { label: "LLM", value: String(f["llmModel"] || "Default") },
        ];
      case AGENT_SESSION_TYPE:
        return [
          { label: "Status", value: String(f["status"] || "—") },
          { label: "Duration", value: `${Number(f["durationSeconds"] ?? 0).toFixed(1)} s` },
          { label: "Agent", value: String(f["agentName"] || f["agentId"] || "—") },
        ];
      case WEBHOOK_TYPE:
        return [
          {
            label: "State",
            value: f["enabled"] ? "Enabled" : "Disabled",
            variant: f["enabled"] ? "status-healthy" : "status-degraded",
          },
          { label: "Events", value: String(f["events"] || "—") },
          { label: "Secret version", value: String(f["secretVersion"] ?? 0) },
        ];
      case LLM_MODEL_TYPE:
        return [
          { label: "Prompt", value: perMillion(num(f["promptPrice"])) },
          { label: "Completion", value: perMillion(num(f["completionPrice"])) },
          { label: "Context", value: Number(f["contextLength"] ?? 0).toLocaleString() },
        ];
      default:
        return [];
    }
  }

  /**
   * Daily session count and talk minutes for one agent, bucketed from
   * `GET /v1/sessions?agent_id=`. AssemblyAI has no usage endpoint, so the
   * session list is the only source; it is paged newest-first and stops once
   * it is past the start of the window.
   */
  async metrics(
    resourceId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const dayMs = 86_400_000;
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 30 * dayMs;
    const sessions = await this.fetchSessions(externalOf(resourceId), startMs);
    const buckets = new Map<number, { count: number; minutes: number }>();
    for (let t = Math.floor(startMs / dayMs) * dayMs; t <= endMs; t += dayMs) {
      buckets.set(t, { count: 0, minutes: 0 });
    }
    for (const session of sessions) {
      const at = Date.parse(str(session.created_at));
      if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
      const bucket = buckets.get(Math.floor(at / dayMs) * dayMs);
      if (!bucket) continue;
      bucket.count += 1;
      bucket.minutes += (num(session.duration_seconds) ?? 0) / 60;
    }
    const stamps = [...buckets.keys()].sort((a, b) => a - b);
    return [
      {
        label: "Sessions",
        unit: "count",
        points: stamps.map((t) => ({ timestamp: t, value: buckets.get(t)!.count })),
      },
      {
        label: "Session minutes",
        unit: "minutes",
        points: stamps.map((t) => ({
          timestamp: t,
          value: Number(buckets.get(t)!.minutes.toFixed(2)),
        })),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case VOICE_AGENT_TYPE:
        return this.renderAgent(resource);
      case AGENT_SESSION_TYPE:
        return this.renderSession(resource);
      case WEBHOOK_TYPE:
        return this.renderWebhook(resource);
      default:
        return this.renderModel(resource);
    }
  }

  sidebar(resource: ResourceInstance): SidebarItemSchema {
    const f = resource.fields;
    switch (resource.resourceTypeId) {
      case VOICE_AGENT_TYPE:
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "healthy", label: String(f["voiceId"] || "Agent") },
        };
      case AGENT_SESSION_TYPE: {
        const status = String(f["status"] ?? "");
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status:
              status === "completed" ? "healthy" : status === "failed" ? "error" : "provisioning",
            label: status || "session",
          },
        };
      }
      case WEBHOOK_TYPE:
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: f["enabled"] ? "healthy" : "degraded",
            label: f["enabled"] ? "Enabled" : "Disabled",
          },
        };
      default:
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: f["retirementDate"] ? "degraded" : "info",
            label: String(f["creator"] || "Model"),
          },
        };
    }
  }

  private renderAgent(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const voice = VOICES.find((v) => v.id === f["voiceId"]);
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Agent",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Agent ID", value: String(f["agentId"] ?? ""), copyable: true },
              {
                key: "Voice",
                value: voice
                  ? `${voice.label} (${voice.description})`
                  : String(f["voiceId"] || "—"),
              },
              { key: "Greeting", value: String(f["greeting"] || "—") },
              { key: "LLM", value: String(f["llmModel"] || "AssemblyAI default") },
              ...(f["llmBaseUrl"] ? [{ key: "LLM Endpoint", value: String(f["llmBaseUrl"]) }] : []),
              { key: "Tools", value: String(f["tools"] || "None") },
              ...(f["keyterms"] ? [{ key: "Key Terms", value: String(f["keyterms"]) }] : []),
              ...(f["inputFormat"]
                ? [{ key: "Input Audio", value: String(f["inputFormat"]) }]
                : []),
              ...(f["outputFormat"]
                ? [{ key: "Output Audio", value: String(f["outputFormat"]) }]
                : []),
              { key: "Created", value: String(f["createdAt"] || "—") },
              { key: "Updated", value: String(f["updatedAt"] || "—") },
            ],
          },
        ],
      },
    ];
    if (f["systemPrompt"]) {
      sections.push({
        kind: "section",
        title: "System Prompt",
        children: [{ kind: "text", content: String(f["systemPrompt"]), copyable: true }],
      });
    }
    sections.push({
      kind: "section",
      title: "Notes",
      children: [
        {
          kind: "text",
          variant: "muted",
          content:
            "Name, voice, greeting and system prompt are editable here. Tools, a custom LLM and pre-connect requests are kept as they are on every edit; manage those through the API. Deleting an agent ends nothing already in progress, but new sessions can no longer use it.",
        },
      ],
    });
    return {
      title: resource.displayName,
      subtitle: "AssemblyAI voice agent",
      status: { kind: "status-dot", status: "healthy" },
      sections,
      metricsCapability: { defaultTimeRangeMs: 30 * 86_400_000 },
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderSession(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    let artifacts: Array<{ type?: string; url?: string; content_type?: string }> = [];
    try {
      artifacts = JSON.parse(resource.resolvedOutputs["__artifacts__"] ?? "[]");
    } catch {
      artifacts = [];
    }
    const status = String(f["status"] ?? "");
    return {
      title: resource.displayName,
      subtitle: `AssemblyAI voice agent session · ${status || "unknown"}`,
      status: {
        kind: "status-dot",
        status: status === "completed" ? "healthy" : status === "failed" ? "error" : "provisioning",
        label: status || "session",
      },
      sections: [
        {
          kind: "section",
          title: "Session",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Session ID", value: String(f["sessionId"] ?? ""), copyable: true },
                { key: "Status", value: status || "—" },
                { key: "Agent", value: String(f["agentName"] || f["agentId"] || "—") },
                { key: "Duration", value: `${Number(f["durationSeconds"] ?? 0).toFixed(1)} s` },
                { key: "Close Reason", value: String(f["closeReason"] || "—") },
                { key: "Started", value: String(f["createdAt"] || "—") },
                { key: "Ended", value: String(f["endedAt"] || "—") },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Artifacts",
          children:
            artifacts.length > 0
              ? [
                  ...artifacts
                    .filter((a) => a.url)
                    .map((a) => ({
                      kind: "link" as const,
                      label: `${a.type ?? "artifact"} (${a.content_type ?? "file"})`,
                      url: String(a.url),
                    })),
                  {
                    kind: "text" as const,
                    variant: "muted" as const,
                    content:
                      "Recording, timeline and metadata links are pre-signed and expire quickly; refresh for fresh ones.",
                  },
                ]
              : [
                  {
                    kind: "text",
                    variant: "muted",
                    content: "Artifacts appear once the session completes.",
                  },
                ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderWebhook(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const secret = resource.resolvedOutputs["signingSecret"];
    return {
      title: resource.displayName,
      subtitle: "AssemblyAI voice agent webhook",
      status: {
        kind: "status-dot",
        status: f["enabled"] ? "healthy" : "degraded",
        label: f["enabled"] ? "Enabled" : "Disabled",
      },
      sections: [
        {
          kind: "section",
          title: "Subscription",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Delivery URL", value: String(f["url"] ?? ""), copyable: true },
                { key: "Scope", value: String(f["scope"] || "All agents") },
                { key: "Events", value: String(f["events"] || "—") },
                { key: "Secret Version", value: String(f["secretVersion"] ?? 0) },
                { key: "Created", value: String(f["createdAt"] || "—") },
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content: secret
                ? "The generated signing secret below is shown once. AssemblyAI never returns it, so copy it now."
                : "The signing secret is write-only: AssemblyAI only reports its version. Set a new one from Edit to rotate it.",
            },
            ...(secret
              ? [
                  {
                    kind: "text" as const,
                    content: secret,
                    variant: "mono" as const,
                    copyable: true,
                  },
                ]
              : []),
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderModel(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: `LLM Gateway model · ${String(f["creator"] || "unknown creator")}`,
      status: {
        kind: "status-dot",
        status: f["retirementDate"] ? "degraded" : "healthy",
        label: f["retirementDate"] ? `Retires ${String(f["retirementDate"])}` : "Available",
      },
      sections: [
        {
          kind: "section",
          title: "Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Model ID", value: String(f["modelId"] ?? ""), copyable: true },
                { key: "Creator", value: String(f["creator"] || "—") },
                { key: "Context Length", value: Number(f["contextLength"] ?? 0).toLocaleString() },
                {
                  key: "Max Completion Tokens",
                  value: Number(f["maxCompletionTokens"] ?? 0)
                    ? Number(f["maxCompletionTokens"]).toLocaleString()
                    : "—",
                },
                { key: "Regions", value: String(f["regions"] || "—") },
                { key: "Parameters", value: String(f["supportedParameters"] || "—") },
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
                { key: "Prompt", value: perMillion(num(f["promptPrice"])) },
                { key: "Completion", value: perMillion(num(f["completionPrice"])) },
                ...(num(f["cacheReadPrice"])
                  ? [{ key: "Cache Read", value: perMillion(num(f["cacheReadPrice"])) }]
                  : []),
                ...(num(f["regionalIncreasePercent"])
                  ? [
                      {
                        key: "Regional Surcharge",
                        value: `${(Number(f["regionalIncreasePercent"]) * 100).toFixed(0)}%`,
                      },
                    ]
                  : []),
              ],
            },
            {
              kind: "text",
              variant: "muted",
              content:
                "List prices in USD per million tokens from the LLM Gateway catalogue. Use the model ID as `model` on the gateway's chat completions endpoint.",
            },
          ],
        },
      ],
    };
  }
}

/** The create form's events picker submits a JSON array; tolerate a CSV too. */
function parseEvents(raw: string | undefined): string[] {
  if (!raw) return [];
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    values = raw.split(",");
  }
  const list = Array.isArray(values) ? values.map((v) => String(v).trim()) : [];
  return list.filter((v) => WEBHOOK_EVENTS.some((e) => e.id === v));
}
