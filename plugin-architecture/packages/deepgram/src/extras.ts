import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf, jsonRestFetch } from "@infrawrench/plugin-base";

/**
 * The project-scoped Deepgram surfaces added after the original plugin:
 * Voice Agent configurations and variables, purchase orders, self-hosted
 * distribution credentials, and the per-request log behind the project's Logs
 * tab. Kept out of `client.ts` so that file stays about keys, members and
 * speech.
 *
 * Verified 2026-10-03 against https://developers.deepgram.com/reference:
 * voice-agent/agent-configurations/*, voice-agent/agent-variables/*,
 * voice-agent/think-models, manage/billing/purchases/get,
 * self-hosted/distribution-credentials/* and manage/requests/list.
 */

export const AGENT_CONFIG_TYPE = "agent-config";
export const AGENT_VARIABLE_TYPE = "agent-variable";
export const PURCHASE_TYPE = "purchase";
export const DISTRIBUTION_CREDENTIAL_TYPE = "distribution-credential";

export const EXTRA_TYPES = new Set([
  AGENT_CONFIG_TYPE,
  AGENT_VARIABLE_TYPE,
  PURCHASE_TYPE,
  DISTRIBUTION_CREDENTIAL_TYPE,
]);

const BASE_URL = "https://api.deepgram.com";
/** The Voice Agent API's own host, where the managed think-model list lives. */
const AGENT_HOST = "https://agent.deepgram.com";

/** `GET /requests` caps `limit` at 1000. */
const MAX_REQUEST_LINES = 1000;
const DEFAULT_REQUEST_LINES = 200;

/**
 * The Logs tab's "container" dropdown, reused as a filter: each entry maps
 * onto one of the documented `status` / `endpoint` query parameters.
 */
const REQUEST_FILTERS: Array<{ id: string; params: Record<string, string> }> = [
  { id: "all requests", params: {} },
  { id: "failed", params: { status: "failed" } },
  { id: "listen", params: { endpoint: "listen" } },
  { id: "speak", params: { endpoint: "speak" } },
  { id: "agent", params: { endpoint: "agent" } },
  { id: "read", params: { endpoint: "read" } },
];

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface AgentProvider {
  type?: string;
  model?: string;
  version?: string;
}

/** The `agent` block of a Settings message, as stored on a configuration. */
interface AgentBlock {
  greeting?: string;
  listen?: { provider?: AgentProvider };
  think?: { provider?: AgentProvider; prompt?: string; functions?: unknown[] };
  speak?: { provider?: AgentProvider } | Array<{ provider?: AgentProvider }>;
}

interface AgentConfiguration {
  agent_id: string;
  /** Returned as an object; the create body sends it as a JSON string. */
  config?: AgentBlock | string;
  metadata?: Record<string, string> | null;
  created_at?: string;
  updated_at?: string;
}

interface AgentVariable {
  variable_id: string;
  key?: string;
  value?: unknown;
  created_at?: string;
  updated_at?: string;
}

interface ThinkModel {
  id: string;
  name?: string;
  provider?: unknown;
}

interface PurchaseOrder {
  order_id: string;
  expiration?: string;
  created?: string;
  amount?: number;
  units?: string;
  order_type?: string;
}

interface DistributionCredentialEntry {
  member?: { member_id?: string; email?: string };
  distribution_credentials: {
    distribution_credentials_id: string;
    provider?: string;
    scopes?: string[];
    created?: string;
    comment?: string;
  };
}

interface ProjectRequest {
  request_id?: string;
  created?: string;
  path?: string;
  api_key_id?: string;
  code?: number;
  deployment?: string;
  response?: {
    code?: number;
    completed?: string;
    deployment?: string;
    details?: {
      duration?: number;
      method?: string;
      usd?: number;
      tier?: string;
      total_audio?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitChild(resourceId: string): { projectId: string; childId: string } {
  const external = externalIdOf(resourceId);
  const slash = external.indexOf("/");
  if (slash < 0) return { projectId: external, childId: "" };
  return { projectId: external.slice(0, slash), childId: external.slice(slash + 1) };
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

/** `key=value` pairs, comma separated: how metadata is shown and edited. */
export function formatLabels(metadata: Record<string, string> | null | undefined): string {
  return Object.entries(metadata ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function parseLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function providerType(provider: unknown): string {
  if (typeof provider === "string") return provider;
  if (provider && typeof provider === "object" && "type" in provider) {
    return String((provider as { type?: unknown }).type ?? "");
  }
  return "";
}

function agentBlock(config: AgentConfiguration["config"]): AgentBlock {
  if (!config) return {};
  if (typeof config === "string") {
    try {
      return JSON.parse(config) as AgentBlock;
    } catch {
      return {};
    }
  }
  return config;
}

function describeProvider(provider: AgentProvider | undefined): string {
  if (!provider) return "";
  return [provider.type, provider.model].filter(Boolean).join(" · ");
}

/** Variable values are any JSON; show strings bare and everything else as JSON. */
function showValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/** What the user typed, as JSON when it parses and as a string when it does not. */
function readValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/** Variables must be named `DG_<NAME>`; accept the bare name too. */
export function variableKey(raw: string): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_");
  if (!cleaned) return "";
  return cleaned.startsWith("DG_") ? cleaned : `DG_${cleaned}`;
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export interface ExtrasDeps {
  apiKey: string;
  caCert: string;
  services: HostServices | undefined;
}

export interface CatalogueOption {
  id: string;
  label: string;
}

export class DeepgramExtras {
  constructor(private readonly deps: ExtrasDeps) {}

  private request<T>(url: string, path: string, options?: RequestInit): Promise<T> {
    const http = this.deps.services?.http;
    return jsonRestFetch<T>({
      vendor: "Deepgram",
      url,
      errorPath: path,
      headers: { Authorization: `Token ${this.deps.apiKey}`, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.deps.caCert ? { caCert: this.deps.caCert } : {}),
      ...(http ? { http } : {}),
    });
  }

  private api<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>(`${BASE_URL}${path}`, path, options);
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listForProject(
    typeId: string,
    accountId: string,
    projectId: string,
  ): Promise<ResourceInstance[]> {
    const p = enc(projectId);
    switch (typeId) {
      case AGENT_CONFIG_TYPE: {
        const data = await this.api<{ agents?: AgentConfiguration[] }>(`/v1/projects/${p}/agents`);
        return (data.agents ?? []).map((a) => this.mapAgent(accountId, projectId, a));
      }
      case AGENT_VARIABLE_TYPE: {
        const data = await this.api<{ variables?: AgentVariable[] }>(
          `/v1/projects/${p}/agent-variables`,
        );
        return (data.variables ?? []).map((v) => this.mapVariable(accountId, projectId, v));
      }
      case PURCHASE_TYPE: {
        const data = await this.api<{ orders?: PurchaseOrder[] }>(
          `/v1/projects/${p}/purchases?limit=1000`,
        );
        return (data.orders ?? []).map((o) => this.mapPurchase(accountId, projectId, o));
      }
      case DISTRIBUTION_CREDENTIAL_TYPE: {
        const data = await this.api<{ distribution_credentials?: DistributionCredentialEntry[] }>(
          `/v1/projects/${p}/self-hosted/distribution/credentials`,
        );
        return (data.distribution_credentials ?? []).map((c) =>
          this.mapCredential(accountId, projectId, c),
        );
      }
      default:
        throw new Error(`Deepgram plugin: unknown resource type "${typeId}"`);
    }
  }

  async get(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance> {
    const { projectId, childId } = splitChild(resourceId);
    const p = enc(projectId);
    if (typeId === AGENT_CONFIG_TYPE) {
      const agent = await this.api<AgentConfiguration>(`/v1/projects/${p}/agents/${enc(childId)}`);
      return this.mapAgent(accountId, projectId, agent);
    }
    if (typeId === AGENT_VARIABLE_TYPE) {
      const variable = await this.api<AgentVariable>(
        `/v1/projects/${p}/agent-variables/${enc(childId)}`,
      );
      return this.mapVariable(accountId, projectId, variable);
    }
    if (typeId === DISTRIBUTION_CREDENTIAL_TYPE) {
      const credential = await this.api<DistributionCredentialEntry>(
        `/v1/projects/${p}/self-hosted/distribution/credentials/${enc(childId)}`,
      );
      return this.mapCredential(accountId, projectId, credential);
    }
    const siblings = await this.listForProject(typeId, accountId, projectId);
    const found = siblings.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Deepgram plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private base(
    accountId: string,
    projectId: string,
    typeId: string,
    childId: string,
    displayName: string,
    created: string | undefined,
    updated?: string,
  ): Omit<ResourceInstance, "fields" | "resolvedOutputs"> {
    const now = new Date().toISOString();
    const externalId = `${projectId}/${childId}`;
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "deepgram",
      resourceTypeId: typeId,
      accountId,
      displayName,
      secretStates: [],
      externalId,
      parentResourceId: `${accountId}:project:${projectId}`,
      createdAt: created ?? now,
      updatedAt: updated ?? created ?? now,
    };
  }

  private mapAgent(
    accountId: string,
    projectId: string,
    agent: AgentConfiguration,
  ): ResourceInstance {
    const block = agentBlock(agent.config);
    const speak = Array.isArray(block.speak) ? block.speak[0] : block.speak;
    const labels = agent.metadata ?? {};
    const name = labels["name"] || labels["Name"] || agent.agent_id;
    return {
      ...this.base(
        accountId,
        projectId,
        AGENT_CONFIG_TYPE,
        agent.agent_id,
        name,
        agent.created_at,
        agent.updated_at,
      ),
      fields: {
        agentId: agent.agent_id,
        labels: formatLabels(labels),
        listen: describeProvider(block.listen?.provider),
        think: describeProvider(block.think?.provider),
        speak: describeProvider(speak?.provider),
        greeting: block.greeting ?? "",
        prompt: block.think?.prompt ?? "",
        functionCount: block.think?.functions?.length ?? 0,
        createdAt: agent.created_at ?? "",
        updatedAt: agent.updated_at ?? "",
      },
      resolvedOutputs: {
        agentId: agent.agent_id,
        __config__: JSON.stringify(block, null, 2),
      },
    };
  }

  private mapVariable(
    accountId: string,
    projectId: string,
    variable: AgentVariable,
  ): ResourceInstance {
    const key = variable.key ?? variable.variable_id;
    return {
      ...this.base(
        accountId,
        projectId,
        AGENT_VARIABLE_TYPE,
        variable.variable_id,
        key,
        variable.created_at,
        variable.updated_at,
      ),
      fields: {
        key,
        value: showValue(variable.value),
        variableId: variable.variable_id,
        createdAt: variable.created_at ?? "",
        updatedAt: variable.updated_at ?? "",
      },
      resolvedOutputs: { variableId: variable.variable_id, key },
    };
  }

  private mapPurchase(
    accountId: string,
    projectId: string,
    order: PurchaseOrder,
  ): ResourceInstance {
    const amount = typeof order.amount === "number" ? order.amount : 0;
    const units = order.units ?? "";
    return {
      ...this.base(
        accountId,
        projectId,
        PURCHASE_TYPE,
        order.order_id,
        `${amount.toFixed(2)} ${units.toUpperCase()} ${order.order_type ?? ""}`.trim(),
        order.created,
      ),
      fields: {
        orderId: order.order_id,
        amount,
        units,
        orderType: order.order_type ?? "",
        created: order.created ?? "",
        expiration: order.expiration ?? "",
      },
      resolvedOutputs: { orderId: order.order_id, amount: String(amount) },
    };
  }

  private mapCredential(
    accountId: string,
    projectId: string,
    entry: DistributionCredentialEntry,
  ): ResourceInstance {
    const cred = entry.distribution_credentials;
    return {
      ...this.base(
        accountId,
        projectId,
        DISTRIBUTION_CREDENTIAL_TYPE,
        cred.distribution_credentials_id,
        cred.comment || cred.distribution_credentials_id,
        cred.created,
      ),
      fields: {
        credentialId: cred.distribution_credentials_id,
        comment: cred.comment ?? "",
        provider: cred.provider ?? "",
        scopes: (cred.scopes ?? []).join(", "),
        memberEmail: entry.member?.email ?? "",
        created: cred.created ?? "",
      },
      resolvedOutputs: { credentialId: cred.distribution_credentials_id },
    };
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  /** `GET https://agent.deepgram.com/v1/agent/settings/think/models`. */
  async thinkModels(): Promise<CatalogueOption[]> {
    const data = await this.request<{ models?: ThinkModel[] }>(
      `${AGENT_HOST}/v1/agent/settings/think/models`,
      "/v1/agent/settings/think/models",
    );
    return (data.models ?? [])
      .map((m) => {
        const provider = providerType(m.provider);
        return provider
          ? { id: `${provider}::${m.id}`, label: `${m.name ?? m.id} (${provider})` }
          : undefined;
      })
      .filter((m): m is CatalogueOption => m !== undefined);
  }

  async createConfig(
    typeId: string,
    catalogue: { stt: CatalogueOption[]; tts: CatalogueOption[] },
  ): Promise<CreateResourceConfig> {
    if (typeId === AGENT_CONFIG_TYPE) {
      const think = await this.thinkModels().catch(() => [] as CatalogueOption[]);
      const listen = [
        { id: "flux-general-en", label: "Flux (English, conversational turn-taking)" },
        ...catalogue.stt.filter((m) => m.id !== "flux-general-en"),
      ];
      const preferredThink = think.find((m) => m.id === "open_ai::gpt-4o-mini") ?? think[0];
      const preferredVoice =
        catalogue.tts.find((v) => v.id === "aura-2-thalia-en") ?? catalogue.tts[0];
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            description: "Stored as the configuration's `name` label.",
          },
          {
            key: "listenModel",
            label: "Speech-to-Text Model",
            kind: "select",
            required: true,
            options: listen,
            defaultValue: "flux-general-en",
          },
          {
            key: "thinkModel",
            label: "LLM",
            kind: "select",
            required: true,
            options: think,
            ...(preferredThink ? { defaultValue: preferredThink.id } : {}),
            description: "Deepgram-managed models. Bring-your-own LLMs go in the advanced block.",
          },
          {
            key: "prompt",
            label: "Prompt",
            kind: "text",
            multiline: true,
            required: true,
            description: "System prompt for the agent (up to 25,000 characters on managed LLMs).",
          },
          {
            key: "speakVoice",
            label: "Voice",
            kind: "select",
            required: true,
            options: catalogue.tts,
            ...(preferredVoice ? { defaultValue: preferredVoice.id } : {}),
          },
          {
            key: "greeting",
            label: "Greeting",
            kind: "text",
            required: false,
            description: "What the agent says first. Leave blank to wait for the caller.",
          },
          {
            key: "labels",
            label: "Labels",
            kind: "text",
            required: false,
            placeholder: "team=support, env=prod",
            description: "Extra metadata as comma-separated key=value pairs.",
          },
          {
            key: "configJson",
            label: "Advanced: Agent Block (JSON)",
            kind: "code",
            required: false,
            description:
              "Optional. A full `agent` block from a Settings message; when set it replaces the fields above, so functions, custom LLM endpoints and other providers can be stored too.",
          },
        ],
      };
    }

    if (typeId === AGENT_VARIABLE_TYPE) {
      return {
        fields: [
          {
            key: "key",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "SUPPORT_PHONE",
            description:
              "Referenced from a configuration as DG_<NAME>; the DG_ prefix is added for you.",
          },
          {
            key: "value",
            label: "Value",
            kind: "text",
            multiline: true,
            required: true,
            description: "Plain text, or any JSON value (object, array, number) to substitute.",
          },
        ],
      };
    }

    throw new Error(`Deepgram plugin: no create config for type "${typeId}"`);
  }

  async create(
    typeId: string,
    accountId: string,
    projectId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const p = enc(projectId);

    if (typeId === AGENT_CONFIG_TYPE) {
      const metadata = parseLabels(fields["labels"]);
      const name = (fields["name"] ?? "").trim();
      if (name) metadata["name"] = name;
      let config: string;
      const advanced = (fields["configJson"] ?? "").trim();
      if (advanced) {
        try {
          const parsed = JSON.parse(advanced) as Record<string, unknown>;
          // Accept a whole Settings message too, and keep only its agent block.
          config = JSON.stringify(
            parsed["agent"] && typeof parsed["agent"] === "object" ? parsed["agent"] : parsed,
          );
        } catch {
          throw new Error("Deepgram plugin: the advanced agent block is not valid JSON");
        }
      } else {
        const [thinkType, thinkModel] = (fields["thinkModel"] ?? "").split("::");
        const listenModel = fields["listenModel"] || "flux-general-en";
        const prompt = (fields["prompt"] ?? "").trim();
        if (!thinkType || !thinkModel) throw new Error("Deepgram plugin: pick an LLM");
        if (!prompt) throw new Error("Deepgram plugin: a prompt is required");
        const block: Record<string, unknown> = {
          listen: {
            provider: {
              type: "deepgram",
              model: listenModel,
              // Flux is the v2 listen provider; everything else is v1.
              ...(listenModel.startsWith("flux") ? { version: "v2" } : {}),
            },
          },
          think: { provider: { type: thinkType, model: thinkModel }, prompt },
          speak: {
            provider: { type: "deepgram", model: fields["speakVoice"] || "aura-2-thalia-en" },
          },
        };
        const greeting = (fields["greeting"] ?? "").trim();
        if (greeting) block["greeting"] = greeting;
        config = JSON.stringify(block);
      }
      const created = await this.api<AgentConfiguration>(`/v1/projects/${p}/agents`, {
        method: "POST",
        body: JSON.stringify({
          config,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        }),
      });
      return this.mapAgent(accountId, projectId, {
        ...created,
        ...(created.metadata ? {} : { metadata }),
      });
    }

    if (typeId === AGENT_VARIABLE_TYPE) {
      const key = variableKey(fields["key"] ?? "");
      if (!key || key === "DG_") throw new Error("Deepgram plugin: a variable name is required");
      const created = await this.api<AgentVariable>(`/v1/projects/${p}/agent-variables`, {
        method: "POST",
        body: JSON.stringify({ key, value: readValue(fields["value"] ?? "") }),
      });
      return this.mapVariable(accountId, projectId, created);
    }

    throw new Error(`Deepgram plugin: cannot create type "${typeId}"`);
  }

  async update(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { projectId, childId } = splitChild(resourceId);
    const p = enc(projectId);

    if (typeId === AGENT_CONFIG_TYPE) {
      // `PUT /agents/{id}` replaces the metadata; the config is immutable.
      if (fields["labels"] === undefined) return this.get(typeId, resourceId, accountId);
      const metadata = parseLabels(fields["labels"]);
      const updated = await this.api<AgentConfiguration>(
        `/v1/projects/${p}/agents/${enc(childId)}`,
        { method: "PUT", body: JSON.stringify({ metadata }) },
      );
      return this.mapAgent(accountId, projectId, updated);
    }

    if (typeId === AGENT_VARIABLE_TYPE) {
      // `PATCH /agent-variables/{id}` takes only the new value.
      if (fields["value"] === undefined) return this.get(typeId, resourceId, accountId);
      const updated = await this.api<AgentVariable>(
        `/v1/projects/${p}/agent-variables/${enc(childId)}`,
        { method: "PATCH", body: JSON.stringify({ value: readValue(fields["value"]) }) },
      );
      return this.mapVariable(accountId, projectId, updated);
    }

    throw new Error(`Deepgram plugin: cannot update type "${typeId}"`);
  }

  async remove(typeId: string, resourceId: string): Promise<void> {
    const { projectId, childId } = splitChild(resourceId);
    const p = enc(projectId);
    const c = enc(childId);
    const path =
      typeId === AGENT_CONFIG_TYPE
        ? `/v1/projects/${p}/agents/${c}`
        : typeId === AGENT_VARIABLE_TYPE
          ? `/v1/projects/${p}/agent-variables/${c}`
          : typeId === DISTRIBUTION_CREDENTIAL_TYPE
            ? `/v1/projects/${p}/self-hosted/distribution/credentials/${c}`
            : "";
    if (!path) throw new Error(`Deepgram plugin: cannot delete type "${typeId}"`);
    await this.api<unknown>(path, { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Request log
  // -------------------------------------------------------------------------

  /**
   * `GET /v1/projects/{id}/requests`, one line per request, oldest first. The
   * Logs tab's container dropdown picks a documented filter (failed only, or
   * one endpoint) rather than a container.
   */
  async requestLog(projectId: string, params: LogsFetchParams): Promise<LogsFetchResult> {
    const filter = REQUEST_FILTERS.find((f) => f.id === params.container) ?? REQUEST_FILTERS[0]!;
    const limit = Math.min(
      MAX_REQUEST_LINES,
      Math.max(
        1,
        params.tailLines && params.tailLines > 0 ? params.tailLines : DEFAULT_REQUEST_LINES,
      ),
    );
    const query = new URLSearchParams({ limit: String(limit), page: "0", ...filter.params });
    const data = await this.api<{ requests?: ProjectRequest[] }>(
      `/v1/projects/${enc(projectId)}/requests?${query.toString()}`,
    );
    const rows = [...(data.requests ?? [])].sort((a, b) =>
      String(a.created ?? "").localeCompare(String(b.created ?? "")),
    );
    const lines = rows.map((r) => {
      const details = r.response?.details;
      const bits = [
        r.created ?? "",
        String(r.response?.code ?? r.code ?? "-"),
        details?.method ?? "",
        r.path ?? "",
        r.response?.deployment ?? r.deployment ?? "",
        typeof details?.duration === "number" ? `${details.duration.toFixed(1)}s audio` : "",
        typeof details?.usd === "number" ? `$${details.usd.toFixed(4)}` : "",
        r.request_id ? `request=${r.request_id}` : "",
        r.api_key_id ? `key=${r.api_key_id}` : "",
      ];
      return bits.filter(Boolean).join("  ");
    });
    return {
      text: lines.length > 0 ? `${lines.join("\n")}\n` : "No requests match this filter.\n",
      containers: REQUEST_FILTERS.map((f) => f.id),
      activeContainer: filter.id,
    };
  }

  // -------------------------------------------------------------------------
  // Stats and rendering
  // -------------------------------------------------------------------------

  stats(resource: ResourceInstance): DashboardStat[] {
    const f = resource.fields;
    switch (resource.resourceTypeId) {
      case AGENT_CONFIG_TYPE:
        return [
          { label: "Listen", value: String(f["listen"] || "—") },
          { label: "Think", value: String(f["think"] || "—") },
          { label: "Speak", value: String(f["speak"] || "—") },
        ];
      case AGENT_VARIABLE_TYPE:
        return [
          { label: "Name", value: String(f["key"] ?? "") },
          { label: "Updated", value: String(f["updatedAt"] || "—") },
        ];
      case PURCHASE_TYPE:
        return [
          {
            label: "Amount",
            value: `${Number(f["amount"] ?? 0).toFixed(2)} ${String(f["units"] ?? "").toUpperCase()}`,
          },
          { label: "Type", value: String(f["orderType"] || "—") },
          { label: "Expires", value: String(f["expiration"] || "Never") },
        ];
      case DISTRIBUTION_CREDENTIAL_TYPE:
        return [
          { label: "Provider", value: String(f["provider"] || "—") },
          { label: "Scopes", value: String(f["scopes"] || "—") },
        ];
      default:
        return [];
    }
  }

  render(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const kv = (items: Array<[string, unknown, boolean?]>) => ({
      kind: "key-value-list" as const,
      items: items
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value, copyable]) => ({
          key,
          value: String(value),
          ...(copyable ? { copyable: true } : {}),
        })),
    });

    switch (resource.resourceTypeId) {
      case AGENT_CONFIG_TYPE: {
        const config = resource.resolvedOutputs["__config__"] ?? "";
        const sections: SectionNode[] = [
          {
            kind: "section",
            title: "Agent",
            children: [
              kv([
                ["Agent ID", f["agentId"], true],
                ["Listen", f["listen"]],
                ["Think", f["think"]],
                ["Speak", f["speak"]],
                ["Greeting", f["greeting"]],
                ["Functions", f["functionCount"]],
                ["Labels", f["labels"] || "None"],
                ["Created", f["createdAt"]],
                ["Updated", f["updatedAt"]],
              ]),
              {
                kind: "text",
                variant: "muted",
                content:
                  "Send this agent_id in a Settings message instead of the full agent block. Only the labels can be edited: Deepgram treats the configuration itself as immutable, so changing it means creating a new one, moving sessions over, and deleting this one.",
              },
            ],
          },
          ...(f["prompt"]
            ? [
                {
                  kind: "section" as const,
                  title: "Prompt",
                  children: [
                    { kind: "text" as const, content: String(f["prompt"]), copyable: true },
                  ],
                },
              ]
            : []),
          ...(config
            ? [
                {
                  kind: "section" as const,
                  title: "Agent Block",
                  children: [
                    {
                      kind: "text" as const,
                      content: config,
                      variant: "mono" as const,
                      copyable: true,
                    },
                  ],
                },
              ]
            : []),
        ];
        return {
          title: resource.displayName,
          subtitle: "Deepgram Voice Agent configuration",
          status: { kind: "status-dot", status: "healthy" },
          sections,
        };
      }
      case AGENT_VARIABLE_TYPE:
        return {
          title: resource.displayName,
          subtitle: "Deepgram Voice Agent variable",
          status: { kind: "status-dot", status: "healthy" },
          sections: [
            {
              kind: "section",
              title: "Variable",
              children: [
                kv([
                  ["Name", f["key"], true],
                  ["Variable ID", f["variableId"], true],
                  ["Created", f["createdAt"]],
                  ["Updated", f["updatedAt"]],
                ]),
                {
                  kind: "text",
                  content: String(f["value"] ?? ""),
                  variant: "mono",
                  copyable: true,
                },
                {
                  kind: "text",
                  variant: "muted",
                  content:
                    "Reference it from an agent configuration by name; Deepgram substitutes the value when a session starts. Configurations are listed with their placeholders, not the substituted values.",
                },
              ],
            },
          ],
        };
      case PURCHASE_TYPE:
        return {
          title: resource.displayName,
          subtitle: "Deepgram purchase order",
          status: { kind: "status-dot", status: "info", label: String(f["orderType"] || "order") },
          sections: [
            {
              kind: "section",
              title: "Order",
              children: [
                kv([
                  ["Order ID", f["orderId"], true],
                  [
                    "Amount",
                    `${Number(f["amount"] ?? 0).toFixed(2)} ${String(f["units"] ?? "").toUpperCase()}`,
                  ],
                  ["Type", f["orderType"]],
                  ["Created", f["created"]],
                  ["Expires", f["expiration"] || "Never"],
                ]),
              ],
            },
          ],
        };
      default:
        return {
          title: resource.displayName,
          subtitle: "Deepgram self-hosted distribution credentials",
          status: { kind: "status-dot", status: "healthy", label: String(f["provider"] || "quay") },
          sections: [
            {
              kind: "section",
              title: "Credentials",
              children: [
                kv([
                  ["Credential ID", f["credentialId"], true],
                  ["Comment", f["comment"]],
                  ["Provider", f["provider"]],
                  ["Scopes", f["scopes"]],
                  ["Created by", f["memberEmail"]],
                  ["Created", f["created"]],
                ]),
                {
                  kind: "text",
                  variant: "muted",
                  content:
                    "Container registry credentials for pulling Deepgram self-hosted images. The username and secret are only shown when they are created in the Deepgram Console; deleting revokes them immediately.",
                },
              ],
            },
          ],
        };
    }
  }

  sidebar(resource: ResourceInstance): SidebarItemSchema {
    const f = resource.fields;
    const label =
      resource.resourceTypeId === AGENT_CONFIG_TYPE
        ? "Agent"
        : resource.resourceTypeId === AGENT_VARIABLE_TYPE
          ? "Variable"
          : resource.resourceTypeId === PURCHASE_TYPE
            ? String(f["orderType"] || "Order")
            : "Self-hosted";
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "info", label },
    };
  }
}
