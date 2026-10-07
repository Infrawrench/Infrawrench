import type {
  ActionNode,
  ChatMessage,
  ChatStreamEvent,
  CreateFieldConfig,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  HttpHostServices,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { formatBytes, joinSubtitle, jsonRestFetch } from "@infrawrench/plugin-base";
import { BATCH_ENDPOINTS, VOYAGE_MODELS, type VoyageKind } from "./catalog.js";

/** Voyage API v1 (spec fragments embedded in docs.voyageai.com/reference/*.md, Oct 2026). */
export const API_BASE = "https://api.voyageai.com/v1";
const DASHBOARD = "https://dashboard.voyageai.com";

interface Batch {
  id?: string;
  endpoint?: string;
  errors?: unknown;
  input_file_id?: string;
  completion_window?: string;
  model?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  request_counts?: { total?: number; completed?: number; failed?: number };
  metadata?: Record<string, string> | null;
  created_at?: string;
  completed_at?: string | null;
  expected_completion_at?: string | null;
}

interface VoyageFile {
  id?: string;
  bytes?: number;
  created_at?: string;
  expires_at?: string;
  filename?: string;
  purpose?: string;
}

interface Page<T> {
  data?: T[];
  has_more?: boolean;
  last_id?: string;
}

function s(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
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
  const hint = status === 401 ? " Check the key on dashboard.voyageai.com under API keys." : "";
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

export function batchStatus(status: string): ResourceStatus {
  switch (status) {
    case "completed":
      return "healthy";
    case "failed":
    case "expired":
      return "error";
    case "cancelled":
    case "cancelling":
      return "degraded";
    case "validating":
    case "in_progress":
    case "finalizing":
      return "provisioning";
    default:
      return "info";
  }
}

/**
 * Playground input for a reranker: the first line is the query, each later
 * non-empty line a document.
 */
export function parseRerankInput(text: string): { query: string; documents: string[] } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { query: lines[0] ?? "", documents: lines.slice(1) };
}

/**
 * Voyage AI: the embedding, contextualized, multimodal and rerank model
 * catalogue with list prices and a test Playground, plus batches and files.
 * Voyage publishes no model-listing, usage, billing or key-management API.
 */
export class VoyageClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly http: HttpHostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Voyage plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.http = services?.http;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "Voyage AI",
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

  /** `GET /files?limit=1`: authenticated and free, unlike an embedding call. */
  async verifyCredentials(): Promise<PreflightResult> {
    try {
      await this.fetch("/files?limit=1");
      return { checks: [{ capabilityId: "api", status: "ok" }] };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        return {
          checks: [
            {
              capabilityId: "api",
              status: "missing",
              missingPermissions: [{ id: "api-key", label: "A valid Voyage AI API key" }],
              message: "Voyage AI rejected the API key.",
              helpLink: { label: "Manage API keys", url: `${DASHBOARD}/organization/api-keys` },
            },
          ],
        };
      }
      return {
        checks: [
          { capabilityId: "api", status: "unknown", message: String((err as Error).message) },
        ],
      };
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
      pluginId: "voyage",
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "voyage-model":
        return VOYAGE_MODELS.map((m) =>
          this.instance(
            accountId,
            typeId,
            m.id,
            m.id,
            {
              modelId: m.id,
              kind: m.kind,
              contextLength: m.contextLength ?? "",
              dimensions: m.dimensions ?? "",
              pricePerMillion: m.pricePerMillion,
              generation: m.generation,
              description: m.description,
            },
            { modelId: m.id, endpoint: `${API_BASE}${endpointFor(m.kind)}` },
          ),
        );
      case "voyage-batch":
        return (await this.paged<Batch>("/batches")).map((b) => this.mapBatch(accountId, b));
      case "voyage-file":
        return (await this.paged<VoyageFile>("/files")).map((f) => this.mapFile(accountId, f));
      default:
        throw new Error(`Voyage plugin: unknown resource type "${typeId}"`);
    }
  }

  /** `limit≤100` + `after=<last_id>` while `has_more`. */
  private async paged<T extends { id?: string }>(path: string): Promise<T[]> {
    const out: T[] = [];
    let after = "";
    for (let i = 0; i < 50; i++) {
      const page = await this.fetch<Page<T>>(
        `${path}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      const data = page.data ?? [];
      out.push(...data);
      if (!page.has_more || data.length === 0) break;
      after = s(page.last_id) || s(data[data.length - 1]?.id);
    }
    return out.filter((x) => x.id);
  }

  private mapBatch(accountId: string, b: Batch): ResourceInstance {
    const id = s(b.id);
    return this.instance(
      accountId,
      "voyage-batch",
      id,
      `${s(b.model)} · ${id}`,
      {
        batchId: id,
        status: s(b.status),
        endpoint: s(b.endpoint),
        model: s(b.model),
        completionWindow: s(b.completion_window),
        inputFileId: s(b.input_file_id),
        outputFileId: s(b.output_file_id),
        errorFileId: s(b.error_file_id),
        totalRequests: b.request_counts?.total ?? 0,
        completedRequests: b.request_counts?.completed ?? 0,
        failedRequests: b.request_counts?.failed ?? 0,
        errors: typeof b.errors === "string" ? b.errors : b.errors ? JSON.stringify(b.errors) : "",
        metadata: b.metadata ? JSON.stringify(b.metadata) : "",
        createdAt: s(b.created_at),
        expectedCompletionAt: s(b.expected_completion_at),
        completedAt: s(b.completed_at),
      },
      { batchId: id, outputFileId: s(b.output_file_id) },
    );
  }

  private mapFile(accountId: string, f: VoyageFile): ResourceInstance {
    const id = s(f.id);
    return this.instance(
      accountId,
      "voyage-file",
      id,
      f.filename || id,
      {
        fileId: id,
        filename: s(f.filename),
        purpose: s(f.purpose),
        bytes: f.bytes ?? 0,
        createdAt: s(f.created_at),
        expiresAt: s(f.expires_at),
      },
      { fileId: id },
    );
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId, accountId, typeId);
    if (typeId === "voyage-batch")
      return this.mapBatch(
        accountId,
        await this.fetch<Batch>(`/batches/${encodeURIComponent(id)}`),
      );
    if (typeId === "voyage-file")
      return this.mapFile(
        accountId,
        await this.fetch<VoyageFile>(`/files/${encodeURIComponent(id)}`),
      );
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === id);
    if (!found)
      throw Object.assign(new Error(`Voyage plugin: ${typeId}/${id} not found`), { status: 404 });
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

  // ------------------------------------------------------------- create

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "voyage-batch") throw new Error(`Voyage plugin: ${typeId} cannot be created`);
    const files = (await this.paged<VoyageFile>("/files").catch(() => [] as VoyageFile[])).filter(
      (f) => (f.purpose ?? "batch") === "batch",
    );
    const fileOptions = files.map((f) => ({
      id: s(f.id),
      label: f.filename || s(f.id),
      ...(f.bytes ? { description: formatBytes(f.bytes) } : {}),
    }));
    const modelField = (kind: VoyageKind, endpoint: string): CreateFieldConfig => {
      const options = VOYAGE_MODELS.filter((m) => m.kind === kind).map((m) => ({
        id: m.id,
        label: m.id,
        description: `$${m.pricePerMillion} / 1M tokens · ${m.description}`,
      }));
      return {
        key: `model:${kind}`,
        label: "Model",
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
        showWhen: { fieldKey: "endpoint", fieldValue: endpoint },
      };
    };
    return {
      fields: [
        {
          key: "inputFileId",
          label: "Input File",
          kind: "select",
          required: true,
          options: fileOptions,
          ...(fileOptions[0] ? { defaultValue: fileOptions[0].id } : {}),
          description: fileOptions.length
            ? 'A JSONL file uploaded with purpose "batch".'
            : "No batch files uploaded yet. Upload a JSONL request file to Voyage first.",
        },
        {
          key: "endpoint",
          label: "Endpoint",
          kind: "select",
          required: true,
          defaultValue: "/v1/embeddings",
          options: BATCH_ENDPOINTS.map((e) => ({ id: e.id, label: e.label })),
        },
        ...BATCH_ENDPOINTS.map((e) => modelField(e.kind, e.id)),
        {
          key: "metadata",
          label: "Metadata (optional)",
          kind: "text",
          multiline: true,
          required: false,
          placeholder: "corpus=company policies",
          description: "Up to 16 key=value lines, kept on the batch for your own tracking.",
        },
      ],
    };
  }

  /** `POST /batches {input_file_id, endpoint, completion_window: "12h", request_params: {model}}` */
  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "voyage-batch") throw new Error(`Voyage plugin: ${typeId} cannot be created`);
    const endpoint = fields["endpoint"] || "/v1/embeddings";
    const kind = BATCH_ENDPOINTS.find((e) => e.id === endpoint)?.kind ?? "embedding";
    const model = fields[`model:${kind}`] || fields["model"];
    if (!fields["inputFileId"] || !model)
      throw new Error("Voyage plugin: pick an input file and a model");
    const metadata: Record<string, string> = {};
    for (const line of (fields["metadata"] ?? "").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0)
        metadata[line.slice(0, at).trim().slice(0, 64)] = line
          .slice(at + 1)
          .trim()
          .slice(0, 512);
    }
    const created = await this.fetch<Batch>("/batches", {
      method: "POST",
      body: JSON.stringify({
        input_file_id: fields["inputFileId"],
        endpoint,
        // The only window Voyage accepts today.
        completion_window: "12h",
        request_params: { model },
        ...(Object.keys(metadata).length ? { metadata } : {}),
      }),
    });
    return this.mapBatch(accountId, created);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    if (typeId !== "voyage-file") throw new Error(`Voyage plugin: ${typeId} cannot be deleted`);
    await this.fetch(`/files/${encodeURIComponent(externalIdOf(resourceId, accountId, typeId))}`, {
      method: "DELETE",
    });
  }

  /** `POST /batches/{id}/cancel`: only from validating or in_progress. */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "voyage-batch" && actionId === "cancel") {
      await this.fetch(
        `/batches/${encodeURIComponent(externalIdOf(resourceId, accountId, typeId))}/cancel`,
        {
          method: "POST",
        },
      );
      return;
    }
    throw new Error(`Voyage plugin: unknown action "${actionId}" for ${typeId}`);
  }

  // --------------------------------------------------------- playground

  /**
   * A test bench in the chat panel: embedding models embed the latest
   * message and report the vector; rerankers treat its first line as the
   * query and the rest as documents and return them ranked.
   */
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const model = externalIdOf(resourceId, accountId, typeId);
    const meta = VOYAGE_MODELS.find((m) => m.id === model);
    const text =
      [...messages]
        .reverse()
        .find((m) => m.role === "user")
        ?.content.trim() ?? "";
    if (!text) {
      yield { kind: "error", message: "Type some text to send." };
      return;
    }
    try {
      let reply: string;
      let tokens: number | undefined;
      if (meta?.kind === "rerank") {
        const { query, documents } = parseRerankInput(text);
        if (documents.length === 0) {
          yield {
            kind: "error",
            message: "Put the query on the first line and one document per following line.",
          };
          return;
        }
        const res = await this.fetch<{
          data?: Array<{ index?: number; relevance_score?: number }>;
          usage?: { total_tokens?: number };
        }>("/rerank", { method: "POST", body: JSON.stringify({ query, documents, model }) });
        tokens = res.usage?.total_tokens;
        reply = [
          `Ranked ${documents.length} documents for "${query}":`,
          ...(res.data ?? []).map(
            (d, i) =>
              `${i + 1}. (${(d.relevance_score ?? 0).toFixed(4)}) ${documents[d.index ?? 0] ?? ""}`,
          ),
        ].join("\n");
      } else if (meta?.kind === "contextualized") {
        const res = await this.fetch<{
          data?: Array<{ data?: Array<{ embedding?: number[] }> }>;
          usage?: { total_tokens?: number };
        }>("/contextualizedembeddings", {
          method: "POST",
          body: JSON.stringify({ inputs: [text.split("\n\n")], model, input_type: "document" }),
        });
        tokens = res.usage?.total_tokens;
        const chunks = res.data?.[0]?.data ?? [];
        reply = `${chunks.length} chunk embedding${chunks.length === 1 ? "" : "s"} of ${chunks[0]?.embedding?.length ?? 0} dimensions (separate chunks with a blank line).`;
      } else if (meta?.kind === "multimodal") {
        const res = await this.fetch<{
          data?: Array<{ embedding?: number[] }>;
          usage?: { total_tokens?: number };
        }>("/multimodalembeddings", {
          method: "POST",
          body: JSON.stringify({ inputs: [{ content: [{ type: "text", text }] }], model }),
        });
        tokens = res.usage?.total_tokens;
        reply = vectorSummary(res.data?.[0]?.embedding);
      } else {
        const res = await this.fetch<{
          data?: Array<{ embedding?: number[] }>;
          usage?: { total_tokens?: number };
        }>("/embeddings", { method: "POST", body: JSON.stringify({ input: [text], model }) });
        tokens = res.usage?.total_tokens;
        reply = vectorSummary(res.data?.[0]?.embedding);
      }
      yield { kind: "delta", text: reply };
      yield {
        kind: "done",
        message: { role: "assistant", content: reply },
        ...(tokens !== undefined ? { usage: { totalTokens: tokens } } : {}),
      };
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ------------------------------------------------------------- render

  renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
    const status: ResourceStatus =
      r.resourceTypeId === "voyage-batch" ? batchStatus(s(r.fields["status"])) : "healthy";
    return { id: r.id, label: r.displayName || r.id, status: { kind: "status-dot", status } };
  }

  renderDetail(r: ResourceInstance): DetailViewSchema {
    const f = r.fields;
    switch (r.resourceTypeId) {
      case "voyage-model": {
        const id = s(f["modelId"]) || (r.externalId ?? "");
        const kind = s(f["kind"]);
        return {
          title: id,
          subtitle: joinSubtitle("Voyage Model", kind),
          status: {
            kind: "status-dot",
            status: "healthy",
            label: s(f["generation"]) === "current" ? "Current" : "Previous generation",
          },
          sections: [
            section("Model", [
              kv(
                [
                  ["Model ID", id],
                  ["Type", kind],
                  [
                    "Context Length",
                    Number(f["contextLength"])
                      ? `${Number(f["contextLength"]).toLocaleString()} tokens`
                      : "",
                  ],
                  ["Dimensions", f["dimensions"]],
                  ["Price", `$${s(f["pricePerMillion"])} / 1M tokens`],
                  ["Description", f["description"]],
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
                  "Voyage has no usage or billing API: token usage, free-token balance and spend are on the dashboard's Usage and Billing pages.",
              },
            ]),
          ],
          headerActions: [
            REFRESH,
            {
              kind: "action",
              label: "Usage dashboard",
              variant: "ghost",
              action: { type: "open-url", url: `${DASHBOARD}/usage` },
            },
          ],
          chatPanel: {
            tabLabel: "Test",
            subtitle: kind === "rerank" ? `Rerank with ${id}` : `Embed with ${id}`,
            greeting:
              kind === "rerank"
                ? "Send a query on the first line and one document per line after it; I will rank the documents."
                : kind === "contextualized"
                  ? "Send a document with chunks separated by blank lines; I will embed each chunk in context."
                  : "Send any text and I will embed it and describe the vector.",
            inputPlaceholder:
              kind === "rerank" ? "query\ndocument one\ndocument two" : "Text to embed",
          },
        };
      }
      case "voyage-batch": {
        const st = s(f["status"]);
        const cancellable = st === "validating" || st === "in_progress";
        return {
          title: r.displayName,
          subtitle: joinSubtitle("Voyage Batch", s(f["endpoint"])),
          status: { kind: "status-dot", status: batchStatus(st), label: st || "unknown" },
          sections: [
            section("Progress", [
              kv([
                ["Status", st],
                ["Model", f["model"]],
                ["Total Requests", f["totalRequests"]],
                ["Completed", f["completedRequests"]],
                ["Failed", f["failedRequests"]],
                ["Completion Window", f["completionWindow"]],
                ["Expected By", f["expectedCompletionAt"]],
                ["Metadata", f["metadata"]],
              ]),
            ]),
            section("Files", [
              kv([
                ["Input", f["inputFileId"]],
                ["Output", f["outputFileId"]],
                ["Errors", f["errorFileId"]],
              ]),
            ]),
            ...(s(f["errors"])
              ? [section("Errors", [{ kind: "text", variant: "mono", content: s(f["errors"]) }])]
              : []),
          ],
          headerActions: [
            REFRESH,
            ...(cancellable
              ? [
                  {
                    kind: "action" as const,
                    label: "Cancel batch",
                    action: {
                      type: "plugin-action" as const,
                      actionId: "cancel",
                      confirmMessage:
                        "Cancel this batch? It can stay in cancelling for up to 10 minutes.",
                      successMessage: "Batch cancellation requested.",
                    },
                  },
                ]
              : []),
          ],
        };
      }
      case "voyage-file": {
        const bytes = Number(f["bytes"] ?? 0);
        return {
          title: r.displayName,
          subtitle: joinSubtitle("Voyage File", s(f["purpose"])),
          status: { kind: "status-dot", status: "healthy" },
          sections: [
            section("File", [
              kv(
                [
                  ["File ID", f["fileId"]],
                  ["Filename", f["filename"]],
                  ["Purpose", f["purpose"]],
                  ["Size", bytes > 0 ? formatBytes(bytes) : ""],
                  ["Created", f["createdAt"]],
                  ["Expires", f["expiresAt"]],
                ],
                ["File ID"],
              ),
            ]),
          ],
          headerActions: [REFRESH],
        };
      }
      default:
        return { title: r.displayName, subtitle: "Voyage AI", sections: [] };
    }
  }
}

function endpointFor(kind: VoyageKind): string {
  return kind === "rerank"
    ? "/rerank"
    : kind === "contextualized"
      ? "/contextualizedembeddings"
      : kind === "multimodal"
        ? "/multimodalembeddings"
        : "/embeddings";
}

function vectorSummary(vector: number[] | undefined): string {
  if (!vector?.length) return "No embedding returned.";
  const norm = Math.sqrt(vector.reduce((a, v) => a + v * v, 0));
  return `${vector.length}-dimension vector, norm ${norm.toFixed(4)}. First values: [${vector
    .slice(0, 6)
    .map((v) => v.toFixed(4))
    .join(", ")}, …]`;
}
