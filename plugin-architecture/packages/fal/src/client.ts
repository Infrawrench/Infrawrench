import type {
  ActionNode,
  CostFetchRange,
  CostRow,
  CreditBalance,
  CredentialExport,
  DetailViewSchema,
  HostServices,
  HttpHostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { joinSubtitle, jsonRestFetch, withMetricsCapability } from "@infrawrench/plugin-base";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Platform API v1. Spec: https://api.fal.ai/v1/openapi.json (Oct 2026). */
export const API_BASE = "https://api.fal.ai/v1";
const QUEUE_BASE = "https://queue.fal.run";
const DASHBOARD = "https://fal.ai/dashboard";
const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const USAGE_LOOKBACK_DAYS = 30;

const ANALYTICS_METRICS = [
  "request_count",
  "success_count",
  "user_error_count",
  "error_count",
  "p50_duration",
  "p90_duration",
  "p99_duration",
  "p50_prepare_duration",
  "p90_prepare_duration",
  "cold_boot_count",
];

interface UsageLine {
  endpoint_id?: string;
  app?: string | null;
  environment?: string | null;
  machine_type?: string;
  unit?: string;
  quantity?: number;
  unit_price?: number;
  cost_total?: number;
  cost_discount?: number;
  currency?: string;
  auth_method?: string;
  is_surge?: boolean;
}

interface UsagePage {
  next_cursor?: string | null;
  has_more?: boolean;
  time_series?: Array<{ bucket?: string; results?: UsageLine[] }>;
  summary?: UsageLine[];
}

interface AnalyticsRow {
  endpoint_id?: string;
  [metric: string]: number | string | undefined;
}

interface AnalyticsPage {
  next_cursor?: string | null;
  time_series?: Array<{ bucket?: string; results?: AnalyticsRow[] }>;
}

interface ModelInfo {
  endpoint_id?: string;
  metadata?: {
    display_name?: string;
    category?: string;
    description?: string;
    status?: string;
    license_type?: string;
    model_url?: string;
  };
}

interface App {
  endpoint_id?: string;
  name?: string;
  owner?: string;
  environment?: string;
  machine_type?: string;
  auth_mode?: string;
  keep_alive?: number;
  min_concurrency?: number;
  max_concurrency?: number;
  request_timeout?: number;
  startup_timeout?: number;
  valid_regions?: string[];
  updated_at?: string;
  endpoints?: string[];
}

interface Instance {
  id?: string;
  instance_type?: string;
  region?: string;
  sector?: string;
  ip?: string;
  status?: string;
  creator_user_nickname?: string;
}

interface ApiKey {
  key_id?: string;
  alias?: string;
  scope?: string;
  created_at?: string;
  creator_nickname?: string;
}

interface Workflow {
  name?: string;
  title?: string;
  user_nickname?: string;
  created_at?: string;
  description?: string;
  tags?: string[];
  endpoint_ids?: string[];
}

interface RequestItem {
  request_id?: string;
  started_at?: string;
  ended_at?: string | null;
  status_code?: number | null;
  duration?: number | null;
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

function statusOf(err: unknown): number | undefined {
  const st = (err as { status?: unknown } | null)?.status;
  return typeof st === "number" ? st : undefined;
}

function withStatus(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const m = /API error (\d{3})\b/.exec(err.message);
  if (!m) return err;
  const status = Number(m[1]);
  const hint =
    status === 401
      ? " Check the key in the fal dashboard under API Keys."
      : status === 403
        ? " This call needs an ADMIN-scope key."
        : "";
  return Object.assign(new Error(`${err.message}${hint}`), { status });
}

function qs(params: Record<string, string | string[] | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    for (const item of Array.isArray(v) ? v : [v]) out.append(k, item);
  }
  return out.toString();
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

function dayOf(bucket: string): string {
  // Buckets are ISO datetimes with an offset; the plugin always asks for UTC.
  const parsed = Date.parse(bucket);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString().slice(0, 10)
    : bucket.slice(0, 10);
}

/** Usage pages → daily cost rows. Exported for tests. */
export function modelUsageRows(pages: UsagePage[], range: CostFetchRange): CostRow[] {
  const rows: CostRow[] = [];
  for (const page of pages) {
    for (const bucket of page.time_series ?? []) {
      const date = dayOf(s(bucket.bucket));
      if (date < range.fromDate || date > range.toDate) continue;
      for (const r of bucket.results ?? []) {
        if (!r.cost_total && !r.quantity) continue;
        rows.push({
          date,
          service: "Model APIs",
          ...(r.endpoint_id ? { resourceId: r.endpoint_id } : {}),
          tags: { ...(r.auth_method ? { auth: r.auth_method } : {}) },
          currency: (r.currency || "USD").toUpperCase(),
          amount: Number(r.cost_total ?? 0),
          usageAmount: Number(r.quantity ?? 0),
          ...(r.unit ? { usageUnit: r.unit } : {}),
        });
      }
    }
  }
  return rows;
}

export function serverlessUsageRows(pages: UsagePage[], range: CostFetchRange): CostRow[] {
  const rows: CostRow[] = [];
  for (const page of pages) {
    for (const bucket of page.time_series ?? []) {
      const date = dayOf(s(bucket.bucket));
      if (date < range.fromDate || date > range.toDate) continue;
      for (const r of bucket.results ?? []) {
        if (!r.cost_total && !r.quantity) continue;
        const tags: Record<string, string> = {};
        if (r.machine_type) tags["machineType"] = r.machine_type;
        if (r.environment) tags["environment"] = r.environment;
        if (r.is_surge) tags["surge"] = "true";
        rows.push({
          date,
          service: "Serverless",
          ...(r.app ? { resourceId: r.app } : {}),
          tags,
          currency: (r.currency || "USD").toUpperCase(),
          amount: Number(r.cost_total ?? 0),
          usageAmount: Number(r.quantity ?? 0),
          ...(r.unit ? { usageUnit: r.unit } : {}),
        });
      }
    }
  }
  return rows;
}

/** Analytics pages → one series per metric. Durations are seconds. */
export function analyticsSeries(pages: AnalyticsPage[]): MetricSeries[] {
  const byMetric = new Map<string, Array<{ timestamp: number; value: number }>>();
  for (const page of pages) {
    for (const bucket of page.time_series ?? []) {
      const ts = Date.parse(s(bucket.bucket));
      if (!Number.isFinite(ts)) continue;
      for (const row of bucket.results ?? []) {
        for (const metric of ANALYTICS_METRICS) {
          const v = Number(row[metric]);
          if (row[metric] === undefined || !Number.isFinite(v)) continue;
          const list = byMetric.get(metric) ?? [];
          list.push({ timestamp: ts, value: v });
          byMetric.set(metric, list);
        }
      }
    }
  }
  const label = (m: string) =>
    m
      .replace(/^p(\d+)_prepare_duration$/, "Queue time p$1")
      .replace(/^p(\d+)_duration$/, "Execution time p$1")
      .replace(/_count$/, "")
      .replace(/_/g, " ")
      .replace(/^\w/, (c) => c.toUpperCase());
  return [...byMetric.entries()].map(([metric, points]) => ({
    label: label(metric),
    unit: metric.includes("duration") ? "s" : "requests",
    points: points.sort((a, b) => a.timestamp - b.timestamp),
  }));
}

/**
 * fal: Model API endpoints the workspace uses (price, cost, analytics,
 * recent requests), Serverless apps (queue, revisions, logs, analytics),
 * Compute instances, API keys and workflows, plus billed usage and the
 * credit balance. Usage, billing, keys and compute need an ADMIN key.
 */
export class FalClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly http: HttpHostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("fal plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.http = services?.http;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "fal",
        url: `${API_BASE}${path}`,
        errorPath: path.split("?")[0] ?? path,
        // fal uses `Key`, not `Bearer`.
        headers: { Authorization: `Key ${this.apiKey}`, Accept: "application/json" },
        ...(init ? { init } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
        ...(this.http ? { http: this.http } : {}),
      });
    } catch (err) {
      throw withStatus(err);
    }
  }

  /** Follow `next_cursor` on any paged route. */
  private async pages<T extends { next_cursor?: string | null }>(
    path: string,
    params: Record<string, string | string[] | undefined>,
    maxPages = 20,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.fetch<T>(`${path}?${qs({ ...params, cursor })}`);
      out.push(page);
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
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
      pluginId: "fal",
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
      case "fal-model":
        return this.listModels(accountId);
      case "fal-app":
        return this.listApps(accountId);
      case "fal-compute-instance":
        return this.adminOnly(() => this.listInstances(accountId));
      case "fal-api-key":
        return this.adminOnly(() => this.listKeys(accountId));
      case "fal-workflow":
        return this.listWorkflows(accountId);
      default:
        throw new Error(`fal plugin: unknown resource type "${typeId}"`);
    }
  }

  private async adminOnly(run: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await run();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  /**
   * Endpoints with usage in the last 30 days (`GET /models/usage?expand=summary`,
   * admin key), joined with `GET /models` metadata and `GET /models/pricing`.
   * fal's public catalogue has thousands of endpoints, so listing it all would
   * bury the ones this workspace runs.
   */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const start = new Date(Date.now() - USAGE_LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    let pages: UsagePage[];
    try {
      pages = await this.pages<UsagePage>(
        "/models/usage",
        { expand: "summary", start, timezone: "UTC" },
        10,
      );
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
    const totals = new Map<string, { quantity: number; cost: number; unit: string }>();
    for (const page of pages) {
      for (const line of page.summary ?? []) {
        const id = s(line.endpoint_id);
        if (!id) continue;
        const t = totals.get(id) ?? { quantity: 0, cost: 0, unit: s(line.unit) };
        t.quantity += Number(line.quantity ?? 0);
        t.cost += Number(line.cost_total ?? 0);
        totals.set(id, t);
      }
    }
    const ids = [...totals.keys()];
    const meta = new Map<string, ModelInfo>();
    const prices = new Map<string, { unit_price?: number; unit?: string }>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const [m, p] = await Promise.all([
        this.fetch<{ models?: ModelInfo[] }>(
          `/models?${qs({ endpoint_id: chunk, limit: "50" })}`,
        ).catch(() => ({ models: [] as ModelInfo[] })),
        this.fetch<{
          prices?: Array<{ endpoint_id?: string; unit_price?: number; unit?: string }>;
        }>(`/models/pricing?${qs({ endpoint_id: chunk })}`).catch(() => ({ prices: [] })),
      ]);
      for (const x of m.models ?? []) if (x.endpoint_id) meta.set(x.endpoint_id, x);
      for (const x of p.prices ?? []) if (x.endpoint_id) prices.set(x.endpoint_id, x);
    }
    return ids.map((id) => {
      const t = totals.get(id)!;
      const md = meta.get(id)?.metadata ?? {};
      const price = prices.get(id);
      return this.instance(
        accountId,
        "fal-model",
        id,
        md.display_name ? `${md.display_name} (${id})` : id,
        {
          endpointId: id,
          displayName: s(md.display_name),
          category: s(md.category),
          status: s(md.status),
          description: s(md.description),
          unitPrice: price?.unit_price ?? "",
          unit: s(price?.unit) || t.unit,
          quantity30d: Math.round(t.quantity * 1000) / 1000,
          cost30d: Math.round(t.cost * 100) / 100,
          licenseType: s(md.license_type),
          modelUrl: s(md.model_url) || `https://fal.ai/models/${id}`,
        },
        { endpointId: id, queueUrl: `${QUEUE_BASE}/${id}` },
      );
    });
  }

  /** `GET /serverless/apps?expand=endpoints` */
  private async listApps(accountId: string): Promise<ResourceInstance[]> {
    let res: { apps?: App[] };
    try {
      res = await this.fetch<{ apps?: App[] }>("/serverless/apps?expand=endpoints");
    } catch (err) {
      if (statusOf(err) === 403 || statusOf(err) === 404) return [];
      throw err;
    }
    return (res.apps ?? []).filter((a) => a.endpoint_id).map((a) => this.mapApp(accountId, a));
  }

  private mapApp(accountId: string, a: App): ResourceInstance {
    const id = s(a.endpoint_id);
    return this.instance(
      accountId,
      "fal-app",
      id,
      id,
      {
        endpointId: id,
        name: s(a.name),
        owner: s(a.owner),
        environment: s(a.environment),
        machineType: s(a.machine_type),
        authMode: s(a.auth_mode),
        keepAlive: a.keep_alive ?? "",
        minConcurrency: a.min_concurrency ?? "",
        maxConcurrency: a.max_concurrency ?? "",
        requestTimeout: a.request_timeout ?? "",
        startupTimeout: a.startup_timeout ?? "",
        regions: (a.valid_regions ?? []).join(", "),
        routes: (a.endpoints ?? []).join(", "),
        updatedAt: s(a.updated_at),
      },
      { endpointId: id, queueUrl: `${QUEUE_BASE}/${id}` },
    );
  }

  /** `GET /compute/instances?limit=&cursor=` */
  private async listInstances(accountId: string): Promise<ResourceInstance[]> {
    const pages = await this.pages<{ next_cursor?: string | null; instances?: Instance[] }>(
      "/compute/instances",
      { limit: "100" },
    );
    return pages
      .flatMap((p) => p.instances ?? [])
      .filter((i) => i.id)
      .map((i) => this.mapInstance(accountId, i));
  }

  private mapInstance(accountId: string, i: Instance): ResourceInstance {
    const id = s(i.id);
    return this.instance(
      accountId,
      "fal-compute-instance",
      id,
      `${s(i.instance_type)} · ${id}`,
      {
        instanceId: id,
        instanceType: s(i.instance_type),
        region: s(i.region),
        sector: s(i.sector),
        ip: s(i.ip),
        status: s(i.status),
        creator: s(i.creator_user_nickname),
      },
      { ip: s(i.ip) },
    );
  }

  /** `GET /keys?limit=&cursor=` */
  private async listKeys(accountId: string): Promise<ResourceInstance[]> {
    const pages = await this.pages<{ next_cursor?: string | null; keys?: ApiKey[] }>("/keys", {
      limit: "100",
    });
    return pages
      .flatMap((p) => p.keys ?? [])
      .filter((k) => k.key_id)
      .map((k) =>
        this.instance(
          accountId,
          "fal-api-key",
          s(k.key_id),
          k.alias || s(k.key_id),
          {
            keyId: s(k.key_id),
            alias: s(k.alias),
            scope: s(k.scope),
            createdAt: s(k.created_at),
            creator: s(k.creator_nickname),
          },
          { keyId: s(k.key_id) },
        ),
      );
  }

  /** `GET /workflows?limit=&cursor=` */
  private async listWorkflows(accountId: string): Promise<ResourceInstance[]> {
    const pages = await this.pages<{ next_cursor?: string | null; workflows?: Workflow[] }>(
      "/workflows",
      {
        limit: "100",
      },
    );
    return pages
      .flatMap((p) => p.workflows ?? [])
      .filter((w) => w.name)
      .map((w) => {
        const id = `${s(w.user_nickname)}/${s(w.name)}`;
        return this.instance(
          accountId,
          "fal-workflow",
          id,
          w.title || s(w.name),
          {
            name: s(w.name),
            title: s(w.title),
            owner: s(w.user_nickname),
            description: s(w.description),
            endpoints: (w.endpoint_ids ?? []).join(", "),
            tags: (w.tags ?? []).join(", "),
            createdAt: s(w.created_at),
          },
          { name: id },
        );
      });
  }

  // ----------------------------------------------------------------- get

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId, accountId, typeId);
    if (typeId === "fal-compute-instance") {
      return this.mapInstance(
        accountId,
        await this.fetch<Instance>(`/compute/instances/${encodeURIComponent(id)}`),
      );
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === id);
    if (!found)
      throw Object.assign(new Error(`fal plugin: ${typeId}/${id} not found`), { status: 404 });
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

  /** Recent requests for models; queue size and revisions for apps. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = resource.externalId ?? "";
    const out = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
    if (resource.resourceTypeId === "fal-model" || resource.resourceTypeId === "fal-app") {
      const base = resource.resourceTypeId === "fal-model" ? "/models" : "/serverless";
      const reqs = await this.fetch<{ items?: RequestItem[] }>(
        `${base}/requests/by-endpoint?${qs({ endpoint_id: id, limit: "20", sort_by: "ended_at" })}`,
      ).catch(() => ({ items: [] as RequestItem[] }));
      out.resolvedOutputs["__requests__"] = JSON.stringify(reqs.items ?? []);
    }
    if (resource.resourceTypeId === "fal-app") {
      const [owner, ...rest] = id.split("/");
      const path = `/serverless/apps/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(rest.join("/"))}`;
      const [queue, revisions] = await Promise.all([
        this.fetch<{ queue_size?: number }>(`${path}/queue`).catch(
          () => ({}) as { queue_size?: number },
        ),
        this.fetch<{ revisions?: unknown[] }>(`${path}/revisions?limit=20`).catch(() => ({
          revisions: [],
        })),
      ]);
      if (typeof queue.queue_size === "number")
        out.resolvedOutputs["__queue__"] = String(queue.queue_size);
      out.resolvedOutputs["__revisions__"] = JSON.stringify(revisions.revisions ?? []);
    }
    return out;
  }

  // ------------------------------------------------------- mutations

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const id = externalIdOf(resourceId, accountId, typeId);
    if (typeId === "fal-compute-instance") {
      await this.fetch(`/compute/instances/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
    if (typeId === "fal-api-key") {
      await this.fetch(`/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      return;
    }
    throw new Error(`fal plugin: ${typeId} cannot be deleted`);
  }

  /** `DELETE /serverless/apps/{owner}/{name}/queue` flushes pending requests. */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "fal-app" && actionId === "flush-queue") {
      const [owner, ...rest] = externalIdOf(resourceId, accountId, typeId).split("/");
      await this.fetch(
        `/serverless/apps/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(rest.join("/"))}/queue`,
        { method: "DELETE" },
      );
      return;
    }
    throw new Error(`fal plugin: unknown action "${actionId}" for ${typeId}`);
  }

  /** `POST /keys {alias}`: the secret is returned once. */
  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "fal-api-key" || formatId !== "replacement-key") {
      throw new Error(`fal plugin: no credential format "${formatId}" for ${typeId}`);
    }
    const current = await this.getResource(typeId, resourceId, accountId);
    const alias =
      s(current.fields["alias"]) || `infrawrench-${new Date().toISOString().slice(0, 10)}`;
    const created = await this.fetch<{ key_id?: string; key_secret?: string; key?: string }>(
      "/keys",
      {
        method: "POST",
        body: JSON.stringify({ alias }),
      },
    );
    const key =
      s(created.key) ||
      (created.key_id && created.key_secret ? `${created.key_id}:${created.key_secret}` : "");
    if (!key) throw new Error("fal plugin: the key was created but no secret came back");
    return {
      content: key,
      filename: `fal-${s(created.key_id)}.txt`,
      mimeType: "text/plain",
      fields: [
        { label: "Key ID", value: s(created.key_id) },
        { label: "Alias", value: alias },
        { label: "API Key", value: key, sensitive: true, hint: "Only shown once" },
      ],
      warning:
        "Save this key now: fal never shows the secret again. Delete the old key once nothing uses it.",
    };
  }

  // ------------------------------------------------------ metrics/logs

  /** `GET /models/analytics` or `/serverless/analytics` for one endpoint. */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "fal-model" && resourceTypeId !== "fal-app") return [];
    const id = externalIdOf(resourceId, accountId, resourceTypeId);
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - METRICS_WINDOW_MS;
    const path = resourceTypeId === "fal-model" ? "/models/analytics" : "/serverless/analytics";
    try {
      const pages = await this.pages<AnalyticsPage>(
        path,
        {
          endpoint_id: id,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          timezone: "UTC",
          expand: ["time_series", ...ANALYTICS_METRICS],
        },
        10,
      );
      return analyticsSeries(pages);
    } catch (err) {
      if (statusOf(err) === 403 || statusOf(err) === 404) return [];
      throw err;
    }
  }

  /** `POST /serverless/logs/history?app_id=&limit=` with no label filters. */
  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "fal-app") return { text: "", containers: [], activeContainer: "" };
    const id = externalIdOf(resourceId, accountId, typeId);
    const res = await this.fetch<{
      items?: Array<{ timestamp?: string; level?: string; message?: string; revision?: string }>;
    }>(
      `/serverless/logs/history?${qs({ app_id: id, limit: String(Math.min(params.tailLines ?? 500, 1000)) })}`,
      { method: "POST", body: "[]" },
    );
    const text = (res.items ?? [])
      .slice()
      .reverse()
      .map((l) => `${s(l.timestamp)} ${s(l.level).toUpperCase()} ${s(l.message)}\n`)
      .join("");
    return { text, containers: [id], activeContainer: id };
  }

  // ---------------------------------------------------------- billing

  /**
   * Billed usage: `GET /models/usage` and `GET /serverless/usage`, daily
   * buckets in UTC, `cost_total` (after discounts). Both need an ADMIN key.
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const end = new Date(Date.parse(`${range.toDate}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const params = {
      start: range.fromDate,
      end,
      timezone: "UTC",
      timeframe: "day",
      expand: "time_series",
      limit: "1000",
    };
    const [models, serverless] = await Promise.all([
      this.pages<UsagePage>(
        "/models/usage",
        { ...params, expand: ["time_series", "auth_method"] },
        50,
      ),
      this.pages<UsagePage>("/serverless/usage", params, 50).catch((err) => {
        if (statusOf(err) === 403 || statusOf(err) === 404) return [] as UsagePage[];
        throw err;
      }),
    ]);
    return [...modelUsageRows(models, range), ...serverlessUsageRows(serverless, range)];
  }

  /** `GET /account/billing?expand=credits` */
  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    const res = await this.fetch<{ credits?: { current_balance?: number; currency?: string } }>(
      "/account/billing?expand=credits",
    );
    if (!res.credits || typeof res.credits.current_balance !== "number") return [];
    const currency = (res.credits.currency || "USD").toUpperCase();
    return [
      { key: currency, label: "fal credits", remaining: res.credits.current_balance, currency },
    ];
  }

  // ----------------------------------------------------------- render

  private statusFor(r: ResourceInstance): ResourceStatus {
    switch (r.resourceTypeId) {
      case "fal-model":
        return s(r.fields["status"]) === "deprecated" ? "degraded" : "healthy";
      case "fal-compute-instance": {
        const st = s(r.fields["status"]);
        return st === "ready"
          ? "healthy"
          : st === "stopped"
            ? "degraded"
            : st === "unknown"
              ? "unknown"
              : "provisioning";
      }
      default:
        return "healthy";
    }
  }

  renderSidebarItem(r: ResourceInstance): SidebarItemSchema {
    return {
      id: r.id,
      label: r.displayName || r.id,
      status: { kind: "status-dot", status: this.statusFor(r) },
    };
  }

  renderDetail(r: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      this.renderInner(r),
      RESOURCE_TYPES,
      r.resourceTypeId,
      METRICS_WINDOW_MS,
    );
  }

  private requestsTable(r: ResourceInstance): SectionNode[] {
    let items: RequestItem[] = [];
    try {
      items = JSON.parse(r.resolvedOutputs["__requests__"] ?? "[]") as RequestItem[];
    } catch {
      items = [];
    }
    if (!items.length) return [];
    return [
      section("Recent Requests", [
        {
          kind: "table",
          columns: [
            { key: "id", label: "Request", mono: true },
            { key: "status", label: "HTTP" },
            { key: "duration", label: "Duration" },
            { key: "ended", label: "Ended" },
          ],
          rows: items.map((i) => ({
            cells: {
              id: s(i.request_id),
              status: s(i.status_code) || "—",
              duration: typeof i.duration === "number" ? `${i.duration.toFixed(2)} s` : "—",
              ended: s(i.ended_at) || "running",
            },
          })),
        },
      ]),
    ];
  }

  private renderInner(r: ResourceInstance): DetailViewSchema {
    const f = r.fields;
    const status = { kind: "status-dot" as const, status: this.statusFor(r) };
    switch (r.resourceTypeId) {
      case "fal-model": {
        const id = s(f["endpointId"]) || (r.externalId ?? "");
        return {
          title: s(f["displayName"]) || id,
          subtitle: joinSubtitle("fal Model", s(f["category"])),
          status: { ...status, label: s(f["status"]) || "active" },
          sections: [
            section("Model", [
              kv(
                [
                  ["Endpoint ID", id],
                  ["Category", f["category"]],
                  ["License", f["licenseType"]],
                  [
                    "Price",
                    s(f["unitPrice"]) !== ""
                      ? `$${f["unitPrice"]} per ${s(f["unit"]) || "unit"}`
                      : "",
                  ],
                  ["Units (30 days)", f["quantity30d"]],
                  ["Cost (30 days)", s(f["cost30d"]) !== "" ? `$${f["cost30d"]}` : ""],
                ],
                ["Endpoint ID"],
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
            section("Queue", [
              { kind: "text", variant: "mono", copyable: true, content: `${QUEUE_BASE}/${id}` },
            ]),
            ...this.requestsTable(r),
          ],
          headerActions: [
            REFRESH,
            {
              kind: "action",
              label: "Model page",
              variant: "ghost",
              action: { type: "open-url", url: s(f["modelUrl"]) || `https://fal.ai/models/${id}` },
            },
          ],
        };
      }
      case "fal-app": {
        const id = s(f["endpointId"]) || (r.externalId ?? "");
        const queue = r.resolvedOutputs["__queue__"];
        let revisions: Array<{
          revision_id?: string;
          created_at?: string;
          is_current?: boolean;
          status?: string | null;
          deployed_by?: string | null;
          message?: string | null;
        }> = [];
        try {
          revisions = JSON.parse(r.resolvedOutputs["__revisions__"] ?? "[]");
        } catch {
          revisions = [];
        }
        return {
          title: id,
          subtitle: joinSubtitle("Serverless App", s(f["machineType"])),
          status,
          sections: [
            section("App", [
              kv(
                [
                  ["App ID", id],
                  ["Environment", f["environment"]],
                  ["Machine Type", f["machineType"]],
                  ["Auth Mode", f["authMode"]],
                  ["Regions", f["regions"]],
                  ["Routes", f["routes"]],
                  ["Queue Size", queue ?? ""],
                  ["Updated", f["updatedAt"]],
                ],
                ["App ID"],
              ),
            ]),
            section("Scaling", [
              kv([
                ["Min Concurrency", f["minConcurrency"]],
                ["Max Concurrency", f["maxConcurrency"]],
                ["Keep Alive", s(f["keepAlive"]) ? `${f["keepAlive"]} s` : ""],
                ["Request Timeout", s(f["requestTimeout"]) ? `${f["requestTimeout"]} s` : ""],
                ["Startup Timeout", s(f["startupTimeout"]) ? `${f["startupTimeout"]} s` : ""],
              ]),
              {
                kind: "text",
                variant: "muted",
                content:
                  "Scaling and deployments are changed with `fal deploy` / `fal apps scale`; the Platform API exposes them read-only.",
              },
            ]),
            ...(revisions.length
              ? [
                  section("Revisions", [
                    {
                      kind: "table",
                      columns: [
                        { key: "id", label: "Revision", mono: true },
                        { key: "status", label: "Status" },
                        { key: "current", label: "Serving" },
                        { key: "by", label: "Deployed By" },
                        { key: "created", label: "Created" },
                      ],
                      rows: revisions.map((v) => ({
                        cells: {
                          id: s(v.revision_id),
                          status: s(v.status) || "—",
                          current: v.is_current ? "yes" : "",
                          by: s(v.deployed_by) || "—",
                          created: s(v.created_at),
                        },
                      })),
                    },
                  ]),
                ]
              : []),
            ...this.requestsTable(r),
          ],
          headerActions: [
            REFRESH,
            {
              kind: "action",
              label: "Flush queue",
              variant: "danger",
              action: {
                type: "plugin-action",
                actionId: "flush-queue",
                confirmMessage:
                  "Drop every pending request in this app's queue? Callers get no result for them.",
                successMessage: "Queue flushed.",
                destructive: true,
              },
            },
          ],
          logs: { defaultTailLines: 500 },
        };
      }
      case "fal-compute-instance":
        return {
          title: r.displayName,
          subtitle: joinSubtitle("Compute Instance", s(f["region"])),
          status: { ...status, label: s(f["status"]) || "unknown" },
          sections: [
            section("Instance", [
              kv(
                [
                  ["Instance ID", f["instanceId"]],
                  ["Type", f["instanceType"]],
                  ["Region", f["region"]],
                  ["Sector", f["sector"]],
                  ["IP Address", f["ip"]],
                  ["Created By", f["creator"]],
                ],
                ["IP Address", "Instance ID"],
              ),
            ]),
          ],
          headerActions: [
            REFRESH,
            {
              kind: "action",
              label: "Compute dashboard",
              variant: "ghost",
              action: { type: "open-url", url: `${DASHBOARD}/compute` },
            },
          ],
        };
      case "fal-api-key":
        return {
          title: r.displayName,
          subtitle: joinSubtitle("API Key", s(f["scope"])),
          status,
          sections: [
            section("Key", [
              kv(
                [
                  ["Key ID", f["keyId"]],
                  ["Alias", f["alias"]],
                  ["Scope", f["scope"]],
                  ["Created", f["createdAt"]],
                  ["Created By", f["creator"]],
                ],
                ["Key ID"],
              ),
            ]),
          ],
          headerActions: [REFRESH],
        };
      case "fal-workflow":
        return {
          title: r.displayName,
          subtitle: "fal Workflow",
          status,
          sections: [
            section("Workflow", [
              kv([
                ["Name", r.externalId],
                ["Owner", f["owner"]],
                ["Description", f["description"]],
                ["Endpoints", f["endpoints"]],
                ["Tags", f["tags"]],
                ["Created", f["createdAt"]],
              ]),
            ]),
          ],
          headerActions: [
            REFRESH,
            {
              kind: "action",
              label: "Open workflow",
              variant: "ghost",
              action: { type: "open-url", url: `https://fal.ai/workflows/${r.externalId ?? ""}` },
            },
          ],
        };
      default:
        return { title: r.displayName, subtitle: "fal", sections: [] };
    }
  }
}
