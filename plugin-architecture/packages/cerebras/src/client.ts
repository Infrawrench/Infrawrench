import type {
  ActionNode,
  ChatMessage,
  ChatStreamEvent,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import {
  formatBytes,
  joinSubtitle,
  streamOpenAiSseChat,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import {
  API_BASE,
  METRICS_BASE,
  cerebrasFetch,
  cerebrasText,
  enc,
  statusOf,
  type CerebrasContext,
} from "./http.js";
import { parsePrometheus } from "./prometheus.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const V1 = `${API_BASE}/v1`;
const MGMT = `${API_BASE}/management/v1`;
const CONSOLE_URL = "https://cloud.cerebras.ai";
/** The metrics route reports the last complete minute only. */
const METRICS_WINDOW_MS = 60 * 1000;

interface ApiModel {
  id?: string;
  created?: number;
  owned_by?: string;
}

interface PublicModel extends ApiModel {
  name?: string;
  description?: string;
  hugging_face_id?: string;
  pricing?: { prompt?: string; completion?: string };
  capabilities?: Record<string, boolean>;
  limits?: { max_context_length?: number; max_completion_tokens?: number };
  deprecated?: boolean;
  preview?: boolean;
  quantization?: string;
}

interface Batch {
  id?: string;
  status?: string;
  endpoint?: string;
  errors?: unknown;
  input_file_id?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  completion_window?: string;
  created_at?: number;
  completed_at?: number | null;
  request_counts?: { total?: number; completed?: number; failed?: number };
}

interface CerebrasFile {
  id?: string;
  bytes?: number;
  filename?: string;
  purpose?: string;
  created_at?: number;
  expires_at?: number;
}

interface EndpointSummary {
  endpoint_id?: string;
  model_arch_id?: string;
  created?: number;
  updated?: number;
  org_name?: string;
}

interface EndpointStatus {
  name?: string;
  model_arch_id?: string;
  managing_org_name?: string;
  created?: number;
  updated?: number;
  deployed_models?: Array<{
    id?: string;
    model?: string;
    version_alias?: string;
    created?: number;
    state?: string;
  }>;
}

interface ModelVersion {
  name?: string;
  done?: boolean;
  response?: {
    customer_s3_uri?: string;
    version_aliases?: string[];
    sync_status?: string;
    system_fingerprint_suffix?: string;
  };
}

function iso(seconds: number | null | undefined): string {
  return typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : "";
}

function perMillion(perToken: string | undefined): number | "" {
  const n = Number(perToken);
  return perToken !== undefined && Number.isFinite(n) ? Math.round(n * 1e6 * 10000) / 10000 : "";
}

function s(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function dash(value: unknown): string {
  return s(value) || "—";
}

function externalIdOf(resourceId: string, accountId: string, typeId: string): string {
  const prefix = `${accountId}:${typeId}:`;
  if (resourceId.startsWith(prefix)) return resourceId.slice(prefix.length);
  const at = resourceId.indexOf(`:${typeId}:`);
  return at >= 0 ? resourceId.slice(at + typeId.length + 2) : resourceId;
}

/** `orgs/{org}/models/{arch}/versions/{id}` → `{ arch, version }`. */
export function parseVersionName(name: string): { org: string; arch: string; version: string } {
  const m = /^orgs\/([^/]+)\/models\/([^/]+)\/versions\/([^/]+)$/.exec(name);
  return m ? { org: m[1]!, arch: m[2]!, version: m[3]! } : { org: "", arch: "", version: "" };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function kv(items: Array<[string, unknown]>, copyable: string[] = []): SchemaNode {
  return {
    kind: "key-value-list",
    items: items.map(([key, value]) => ({
      key,
      value: dash(value),
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
    case "queued":
    case "validating":
    case "in_progress":
    case "finalizing":
      return "provisioning";
    default:
      return "info";
  }
}

/**
 * Cerebras Inference: the model catalogue with prices and a Playground,
 * batches and files (Private Preview), and Dedicated Inference endpoints and
 * model versions through the management API (Private Preview, separate key).
 * Cerebras publishes no usage, billing or key-management API.
 */
export class CerebrasClient implements PluginClient {
  private readonly apiKey: string;
  private readonly managementKey: string;
  private readonly orgName: string;
  private readonly organizationId: string;
  private readonly ctx: CerebrasContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("Cerebras plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.managementKey = (credentials["managementKey"] ?? "").trim();
    this.orgName = (credentials["orgName"] ?? "").trim();
    this.organizationId = (credentials["organizationId"] ?? "").trim();
    this.ctx = {
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  private api<T>(path: string, init?: RequestInit): Promise<T> {
    return cerebrasFetch<T>(this.ctx, this.apiKey, `${V1}${path}`, init);
  }

  private mgmt<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.managementKey || !this.orgName) {
      throw Object.assign(
        new Error(
          "Cerebras plugin: Dedicated Inference needs a management API key and your organization name on the account.",
        ),
        { status: 400 },
      );
    }
    return cerebrasFetch<T>(this.ctx, this.managementKey, `${MGMT}${path}`, init);
  }

  private get hasManagement(): boolean {
    return Boolean(this.managementKey && this.orgName);
  }

  // ------------------------------------------------------------- listing

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "cerebras-model":
        return this.listModels(accountId);
      case "cerebras-batch":
        return this.previewList(() => this.listBatches(accountId));
      case "cerebras-file":
        return this.previewList(() => this.listFiles(accountId));
      case "cerebras-endpoint":
        return this.hasManagement ? this.listEndpoints(accountId) : [];
      case "cerebras-model-version":
        return this.hasManagement ? this.listVersions(accountId) : [];
      default:
        throw new Error(`Cerebras plugin: unknown resource type "${typeId}"`);
    }
  }

  /** Private Preview routes answer 403/404 for organizations without access. */
  private async previewList(run: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await run();
    } catch (err) {
      if ([403, 404].includes(statusOf(err) ?? 0)) return [];
      throw err;
    }
  }

  /** `GET /v1/models` (what this key can call) + `GET /public/v1/models` (metadata). */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const [mine, catalogue] = await Promise.all([
      this.api<{ data?: ApiModel[] }>("/models"),
      cerebrasFetch<{ data?: PublicModel[] }>(this.ctx, "", `${API_BASE}/public/v1/models`).catch(
        () => ({ data: [] as PublicModel[] }),
      ),
    ]);
    const meta = new Map((catalogue.data ?? []).map((m) => [String(m.id), m]));
    return (mine.data ?? [])
      .filter((m) => m.id)
      .map((m) => this.mapModel(accountId, { ...meta.get(String(m.id)), ...m }));
  }

  private mapModel(accountId: string, m: PublicModel): ResourceInstance {
    const id = s(m.id);
    const caps = Object.entries(m.capabilities ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k.replace(/_/g, " "));
    return this.instance(
      accountId,
      "cerebras-model",
      id,
      m.name || id,
      {
        modelId: id,
        name: s(m.name),
        ownedBy: s(m.owned_by),
        description: s(m.description),
        huggingFaceId: s(m.hugging_face_id),
        inputPricePerMillion: perMillion(m.pricing?.prompt),
        outputPricePerMillion: perMillion(m.pricing?.completion),
        contextLength: m.limits?.max_context_length ?? "",
        maxCompletionTokens: m.limits?.max_completion_tokens ?? "",
        capabilities: caps.join(", "),
        quantization: s(m.quantization),
        preview: m.preview === true,
        deprecated: m.deprecated === true,
        created: iso(m.created),
      },
      { modelId: id, baseUrl: V1 },
    );
  }

  /** `GET /v1/batches?limit=100&after=` */
  private async listBatches(accountId: string): Promise<ResourceInstance[]> {
    const out: Batch[] = [];
    let after = "";
    for (let page = 0; page < 20; page++) {
      const res = await this.api<{ data?: Batch[] | null; has_more?: boolean | null }>(
        `/batches?limit=100${after ? `&after=${enc(after)}` : ""}`,
      );
      const data = res.data ?? [];
      out.push(...data);
      if (!res.has_more || data.length === 0) break;
      after = s(data[data.length - 1]?.id);
    }
    return out.filter((b) => b.id).map((b) => this.mapBatch(accountId, b));
  }

  private mapBatch(accountId: string, b: Batch): ResourceInstance {
    const id = s(b.id);
    return this.instance(
      accountId,
      "cerebras-batch",
      id,
      id,
      {
        batchId: id,
        status: s(b.status),
        endpoint: s(b.endpoint),
        completionWindow: s(b.completion_window),
        inputFileId: s(b.input_file_id),
        outputFileId: s(b.output_file_id),
        errorFileId: s(b.error_file_id),
        totalRequests: b.request_counts?.total ?? 0,
        completedRequests: b.request_counts?.completed ?? 0,
        failedRequests: b.request_counts?.failed ?? 0,
        errors: typeof b.errors === "string" ? b.errors : b.errors ? JSON.stringify(b.errors) : "",
        createdAt: iso(b.created_at),
        completedAt: iso(b.completed_at),
      },
      { batchId: id, outputFileId: s(b.output_file_id) },
    );
  }

  /** `GET /v1/files?limit=100&after=` */
  private async listFiles(accountId: string): Promise<ResourceInstance[]> {
    const out: CerebrasFile[] = [];
    let after = "";
    for (let page = 0; page < 20; page++) {
      const res = await this.api<{ data?: CerebrasFile[]; has_more?: boolean }>(
        `/files?limit=100${after ? `&after=${enc(after)}` : ""}`,
      );
      const data = res.data ?? [];
      out.push(...data);
      if (!res.has_more || data.length === 0) break;
      after = s(data[data.length - 1]?.id);
    }
    return out.filter((f) => f.id).map((f) => this.mapFile(accountId, f));
  }

  private mapFile(accountId: string, f: CerebrasFile): ResourceInstance {
    const id = s(f.id);
    return this.instance(
      accountId,
      "cerebras-file",
      id,
      f.filename || id,
      {
        fileId: id,
        filename: s(f.filename),
        purpose: s(f.purpose),
        bytes: f.bytes ?? 0,
        createdAt: iso(f.created_at),
        expiresAt: iso(f.expires_at),
      },
      { fileId: id },
    );
  }

  /** `GET /management/v1/orgs/{org}/endpoints` */
  private async listEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const res = await this.mgmt<{ endpoints?: EndpointSummary[] }>(
      `/orgs/${enc(this.orgName)}/endpoints`,
    );
    return (res.endpoints ?? [])
      .filter((e) => e.endpoint_id)
      .map((e) =>
        this.mapEndpoint(accountId, {
          name: e.endpoint_id ?? "",
          ...(e.model_arch_id ? { model_arch_id: e.model_arch_id } : {}),
          ...(e.org_name ? { managing_org_name: e.org_name } : {}),
          ...(e.created !== undefined ? { created: e.created } : {}),
          ...(e.updated !== undefined ? { updated: e.updated } : {}),
        }),
      );
  }

  private mapEndpoint(accountId: string, e: EndpointStatus): ResourceInstance {
    const id = s(e.name);
    const deployed = [...(e.deployed_models ?? [])].sort(
      (a, b) => (b.created ?? 0) - (a.created ?? 0),
    )[0];
    const parsed = parseVersionName(s(deployed?.model));
    return this.instance(
      accountId,
      "cerebras-endpoint",
      id,
      id,
      {
        endpointId: id,
        modelArchitecture: s(e.model_arch_id),
        deployedModel: s(deployed?.model),
        deployedAlias: s(deployed?.version_alias),
        deployedVersionKey: parsed.arch ? `${parsed.arch}/${parsed.version}` : "",
        deploymentState: s(deployed?.state),
        orgName: s(e.managing_org_name),
        createdAt: iso(e.created),
        updatedAt: iso(e.updated),
      },
      { endpointId: id, baseUrl: V1 },
    );
  }

  /** Architectures, then `GET …/models/{arch}/versions` for each. */
  private async listVersions(accountId: string): Promise<ResourceInstance[]> {
    const archs = await this.mgmt<{ model_architectures?: string[] }>(
      `/orgs/${enc(this.orgName)}/models`,
    );
    const lists = await Promise.all(
      (archs.model_architectures ?? []).map((arch) =>
        this.mgmt<{ model_versions?: ModelVersion[] }>(
          `/orgs/${enc(this.orgName)}/models/${enc(arch)}/versions`,
        ).catch(() => ({ model_versions: [] as ModelVersion[] })),
      ),
    );
    return lists
      .flatMap((l) => l.model_versions ?? [])
      .filter((v) => v.name)
      .map((v) => this.mapVersion(accountId, v));
  }

  private mapVersion(accountId: string, v: ModelVersion): ResourceInstance {
    const name = s(v.name);
    const { arch, version } = parseVersionName(name);
    const key = `${arch}/${version}`;
    return this.instance(
      accountId,
      "cerebras-model-version",
      key,
      `${arch} v${version}`,
      {
        modelArchitecture: arch,
        versionId: version,
        aliases: (v.response?.version_aliases ?? []).join(", "),
        weightUri: s(v.response?.customer_s3_uri),
        syncStatus: s(v.response?.sync_status),
        resourceName: name,
        done: v.done === true,
      },
      { resourceName: name },
    );
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
    const created = s(fields["createdAt"] ?? fields["created"]);
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: "cerebras",
      resourceTypeId: typeId,
      accountId,
      displayName: displayName || externalId,
      externalId,
      fields,
      resolvedOutputs: outputs,
      secretStates: [],
      createdAt: created || now,
      updatedAt: now,
    };
  }

  // ----------------------------------------------------------------- get

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId, accountId, typeId);
    switch (typeId) {
      case "cerebras-batch":
        return this.mapBatch(accountId, await this.api<Batch>(`/batches/${enc(id)}`));
      case "cerebras-file":
        return this.mapFile(accountId, await this.api<CerebrasFile>(`/files/${enc(id)}`));
      case "cerebras-endpoint":
        return this.mapEndpoint(
          accountId,
          await this.mgmt<EndpointStatus>(`/endpoints/${enc(id)}`),
        );
      case "cerebras-model-version": {
        const [arch, version] = id.split("/");
        return this.mapVersion(
          accountId,
          await this.mgmt<ModelVersion>(
            `/orgs/${enc(this.orgName)}/models/${enc(arch ?? "")}/versions/${enc(version ?? "")}`,
          ),
        );
      }
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.externalId === id);
        if (!found) {
          throw Object.assign(new Error(`Cerebras plugin: ${typeId}/${id} not found`), {
            status: 404,
          });
        }
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "baseUrl") return V1;
    const r = await this.getResource(typeId, resourceId, accountId);
    return s(r.resolvedOutputs[outputKey] ?? r.fields[outputKey]);
  }

  /** Stash the versions an endpoint could deploy, for the Deploy prompt. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    if (resource.resourceTypeId !== "cerebras-endpoint" || !this.hasManagement) return resource;
    const arch = s(resource.fields["modelArchitecture"]);
    if (!arch) return resource;
    const res = await this.mgmt<{ model_versions?: ModelVersion[] }>(
      `/orgs/${enc(this.orgName)}/models/${enc(arch)}/versions`,
    ).catch(() => ({ model_versions: [] as ModelVersion[] }));
    return {
      ...resource,
      resolvedOutputs: {
        ...resource.resolvedOutputs,
        __versions__: JSON.stringify(res.model_versions ?? []),
      },
    };
  }

  // -------------------------------------------------------------- create

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "cerebras-batch") {
      const files = await this.previewList(() => this.listFiles("x"));
      const options = files
        .filter((f) => (f.fields["purpose"] ?? "batch") === "batch")
        .map((f) => ({
          id: f.externalId ?? "",
          label: s(f.fields["filename"]) || (f.externalId ?? ""),
          description: Number(f.fields["bytes"]) ? formatBytes(Number(f.fields["bytes"])) : "",
        }));
      return {
        fields: [
          {
            key: "inputFileId",
            label: "Input File",
            kind: "select",
            required: true,
            options,
            ...(options[0] ? { defaultValue: options[0].id } : {}),
            description: options.length
              ? 'A JSONL file uploaded with purpose "batch": at most 50,000 requests and 200 MB.'
              : "No batch files uploaded yet. Upload a JSONL request file to Cerebras first.",
          },
        ],
      };
    }
    if (typeId === "cerebras-model-version") {
      const archs = await this.mgmt<{ model_architectures?: string[] }>(
        `/orgs/${enc(this.orgName)}/models`,
      );
      const options = (archs.model_architectures ?? []).map((a) => ({ id: a, label: a }));
      return {
        fields: [
          {
            key: "modelArchitecture",
            label: "Architecture",
            kind: "select",
            required: true,
            options,
            ...(options[0] ? { defaultValue: options[0].id } : {}),
            description: "The weights must be compatible with this architecture.",
          },
          {
            key: "weightUri",
            label: "Weights Location",
            kind: "text",
            required: true,
            placeholder: "s3://my-bucket/model-weights",
            description:
              "An S3 prefix shared with Cerebras through the cross-account bucket policy they provide.",
          },
          { key: "aliases", label: "Aliases", kind: "string-list", required: false },
          {
            key: "systemFingerprintSuffix",
            label: "Fingerprint Suffix (optional)",
            kind: "text",
            required: false,
            placeholder: "my-custom-suffix",
          },
        ],
      };
    }
    throw new Error(`Cerebras plugin: ${typeId} cannot be created`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "cerebras-batch") {
      if (!fields["inputFileId"]) throw new Error("Cerebras plugin: pick an input file");
      // Only `/v1/chat/completions` and `24h` are accepted today.
      const created = await this.api<Batch>("/batches", {
        method: "POST",
        body: JSON.stringify({
          input_file_id: fields["inputFileId"],
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
        }),
      });
      return this.mapBatch(accountId, created);
    }
    if (typeId === "cerebras-model-version") {
      const arch = fields["modelArchitecture"];
      if (!arch || !fields["weightUri"])
        throw new Error("Cerebras plugin: architecture and weights are required");
      const created = await this.mgmt<ModelVersion>(`/orgs/${enc(this.orgName)}/models:upload`, {
        method: "POST",
        body: JSON.stringify({
          model_arch_id: arch,
          model: {
            weight_uri: fields["weightUri"].trim(),
            version_aliases: splitList(fields["aliases"]),
            ...(fields["systemFingerprintSuffix"]
              ? { system_fingerprint_suffix: fields["systemFingerprintSuffix"] }
              : {}),
          },
        }),
      });
      return this.mapVersion(accountId, created);
    }
    throw new Error(`Cerebras plugin: ${typeId} cannot be created`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "cerebras-model-version")
      throw new Error(`Cerebras plugin: ${typeId} cannot be edited`);
    const [arch, version] = externalIdOf(resourceId, accountId, typeId).split("/");
    await this.mgmt(
      `/orgs/${enc(this.orgName)}/models/${enc(arch ?? "")}/versions/${enc(version ?? "")}`,
      {
        method: "PATCH",
        body: JSON.stringify({ version_aliases: splitList(fields["aliases"]) }),
      },
    );
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const id = externalIdOf(resourceId, accountId, typeId);
    if (typeId === "cerebras-file") {
      await this.api(`/files/${enc(id)}`, { method: "DELETE" });
      return;
    }
    if (typeId === "cerebras-model-version") {
      const [arch, version] = id.split("/");
      await this.mgmt(
        `/orgs/${enc(this.orgName)}/models/${enc(arch ?? "")}/versions/${enc(version ?? "")}`,
        {
          method: "DELETE",
        },
      );
      return;
    }
    throw new Error(`Cerebras plugin: ${typeId} cannot be deleted`);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId, accountId, typeId);
    if (typeId === "cerebras-batch" && actionId === "cancel") {
      await this.api(`/batches/${enc(id)}/cancel`, { method: "POST" });
      return;
    }
    throw new Error(`Cerebras plugin: unknown action "${actionId}" for ${typeId}`);
  }

  /** Deploy prompt: `POST /management/v1/endpoints/{id}:deployModel {model}`. */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId !== "cerebras-endpoint" || command !== "deployModel") {
      throw new Error(`Cerebras plugin: unknown command "${command}"`);
    }
    let form: Record<string, string> = {};
    try {
      form = typeof args[0] === "string" ? (JSON.parse(args[0]) as Record<string, string>) : {};
    } catch {
      form = {};
    }
    if (!form["model"]) throw new Error("Cerebras plugin: pick a model version");
    const id = externalIdOf(resourceId, accountId, typeId);
    return this.mgmt(`/endpoints/${enc(id)}:deployModel`, {
      method: "POST",
      body: JSON.stringify({ model: form["model"] }),
    });
  }

  // ------------------------------------------------------------- metrics

  /**
   * `GET https://cloud.cerebras.ai/api/v1/metrics/organizations/{org_id}`:
   * Prometheus text for the last complete minute, rate-limited to 6/min.
   * Each value becomes a one-point series stamped now.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "cerebras-endpoint" || !this.organizationId) return [];
    const id = externalIdOf(resourceId, accountId, resourceTypeId);
    let text: string;
    try {
      text = await cerebrasText(
        this.ctx,
        this.apiKey,
        `${METRICS_BASE}/${enc(this.organizationId)}`,
      );
    } catch (err) {
      if ([403, 404, 429].includes(statusOf(err) ?? 0)) return [];
      throw err;
    }
    const at = Math.floor(Date.now() / 60_000) * 60_000;
    return parsePrometheus(text)
      .filter((sample) => sample.labels["endpoint"] === id)
      .map((sample) => {
        const qualifier =
          sample.labels["statistic"] ?? sample.labels["percentile"] ?? sample.labels["code"] ?? "";
        return {
          label: qualifier ? `${sample.name} ${qualifier}` : sample.name,
          ...(sample.name.endsWith("_seconds") ? { unit: "s" } : {}),
          points: [{ timestamp: at, value: sample.value }],
        };
      });
  }

  // ---------------------------------------------------------------- chat

  /** `POST /v1/chat/completions` with `stream: true`; endpoints use their id as model. */
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (typeId !== "cerebras-model" && typeId !== "cerebras-endpoint") {
      yield { kind: "error", message: `Cerebras plugin: no playground for ${typeId}` };
      return;
    }
    const model = externalIdOf(resourceId, accountId, typeId);
    let res: Response;
    try {
      res = await fetch(`${V1}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
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
          res.status === 429
            ? "Cerebras rate limit reached for this model. Wait a minute or check the limits in the Cloud console."
            : `Chat request failed (${res.status}): ${text.slice(0, 400) || res.statusText}`,
      };
      return;
    }
    yield* streamOpenAiSseChat(res.body);
  }

  // -------------------------------------------------------------- render

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName || resource.id,
      status: { kind: "status-dot", status: this.statusFor(resource) },
    };
  }

  private statusFor(r: ResourceInstance): ResourceStatus {
    switch (r.resourceTypeId) {
      case "cerebras-model":
        return r.fields["deprecated"] === true ? "degraded" : "healthy";
      case "cerebras-batch":
        return batchStatus(s(r.fields["status"]));
      case "cerebras-endpoint": {
        const st = s(r.fields["deploymentState"]);
        return st === "complete"
          ? "healthy"
          : st === "failed"
            ? "error"
            : st
              ? "provisioning"
              : "info";
      }
      case "cerebras-model-version": {
        const st = s(r.fields["syncStatus"]);
        return st === "done" ? "healthy" : st === "failed" ? "error" : "provisioning";
      }
      default:
        return "info";
    }
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const schema = this.renderInner(resource);
    return withMetricsCapability(
      schema,
      RESOURCE_TYPES,
      resource.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  private renderInner(r: ResourceInstance): DetailViewSchema {
    const f = r.fields;
    const status = { kind: "status-dot" as const, status: this.statusFor(r) };
    switch (r.resourceTypeId) {
      case "cerebras-model": {
        const id = s(f["modelId"]) || (r.externalId ?? "");
        return {
          title: r.displayName,
          subtitle: joinSubtitle("Cerebras Model", id),
          status: {
            ...status,
            label:
              f["deprecated"] === true
                ? "Deprecated"
                : f["preview"] === true
                  ? "Preview"
                  : "Available",
          },
          sections: [
            section("Model", [
              kv(
                [
                  ["Model ID", id],
                  ["Owned By", f["ownedBy"]],
                  ["Hugging Face", f["huggingFaceId"]],
                  ["Quantization", f["quantization"]],
                  ["Capabilities", f["capabilities"]],
                ],
                ["Model ID"],
              ),
              ...(s(f["description"])
                ? [
                    {
                      kind: "text" as const,
                      variant: "muted" as const,
                      content: s(f["description"]),
                    },
                  ]
                : []),
            ]),
            section("Pricing & Limits", [
              kv([
                [
                  "Input",
                  s(f["inputPricePerMillion"]) !== ""
                    ? `$${f["inputPricePerMillion"]} / 1M tokens`
                    : "",
                ],
                [
                  "Output",
                  s(f["outputPricePerMillion"]) !== ""
                    ? `$${f["outputPricePerMillion"]} / 1M tokens`
                    : "",
                ],
                [
                  "Context Length",
                  Number(f["contextLength"]) ? Number(f["contextLength"]).toLocaleString() : "",
                ],
                [
                  "Max Completion",
                  Number(f["maxCompletionTokens"])
                    ? Number(f["maxCompletionTokens"]).toLocaleString()
                    : "",
                ],
              ]),
            ]),
            section("Endpoint", [
              { kind: "text", variant: "mono", copyable: true, content: `${V1}/chat/completions` },
              {
                kind: "text",
                variant: "muted",
                content:
                  "Cerebras publishes no usage, billing or API-key API: spend, request logs and rate limits stay in the Cloud console.",
              },
            ]),
          ],
          headerActions: [
            REFRESH,
            {
              kind: "action",
              label: "Usage in console",
              variant: "ghost",
              action: { type: "open-url", url: CONSOLE_URL },
            },
          ],
          chatPanel: {
            subtitle: `${id} on Cerebras Inference`,
            ...(f["deprecated"] === true ? { disabledReason: "This model is deprecated." } : {}),
          },
        };
      }
      case "cerebras-batch": {
        const st = s(f["status"]);
        const cancellable = ["queued", "validating", "in_progress", "finalizing"].includes(st);
        return {
          title: r.displayName,
          subtitle: joinSubtitle("Cerebras Batch", s(f["endpoint"])),
          status: { ...status, label: st || "unknown" },
          sections: [
            section("Progress", [
              kv([
                ["Status", st],
                ["Total Requests", f["totalRequests"]],
                ["Completed", f["completedRequests"]],
                ["Failed", f["failedRequests"]],
                ["Completion Window", f["completionWindow"]],
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
            section("Timeline", [
              kv([
                ["Created", f["createdAt"]],
                ["Completed", f["completedAt"]],
              ]),
            ]),
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
                      confirmMessage: "Cancel this batch? Completed requests are still billed.",
                      successMessage: "Batch cancellation requested.",
                    },
                  },
                ]
              : []),
          ],
        };
      }
      case "cerebras-file": {
        const bytes = Number(f["bytes"] ?? 0);
        return {
          title: r.displayName,
          subtitle: joinSubtitle("Cerebras File", s(f["purpose"])),
          status,
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
      case "cerebras-endpoint": {
        const versions = (() => {
          try {
            return JSON.parse(r.resolvedOutputs["__versions__"] ?? "[]") as ModelVersion[];
          } catch {
            return [] as ModelVersion[];
          }
        })();
        const options = versions
          .filter((v) => v.name && v.response?.sync_status === "done")
          .map((v) => ({
            id: s(v.name),
            label: `Version ${parseVersionName(s(v.name)).version}`,
            description: (v.response?.version_aliases ?? []).join(", "),
          }));
        const id = s(f["endpointId"]) || (r.externalId ?? "");
        return {
          title: id,
          subtitle: joinSubtitle("Dedicated Endpoint", s(f["modelArchitecture"])),
          status: { ...status, label: s(f["deploymentState"]) || "unknown" },
          sections: [
            section("Endpoint", [
              kv(
                [
                  ["Endpoint ID", id],
                  ["Architecture", f["modelArchitecture"]],
                  ["Deployed Version", f["deployedModel"]],
                  ["Alias", f["deployedAlias"]],
                  ["Deployment State", f["deploymentState"]],
                  ["Organization", f["orgName"]],
                  ["Created", f["createdAt"]],
                  ["Updated", f["updatedAt"]],
                ],
                ["Endpoint ID"],
              ),
              {
                kind: "text",
                variant: "muted",
                content: this.organizationId
                  ? "Metrics come from the last complete minute; Cerebras keeps no history behind this API."
                  : "Add your organization ID (org_…) to the account to see this endpoint's metrics.",
              },
            ]),
          ],
          headerActions: [
            REFRESH,
            ...(options.length
              ? [
                  {
                    kind: "action" as const,
                    label: "Deploy version",
                    action: {
                      type: "prompt-nosql-command" as const,
                      command: "deployModel",
                      title: "Deploy a model version",
                      description: `Replaces what ${id} serves. The endpoint id, and so every caller, stays the same.`,
                      fields: [
                        {
                          key: "model",
                          label: "Version",
                          kind: "select" as const,
                          required: true,
                          defaultValue: options[0]!.id,
                          options,
                        },
                      ],
                      submitLabel: "Deploy",
                    },
                  },
                ]
              : []),
          ],
          chatPanel: { subtitle: `${id} (Dedicated Inference)` },
        };
      }
      case "cerebras-model-version":
        return {
          title: r.displayName,
          subtitle: "Model Version",
          status: { ...status, label: s(f["syncStatus"]) || "unknown" },
          sections: [
            section("Version", [
              kv(
                [
                  ["Architecture", f["modelArchitecture"]],
                  ["Version", f["versionId"]],
                  ["Aliases", f["aliases"]],
                  ["Weights", f["weightUri"]],
                  ["Sync Status", f["syncStatus"]],
                  ["Resource Name", f["resourceName"]],
                ],
                ["Resource Name"],
              ),
            ]),
          ],
          headerActions: [REFRESH],
        };
      default:
        return { title: r.displayName, subtitle: "Cerebras", sections: [] };
    }
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}
