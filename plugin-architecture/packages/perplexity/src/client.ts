import type {
  ActionNode,
  ChatMessage,
  ChatStreamEvent,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  HttpHostServices,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, jsonRestFetch, streamOpenAiSseChat } from "@infrawrench/plugin-base";

/** https://docs.perplexity.ai/openapi.json (and openapi-gateway-chat.json), Oct 2026. */
export const API_BASE = "https://api.perplexity.ai";
const CONSOLE_URL = "https://console.perplexity.ai/project/settings";

/**
 * Sonar models. `POST /v1/sonar` has no listing endpoint: these are the
 * `model` enum of the Sonar request schema in the official spec.
 */
export const SONAR_MODELS: Array<{ id: string; description: string }> = [
  { id: "sonar", description: "Lightweight, low-cost search-grounded answers" },
  { id: "sonar-pro", description: "Deeper search with more citations, for complex questions" },
  { id: "sonar-reasoning-pro", description: "Multi-step reasoning with search" },
  {
    id: "sonar-deep-research",
    description: "Long-running research reports (best run asynchronously)",
  },
];

interface ListedModel {
  id?: string;
  created?: number;
  owned_by?: string;
  pricing?: {
    input?: number;
    output?: number;
    cache_write?: number;
    cache_read?: number;
    unit?: string;
  };
}

interface AsyncRequest {
  id?: string;
  model?: string;
  status?: string;
  created_at?: number;
  started_at?: number | null;
  completed_at?: number | null;
  failed_at?: number | null;
  error_message?: string | null;
  response?: {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
    search_results?: Array<{ title?: string; url?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: { total_cost?: number } };
  } | null;
}

interface Skill {
  skill_id?: string;
  name?: string;
  description?: string;
  revision?: string;
  created_at?: string;
  updated_at?: string;
}

function s(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function iso(seconds: number | null | undefined): string {
  return typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : "";
}

function externalIdOf(resourceId: string, accountId: string, typeId: string): string {
  const prefix = `${accountId}:${typeId}:`;
  if (resourceId.startsWith(prefix)) return resourceId.slice(prefix.length);
  const at = resourceId.indexOf(`:${typeId}:`);
  return at >= 0 ? resourceId.slice(at + typeId.length + 2) : resourceId;
}

function withStatus(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const m = /API error (\d{3})\b/.exec(err.message);
  if (!m) return err;
  const status = Number(m[1]);
  const hint =
    status === 401
      ? " Check the API key under API Keys in the Perplexity API console."
      : status === 402
        ? " The project is out of credits: top up on the Billing page."
        : "";
  return Object.assign(new Error(`${err.message}${hint}`), { status });
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function kv(items: Array<[string, unknown]>, copyable: string[] = []): SchemaNode {
  return {
    kind: "key-value-list",
    items: items.map(([key, value]) => ({
      key,
      value: s(value) || "—",
      ...(copyable.includes(key) && s(value) ? { copyable: true } : {}),
    })),
  };
}

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

export function asyncStatus(status: string): ResourceStatus {
  switch (status) {
    case "COMPLETED":
      return "healthy";
    case "FAILED":
      return "error";
    case "CREATED":
    case "IN_PROGRESS":
      return "provisioning";
    default:
      return "info";
  }
}

/** Pull the assistant text out of an Agent API `output[]`. */
export function agentOutputText(output: unknown): string {
  const parts: string[] = [];
  for (const item of Array.isArray(output) ? output : []) {
    const it = item as { type?: string; content?: Array<{ type?: string; text?: string }> };
    if (it.type !== "message") continue;
    for (const c of it.content ?? []) if (typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("");
}

/**
 * Perplexity API platform: Sonar, Agent API and Router models with
 * Playgrounds, asynchronous Sonar requests, and Agent API skills.
 * Perplexity publishes no API-usage or billing endpoint and no way to list
 * API keys.
 */
export class PerplexityClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly http: HttpHostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Perplexity plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.http = services?.http;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "Perplexity",
        url: `${API_BASE}${path}`,
        errorPath: path.split("?")[0] ?? path,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        ...(init ? { init } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
        ...(this.http ? { http: this.http } : {}),
      });
    } catch (err) {
      throw withStatus(err);
    }
  }

  private instance(
    accountId: string,
    typeId: string,
    externalId: string,
    displayName: string,
    fields: Record<string, string | number | boolean>,
    outputs: Record<string, string> = {},
  ): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "perplexity",
      resourceTypeId: typeId,
      accountId,
      displayName: displayName || externalId,
      externalId,
      fields,
      resolvedOutputs: outputs,
      secretStates: [],
      createdAt: s(fields["createdAt"]) || now,
      updatedAt: now,
    };
  }

  // ------------------------------------------------------------- listing

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "perplexity-sonar-model":
        return SONAR_MODELS.map((m) =>
          this.instance(
            accountId,
            typeId,
            m.id,
            m.id,
            { modelId: m.id, description: m.description },
            {
              modelId: m.id,
              endpoint: `${API_BASE}/v1/sonar`,
            },
          ),
        );
      case "perplexity-agent-model": {
        // GET /v1/models: models usable with POST /v1/agent.
        const res = await this.fetch<{ data?: ListedModel[] }>("/v1/models");
        return (res.data ?? [])
          .filter((m) => m.id)
          .map((m) => this.mapListed(accountId, typeId, m, "/v1/agent"));
      }
      case "perplexity-router-model": {
        // GET /router/v1/models: OpenAI-compatible router catalogue with prices per 1M tokens.
        const res = await this.fetch<{ data?: ListedModel[] }>("/router/v1/models");
        return (res.data ?? [])
          .filter((m) => m.id)
          .map((m) => this.mapListed(accountId, typeId, m, "/router/v1/chat/completions"));
      }
      case "perplexity-async-request":
        return this.listAsync(accountId);
      case "perplexity-skill":
        return this.listSkills(accountId);
      default:
        throw new Error(`Perplexity plugin: unknown resource type "${typeId}"`);
    }
  }

  private mapListed(
    accountId: string,
    typeId: string,
    m: ListedModel,
    path: string,
  ): ResourceInstance {
    const id = s(m.id);
    return this.instance(
      accountId,
      typeId,
      id,
      id,
      {
        modelId: id,
        ownedBy: s(m.owned_by),
        inputPrice: m.pricing?.input ?? "",
        outputPrice: m.pricing?.output ?? "",
        cacheReadPrice: m.pricing?.cache_read ?? "",
        cacheWritePrice: m.pricing?.cache_write ?? "",
        priceUnit: s(m.pricing?.unit),
        created: iso(m.created),
      },
      { modelId: id, endpoint: `${API_BASE}${path}` },
    );
  }

  /**
   * `GET /v1/async/sonar`. The response carries a `next_token`, but the spec
   * documents no query parameter to send it back with, so one page is read.
   */
  private async listAsync(accountId: string): Promise<ResourceInstance[]> {
    const res = await this.fetch<{ requests?: AsyncRequest[]; next_token?: string | null }>(
      "/v1/async/sonar",
    );
    return (res.requests ?? []).filter((r) => r.id).map((r) => this.mapAsync(accountId, r));
  }

  private mapAsync(accountId: string, r: AsyncRequest): ResourceInstance {
    const id = s(r.id);
    const answer = s(r.response?.choices?.[0]?.message?.content);
    return this.instance(
      accountId,
      "perplexity-async-request",
      id,
      `${s(r.model)} · ${id.slice(0, 8)}`,
      {
        requestId: id,
        model: s(r.model),
        status: s(r.status),
        createdAt: iso(r.created_at),
        startedAt: iso(r.started_at),
        completedAt: iso(r.completed_at),
        failedAt: iso(r.failed_at),
        errorMessage: s(r.error_message),
        ...(answer ? { answer } : {}),
        ...(r.response?.citations?.length ? { citations: r.response.citations.join("\n") } : {}),
        ...(typeof r.response?.usage?.cost?.total_cost === "number"
          ? { cost: r.response.usage.cost.total_cost }
          : {}),
      },
      { requestId: id },
    );
  }

  /** `GET /v1/skills?limit=200&page_token=` */
  private async listSkills(accountId: string): Promise<ResourceInstance[]> {
    const out: Skill[] = [];
    let token = "";
    for (let page = 0; page < 20; page++) {
      const res = await this.fetch<{ skills?: Skill[]; next_page_token?: string }>(
        `/v1/skills?limit=200${token ? `&page_token=${encodeURIComponent(token)}` : ""}`,
      );
      out.push(...(res.skills ?? []));
      if (!res.next_page_token) break;
      token = res.next_page_token;
    }
    return out.filter((k) => k.skill_id).map((k) => this.mapSkill(accountId, k));
  }

  private mapSkill(accountId: string, k: Skill): ResourceInstance {
    const id = s(k.skill_id);
    return this.instance(
      accountId,
      "perplexity-skill",
      id,
      k.name || id,
      {
        skillId: id,
        name: s(k.name),
        description: s(k.description),
        revision: s(k.revision),
        createdAt: s(k.created_at),
        updatedAt: s(k.updated_at),
      },
      { skillId: id },
    );
  }

  // ----------------------------------------------------------------- get

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId, accountId, typeId);
    if (typeId === "perplexity-async-request") {
      return this.mapAsync(
        accountId,
        await this.fetch<AsyncRequest>(`/v1/async/sonar/${encodeURIComponent(id)}`),
      );
    }
    if (typeId === "perplexity-skill") {
      return this.mapSkill(
        accountId,
        await this.fetch<Skill>(`/v1/skills/${encodeURIComponent(id)}`),
      );
    }
    if (typeId === "perplexity-router-model") {
      // Router ids contain a slash (perplexity/kimi-k3); the full id goes in the path.
      return this.mapListed(
        accountId,
        typeId,
        await this.fetch<ListedModel>(`/router/v1/models/${id}`),
        "/router/v1/chat/completions",
      );
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === id);
    if (!found)
      throw Object.assign(new Error(`Perplexity plugin: ${typeId}/${id} not found`), {
        status: 404,
      });
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const r = await this.getResource(typeId, resourceId, accountId);
    return s(r.resolvedOutputs[outputKey] ?? r.fields[outputKey]);
  }

  /** A skill's revision history: `GET /v1/skills/{id}/revisions`. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "perplexity-skill") return resource;
    const res = await this.fetch<{ revisions?: Array<{ revision?: string; created_at?: string }> }>(
      `/v1/skills/${encodeURIComponent(resource.externalId ?? "")}/revisions`,
    ).catch(() => ({ revisions: [] }));
    return {
      ...resource,
      resolvedOutputs: {
        ...resource.resolvedOutputs,
        __revisions__: JSON.stringify(res.revisions ?? []),
      },
    };
  }

  // ------------------------------------------------------- create/delete

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "perplexity-async-request")
      throw new Error(`Perplexity plugin: ${typeId} cannot be created`);
    return {
      fields: [
        {
          key: "model",
          label: "Model",
          kind: "select",
          required: true,
          defaultValue: "sonar-deep-research",
          options: SONAR_MODELS.map((m) => ({ id: m.id, label: m.id, description: m.description })),
        },
        {
          key: "prompt",
          label: "Question",
          kind: "text",
          multiline: true,
          required: true,
          placeholder: "Compare the latest open-weight coding models and their licences.",
        },
        {
          key: "searchRecency",
          label: "Search Recency",
          kind: "select",
          required: false,
          defaultValue: "",
          options: [
            { id: "", label: "Any time" },
            { id: "day", label: "Past day" },
            { id: "week", label: "Past week" },
            { id: "month", label: "Past month" },
            { id: "year", label: "Past year" },
          ],
        },
      ],
    };
  }

  /** `POST /v1/async/sonar {request: {model, messages, …}}` */
  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "perplexity-async-request")
      throw new Error(`Perplexity plugin: ${typeId} cannot be created`);
    const prompt = (fields["prompt"] ?? "").trim();
    if (!prompt) throw new Error("Perplexity plugin: a question is required");
    const created = await this.fetch<AsyncRequest>("/v1/async/sonar", {
      method: "POST",
      body: JSON.stringify({
        request: {
          model: fields["model"] || "sonar-deep-research",
          messages: [{ role: "user", content: prompt }],
          ...(fields["searchRecency"] ? { search_recency_filter: fields["searchRecency"] } : {}),
        },
      }),
    });
    return this.mapAsync(accountId, created);
  }

  /** `DELETE /v1/skills/{id}?expected_revision=` guarded by the current revision. */
  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    if (typeId !== "perplexity-skill")
      throw new Error(`Perplexity plugin: ${typeId} cannot be deleted`);
    const id = externalIdOf(resourceId, accountId, typeId);
    const current = await this.fetch<Skill>(`/v1/skills/${encodeURIComponent(id)}`);
    await this.fetch(
      `/v1/skills/${encodeURIComponent(id)}?expected_revision=${encodeURIComponent(s(current.revision))}`,
      { method: "DELETE" },
    );
  }

  // ---------------------------------------------------------------- chat

  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const model = externalIdOf(resourceId, accountId, typeId);
    const turns = messages.map((m) => ({ role: m.role, content: m.content }));
    if (typeId === "perplexity-agent-model") {
      // POST /v1/agent, non-streaming: its stream is typed Responses events,
      // not chat-completion deltas, so one full reply is yielded instead.
      try {
        const res = await this.fetch<{
          output?: unknown;
          usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
          error?: { message?: string };
        }>("/v1/agent", { method: "POST", body: JSON.stringify({ model, input: turns }) });
        if (res.error?.message) {
          yield { kind: "error", message: res.error.message };
          return;
        }
        const text = agentOutputText(res.output);
        yield { kind: "delta", text };
        yield {
          kind: "done",
          message: { role: "assistant", content: text },
          ...(res.usage
            ? {
                usage: {
                  ...(res.usage.input_tokens !== undefined
                    ? { inputTokens: res.usage.input_tokens }
                    : {}),
                  ...(res.usage.output_tokens !== undefined
                    ? { outputTokens: res.usage.output_tokens }
                    : {}),
                  ...(res.usage.total_tokens !== undefined
                    ? { totalTokens: res.usage.total_tokens }
                    : {}),
                },
              }
            : {}),
        };
      } catch (err) {
        yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
      return;
    }
    const path = typeId === "perplexity-router-model" ? "/router/v1/chat/completions" : "/v1/sonar";
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ model, messages: turns, stream: true }),
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        kind: "error",
        message:
          res.status === 402
            ? "The project is out of credits. Top up on the Perplexity API console's billing page."
            : `Chat request failed (${res.status}): ${text.slice(0, 400) || res.statusText}`,
      };
      return;
    }
    yield* streamOpenAiSseChat(res.body);
  }

  // -------------------------------------------------------------- render

  renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
    const status: ResourceStatus =
      r.resourceTypeId === "perplexity-async-request"
        ? asyncStatus(s(r.fields["status"]))
        : "healthy";
    return { id: r.id, label: r.displayName || r.id, status: { kind: "status-dot", status } };
  }

  renderDetail(r: ResourceInstance): DetailViewSchema {
    const f = r.fields;
    const consoleAction: ActionNode = {
      kind: "action",
      label: "API console",
      variant: "ghost",
      action: { type: "open-url", url: CONSOLE_URL },
    };
    switch (r.resourceTypeId) {
      case "perplexity-sonar-model":
      case "perplexity-agent-model":
      case "perplexity-router-model": {
        const id = s(f["modelId"]) || (r.externalId ?? "");
        const label =
          r.resourceTypeId === "perplexity-sonar-model"
            ? "Sonar Model"
            : r.resourceTypeId === "perplexity-agent-model"
              ? "Agent API Model"
              : "Router Model";
        const unit = s(f["priceUnit"]) || "per 1M tokens";
        const price = (v: unknown) => (s(v) !== "" ? `$${s(v)} ${unit.replace(/_/g, " ")}` : "");
        return {
          title: id,
          subtitle: joinSubtitle(`Perplexity ${label}`, s(f["ownedBy"])),
          status: { kind: "status-dot", status: "healthy", label: "Available" },
          sections: [
            section("Model", [
              kv(
                [
                  ["Model ID", id],
                  ["Owned By", f["ownedBy"]],
                  ["Description", f["description"]],
                  ["Input", price(f["inputPrice"])],
                  ["Output", price(f["outputPrice"])],
                  ["Cache Read", price(f["cacheReadPrice"])],
                  ["Cache Write", price(f["cacheWritePrice"])],
                ],
                ["Model ID"],
              ),
            ]),
            section("Endpoint", [
              {
                kind: "text",
                variant: "mono",
                copyable: true,
                content: s(r.resolvedOutputs["endpoint"]),
              },
              {
                kind: "text",
                variant: "muted",
                content:
                  "Perplexity has no usage or billing API: spend, credits and keys are in the API console. Search-grounded models also charge a per-request search fee on top of tokens.",
              },
            ]),
          ],
          headerActions: [REFRESH, consoleAction],
          chatPanel: {
            subtitle:
              r.resourceTypeId === "perplexity-agent-model"
                ? `${id} through the Agent API (replies arrive whole)`
                : `${id} on api.perplexity.ai`,
          },
        };
      }
      case "perplexity-async-request": {
        const st = s(f["status"]);
        return {
          title: r.displayName,
          subtitle: joinSubtitle("Async Sonar Request", s(f["model"])),
          status: { kind: "status-dot", status: asyncStatus(st), label: st || "unknown" },
          sections: [
            section("Request", [
              kv(
                [
                  ["Request ID", f["requestId"]],
                  ["Model", f["model"]],
                  ["Status", st],
                  ["Error", f["errorMessage"]],
                  ["Cost", s(f["cost"]) !== "" ? `$${Number(f["cost"]).toFixed(4)}` : ""],
                  ["Created", f["createdAt"]],
                  ["Started", f["startedAt"]],
                  ["Completed", f["completedAt"] || f["failedAt"]],
                ],
                ["Request ID"],
              ),
            ]),
            ...(s(f["answer"])
              ? [
                  section("Answer", [
                    { kind: "text", variant: "body", copyable: true, content: s(f["answer"]) },
                  ]),
                ]
              : []),
            ...(s(f["citations"])
              ? [
                  section("Citations", [
                    { kind: "text", variant: "mono", content: s(f["citations"]) },
                  ]),
                ]
              : []),
          ],
          headerActions: [REFRESH],
        };
      }
      case "perplexity-skill": {
        let revisions: Array<{ revision?: string; created_at?: string }> = [];
        try {
          revisions = JSON.parse(r.resolvedOutputs["__revisions__"] ?? "[]");
        } catch {
          revisions = [];
        }
        return {
          title: r.displayName,
          subtitle: "Agent API Skill",
          status: { kind: "status-dot", status: "healthy" },
          sections: [
            section("Skill", [
              kv(
                [
                  ["Skill ID", f["skillId"]],
                  ["Name", f["name"]],
                  ["Description", f["description"]],
                  ["Active Revision", f["revision"]],
                  ["Created", f["createdAt"]],
                  ["Updated", f["updatedAt"]],
                ],
                ["Skill ID"],
              ),
            ]),
            section("Revisions", [
              revisions.length
                ? {
                    kind: "table",
                    columns: [
                      { key: "revision", label: "Revision", mono: true },
                      { key: "created", label: "Created" },
                    ],
                    rows: revisions.map((v) => ({
                      cells: { revision: s(v.revision), created: s(v.created_at) },
                    })),
                  }
                : { kind: "text", variant: "muted", content: "No revision history returned." },
            ]),
          ],
          headerActions: [REFRESH],
        };
      }
      default:
        return { title: r.displayName, subtitle: "Perplexity", sections: [] };
    }
  }
}
