import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  ActionNode,
  CostFetchRange,
  CostRow,
  CreditBalance,
  CredentialExport,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  StatusDotNode,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  pathEncode,
  reportUnreadListPart,
  requireListPage,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import {
  afterCursor,
  allPages,
  call,
  createFalApi,
  statusOf,
  type AnalyticsPage,
  type AnalyticsRow,
  type ApiKey,
  type App,
  type FalApi,
  type Instance,
  type ModelInfo,
  type ModelMetadata,
  type ModelPrice,
  type ModelUsagePage,
  type RequestItem,
  type Revision,
  type ServerlessUsagePage,
} from "./api.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const QUEUE_BASE = "https://queue.fal.run";
const DASHBOARD = "https://fal.ai/dashboard";
const METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
const USAGE_LOOKBACK_DAYS = 30;
/** The summary route takes no page size from us, and the document's example page is 50. */
const USAGE_SUMMARY_MAX_PAGES = 200;
/** 50,000 rows at the 1,000 a cost page asks for. */
const COST_MAX_PAGES = 50;
const ANALYTICS_MAX_PAGES = 10;
const MAIN_ENVIRONMENT = "main";
/** Long enough that a staging app used now and then stays listed. */
const ENVIRONMENT_LOOKBACK_DAYS = 90;
/** How fal answers an environment or a discovery query it does not take, as no rows. */
const REFUSED_QUERY = new Set([400, 404, 422]);

const ANALYTICS_METRICS: Array<Exclude<keyof AnalyticsRow, "endpoint_id">> = [
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

type FieldValue = string | number | boolean | null | undefined;
type AppName = Pick<App, "name" | "endpoint_id"> & Partial<Pick<App, "environment">>;

function s(value: FieldValue): string {
  return value === undefined || value === null ? "" : String(value);
}

function externalIdOf(resourceId: string, accountId: string, typeId: string): string {
  const prefix = `${accountId}:${typeId}:`;
  if (resourceId.startsWith(prefix)) return resourceId.slice(prefix.length);
  const at = resourceId.indexOf(`:${typeId}:`);
  return at >= 0 ? resourceId.slice(at + typeId.length + 2) : resourceId;
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function kv(items: Array<[string, FieldValue]>, copyable: string[] = []): SchemaNode {
  return {
    kind: "key-value-list",
    items: items.map(([key, value]) => ({
      key,
      value: s(value) || "—",
      ...(copyable.includes(key) && s(value) ? { copyable: true } : {}),
    })),
  };
}

function muted(content: string): SchemaNode[] {
  return content ? [{ kind: "text", variant: "muted", content }] : [];
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
export function modelUsageRows(
  pages: Pick<ModelUsagePage, "time_series">[],
  range: CostFetchRange,
): CostRow[] {
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

interface UsageLineApp {
  endpointId: string;
  suffixed: boolean;
}

function matchUsageLine(line: string, apps: readonly AppName[]): UsageLineApp | undefined {
  const exact = apps.find((a) => a.name === line || a.endpoint_id === line);
  if (exact) return { endpointId: exact.endpoint_id, suffixed: false };
  let best: AppName | undefined;
  for (const app of apps) {
    if (!line.startsWith(`${app.name}-`)) continue;
    if (!best || app.name.length > best.name.length) best = app;
  }
  return best && { endpointId: best.endpoint_id, suffixed: true };
}

/**
 * The app a usage line was billed to. The document has `app` as the deployed name with
 * the owner stripped and perhaps an environment or version suffix (`my-app-prod`), and
 * `<owner>/<name>` is what the app resource is known by. The longest listed name wins,
 * so `my-app-eu-dev` is not `my-app` when `my-app-eu` exists. A name can repeat across
 * environments, so the line's own environment is tried first.
 */
function appOfUsageLine(
  line: string,
  environment: string | null,
  apps: readonly AppName[],
): UsageLineApp {
  const deployedThere = environment ? apps.filter((a) => a.environment === environment) : [];
  return (
    matchUsageLine(line, deployedThere) ??
    matchUsageLine(line, apps) ?? { endpointId: line, suffixed: false }
  );
}

/** The environments other than main that usage lines were billed in. */
function environmentsOfUsage(pages: Pick<ServerlessUsagePage, "time_series">[]): string[] {
  const environments = new Set<string>();
  for (const page of pages) {
    for (const bucket of page.time_series ?? []) {
      for (const { environment } of bucket.results ?? []) {
        if (environment && environment !== MAIN_ENVIRONMENT) environments.add(environment);
      }
    }
  }
  return [...environments];
}

/**
 * An app read from a named environment, under the address fal gives it: a staging URL
 * ends in `--staging`, and the app's name repeats in each environment. Sharing main's id
 * would merge the two rows, and Flush queue on the staging one would empty main's.
 */
function appInEnvironment(app: App, environment: string): App {
  const suffix = `--${environment}`;
  return {
    ...app,
    environment,
    endpoint_id: app.endpoint_id.endsWith(suffix) ? app.endpoint_id : `${app.endpoint_id}${suffix}`,
  };
}

export function serverlessUsageRows(
  pages: Pick<ServerlessUsagePage, "time_series">[],
  range: CostFetchRange,
  apps: readonly AppName[],
): CostRow[] {
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
        const app = r.app ? appOfUsageLine(r.app, r.environment, apps) : undefined;
        if (r.app && app?.suffixed) tags["app"] = r.app;
        rows.push({
          date,
          service: "Serverless",
          ...(app ? { resourceId: app.endpointId } : {}),
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

/** How a key is permissioned. `scope` is deprecated, and fal omits it for any newer key. */
function keyAccess(key: Pick<ApiKey, "mode" | "preset" | "scope">): string {
  if (key.preset) return `${key.preset} preset`;
  if (key.mode === "custom") return "Custom permissions";
  if (key.scope) return `Legacy ${key.scope} scope`;
  return key.mode === "legacy" ? "Legacy scope" : "";
}

/**
 * What a new key needs to match `key`, since sending neither gets the API preset. fal's
 * key docs name FULL as the closest preset to a legacy ADMIN key, and API to a legacy API.
 */
function sameAccess(key: ApiKey): {
  preset?: NonNullable<ApiKey["preset"]>;
  permissions?: string[];
} {
  if (key.preset) return { preset: key.preset };
  if (key.permissions?.length) return { permissions: key.permissions };
  return key.scope === "ADMIN" ? { preset: "FULL" } : {};
}

/**
 * Analytics pages → one series per metric per route. Durations are seconds. Asked for by
 * a bare app id, fal answers one row per route in each bucket, and percentiles cannot be
 * added up. The label depends only on the row, so a route keeps its series in a window
 * where the app's other routes are quiet.
 */
export function analyticsSeries(
  pages: Pick<AnalyticsPage, "time_series">[],
  endpointId: string,
): MetricSeries[] {
  const byRoute = new Map<string, Map<string, MetricSeries["points"]>>();
  for (const page of pages) {
    for (const bucket of page.time_series ?? []) {
      const ts = Date.parse(s(bucket.bucket));
      if (!Number.isFinite(ts)) continue;
      for (const row of bucket.results ?? []) {
        const id = row.endpoint_id;
        const route =
          !id || id === endpointId
            ? ""
            : id.startsWith(`${endpointId}/`)
              ? id.slice(endpointId.length + 1)
              : id;
        for (const metric of ANALYTICS_METRICS) {
          const v = Number(row[metric]);
          if (row[metric] === undefined || !Number.isFinite(v)) continue;
          const routes = byRoute.get(metric) ?? new Map<string, MetricSeries["points"]>();
          byRoute.set(metric, routes);
          const points = routes.get(route) ?? [];
          points.push({ timestamp: ts, value: v });
          routes.set(route, points);
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
  return [...byRoute.entries()].flatMap(([metric, routes]) =>
    [...routes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([route, points]) => ({
        label: route ? `${label(metric)} · ${route}` : label(metric),
        unit: metric.includes("duration") ? "s" : "requests",
        points: points.sort((a, b) => a.timestamp - b.timestamp),
      })),
  );
}

/**
 * fal: Model API endpoints the workspace uses (price, cost, analytics,
 * recent requests), Serverless apps (queue, revisions, logs, analytics),
 * Compute instances, API keys and workflows, plus billed usage and the
 * credit balance. Only a FULL key, or a legacy ADMIN one, can reach all of it.
 */
export class FalClient implements PluginClient {
  private readonly api: FalApi;

  constructor(credentials: Credentials, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("fal plugin: missing apiKey credential");
    this.api = createFalApi(apiKey, credentials["caCert"] ?? "", services?.http);
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "fal-model":
          return this.listModels(accountId);
        case "fal-app":
          return this.listApps(accountId);
        case "fal-compute-instance":
          return this.ifPermitted(() => this.listInstances(accountId));
        case "fal-api-key":
          return this.ifPermitted(() => this.listKeys(accountId));
        case "fal-workflow":
          return this.listWorkflows(accountId);
        default:
          throw new Error(`fal plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  private async ifPermitted(run: () => Promise<ResourceInstance[]>): Promise<ResourceInstance[]> {
    try {
      return await run();
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  /**
   * Endpoints with usage in the last 30 days (`GET /models/usage?expand=summary`,
   * BILLING or FULL), joined with `GET /models` metadata and `GET /models/pricing`.
   * fal's public catalogue has thousands of endpoints, so listing it all would
   * bury the ones this workspace runs.
   */
  private async listModels(accountId: string): Promise<ResourceInstance[]> {
    const start = new Date(Date.now() - USAGE_LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    let pages: ModelUsagePage[];
    try {
      pages = await allPages(
        (cursor) =>
          this.api.get("/models/usage", {
            query: { expand: "summary", start, timezone: "UTC", ...afterCursor(cursor) },
          }),
        { path: "/models/usage", key: "summary", maxPages: USAGE_SUMMARY_MAX_PAGES },
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
    const prices = new Map<string, ModelPrice>();
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const [m, p] = await Promise.all([
        call(() => this.api.get("/models", { query: { endpoint_id: chunk, limit: 50 } })).catch(
          () => ({ models: [] }),
        ),
        call(() => this.api.get("/models/pricing", { query: { endpoint_id: chunk } })).catch(
          () => ({ prices: [] }),
        ),
      ]);
      for (const x of m.models ?? []) if (x.endpoint_id) meta.set(x.endpoint_id, x);
      for (const x of p.prices ?? []) if (x.endpoint_id) prices.set(x.endpoint_id, x);
    }
    return [...totals].map(([id, t]) => {
      const md: Partial<ModelMetadata> = meta.get(id)?.metadata ?? {};
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

  /**
   * `GET /serverless/apps?expand=endpoints`, for main and for each environment recent
   * usage names, since fal's document has no route that lists environments.
   */
  private async listApps(accountId: string): Promise<ResourceInstance[]> {
    const apps = await this.readApps(await this.recentEnvironments());
    return apps.map((a) => this.mapApp(accountId, a));
  }

  /**
   * Whatever cannot name an environment leaves that environment's rows unread rather than
   * gone, so they stay. An outage or a throttle fails the type.
   */
  private async recentEnvironments(): Promise<string[]> {
    const start = new Date(Date.now() - ENVIRONMENT_LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    try {
      return environmentsOfUsage(
        await allPages(
          (cursor) =>
            this.api.get("/serverless/usage", {
              query: {
                start,
                timezone: "UTC",
                timeframe: "month",
                expand: "time_series",
                limit: 1000,
                ...afterCursor(cursor),
              },
            }),
          { path: "/serverless/usage", key: "time_series", maxPages: COST_MAX_PAGES },
        ),
      );
    } catch (err) {
      const status = statusOf(err);
      if (status !== 403 && !(status !== undefined && REFUSED_QUERY.has(status))) throw err;
      reportUnreadListPart({ idPrefixes: [""] });
      return [];
    }
  }

  /** Main first, so that an id seen twice keeps main's row. */
  private async readApps(environments: readonly string[] = []): Promise<App[]> {
    const byId = new Map<string, App>();
    for (const app of await this.readMainApps()) byId.set(app.endpoint_id, app);
    for (const environment of environments) {
      for (const app of await this.readEnvironmentApps(environment)) {
        if (!byId.has(app.endpoint_id)) byId.set(app.endpoint_id, app);
      }
    }
    return [...byId.values()];
  }

  private async readMainApps(): Promise<App[]> {
    let res: { apps?: App[] };
    try {
      res = await call(() => this.api.get("/serverless/apps", { query: { expand: "endpoints" } }));
    } catch (err) {
      if (statusOf(err) === 403 || statusOf(err) === 404) return [];
      throw err;
    }
    return requireListPage(res.apps, {
      vendor: "fal",
      path: "/serverless/apps",
      key: "apps",
    }).filter((a) => a.endpoint_id);
  }

  /**
   * Usage can name what this route does not take: its document's example is `production`,
   * and fal's own guides call the default `main`. So a refused name is no apps, and so is
   * a row from an environment other than the one asked for.
   */
  private async readEnvironmentApps(environment: string): Promise<App[]> {
    let res: { apps?: App[] };
    try {
      res = await call(() =>
        this.api.get("/serverless/apps", { query: { expand: "endpoints", environment } }),
      );
    } catch (err) {
      const status = statusOf(err);
      if (status === 403) {
        reportUnreadListPart({ idPrefixes: [""] });
        return [];
      }
      if (status !== undefined && REFUSED_QUERY.has(status)) return [];
      throw err;
    }
    return requireListPage(res.apps, { vendor: "fal", path: "/serverless/apps", key: "apps" })
      .filter((a) => a.endpoint_id && (!a.environment || a.environment === environment))
      .map((a) => appInEnvironment(a, environment));
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
    const instances = await call(() => this.api.getAll("/compute/instances", "instances"));
    return instances.filter((i) => i.id).map((i) => this.mapInstance(accountId, i));
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

  /** `GET /keys?expand=creator_info`: only that expansion names who made a key. */
  private readKeys(): Promise<ApiKey[]> {
    return call(() => this.api.getAll("/keys", "keys", { query: { expand: "creator_info" } }));
  }

  private async listKeys(accountId: string): Promise<ResourceInstance[]> {
    return (await this.readKeys())
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
            access: keyAccess(k),
            permissions: (k.permissions ?? []).join(", "),
            description: s(k.description),
            expiresAt: s(k.expires_at),
            createdAt: s(k.created_at),
            creator: s(k.creator_nickname),
          },
          { keyId: s(k.key_id) },
        ),
      );
  }

  /** `GET /workflows?limit=&cursor=` */
  private async listWorkflows(accountId: string): Promise<ResourceInstance[]> {
    const workflows = await call(() => this.api.getAll("/workflows", "workflows"));
    return workflows
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId, accountId, typeId);
      if (typeId === "fal-compute-instance") {
        return this.mapInstance(
          accountId,
          await call(() => this.api.get(`/compute/instances/${pathEncode(id)}`)),
        );
      }
      const found = (await runPluginEffect(this.listResources(typeId, accountId))).find(
        (r) => r.externalId === id,
      );
      if (!found)
        throw Object.assign(new Error(`fal plugin: ${typeId}/${id} not found`), { status: 404 });
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
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return s(r.resolvedOutputs[outputKey] ?? r.fields[outputKey]);
    });
  }

  /** Recent requests for models; queue size and revisions for apps. */
  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = resource.externalId ?? "";
      const out = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
      if (resource.resourceTypeId === "fal-model" || resource.resourceTypeId === "fal-app") {
        const reqs = await call(() =>
          resource.resourceTypeId === "fal-model"
            ? this.api.get("/models/requests/by-endpoint", {
                query: { endpoint_id: id, limit: 20, sort_by: "ended_at" },
              })
            : this.api.get("/serverless/requests/by-endpoint", {
                query: { endpoint_id: id, limit: 20, sort_by: "ended_at" },
              }),
        ).catch(() => ({ items: [] }));
        out.resolvedOutputs["__requests__"] = JSON.stringify(reqs.items ?? []);
      }
      if (resource.resourceTypeId === "fal-app") {
        const [first, ...rest] = id.split("/");
        const owner = pathEncode(first ?? "");
        const name = pathEncode(rest.join("/"));
        const [queue, revisions] = await Promise.all([
          call(() => this.api.get(`/serverless/apps/${owner}/${name}/queue`)).catch(() => ({
            queue_size: undefined,
          })),
          call(() =>
            this.api.get(`/serverless/apps/${owner}/${name}/revisions`, { query: { limit: 20 } }),
          ).catch(() => ({ revisions: [] })),
        ]);
        if (typeof queue.queue_size === "number")
          out.resolvedOutputs["__queue__"] = String(queue.queue_size);
        out.resolvedOutputs["__revisions__"] = JSON.stringify(revisions.revisions ?? []);
      }
      return out;
    });
  }

  // ------------------------------------------------------- mutations

  deleteResource(typeId: string, resourceId: string, accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId, accountId, typeId);
      if (typeId === "fal-compute-instance") {
        await call(() => this.api.delete(`/compute/instances/${pathEncode(id)}`));
        return;
      }
      if (typeId === "fal-api-key") {
        await call(() => this.api.delete(`/keys/${pathEncode(id)}`));
        return;
      }
      throw new Error(`fal plugin: ${typeId} cannot be deleted`);
    });
  }

  /** `DELETE /serverless/apps/{owner}/{name}/queue` flushes pending requests. */
  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "fal-app" && actionId === "flush-queue") {
        const [first, ...rest] = externalIdOf(resourceId, accountId, typeId).split("/");
        const owner = pathEncode(first ?? "");
        const name = pathEncode(rest.join("/"));
        await call(() => this.api.delete(`/serverless/apps/${owner}/${name}/queue`));
        return;
      }
      throw new Error(`fal plugin: unknown action "${actionId}" for ${typeId}`);
    });
  }

  /** `POST /keys`: the same alias and access. The secret is returned once. */
  exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      if (typeId !== "fal-api-key" || formatId !== "replacement-key") {
        throw new Error(`fal plugin: no credential format "${formatId}" for ${typeId}`);
      }
      const id = externalIdOf(resourceId, accountId, typeId);
      const current = (await this.readKeys()).find((k) => k.key_id === id);
      if (!current) {
        throw Object.assign(new Error(`fal plugin: ${typeId}/${id} not found`), { status: 404 });
      }
      const alias = current.alias || `infrawrench-${new Date().toISOString().slice(0, 10)}`;
      const created = await call(() =>
        this.api.post("/keys", {
          body: {
            alias,
            ...(current.description ? { description: current.description } : {}),
            ...sameAccess(current),
          },
        }),
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
    });
  }

  // ------------------------------------------------------ metrics/logs

  /**
   * `GET /models/analytics` or `/serverless/analytics` for one endpoint. fal's document:
   * a bare app id includes the app's route-level ids, and rows stay grouped under them.
   */
  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "fal-model" && resourceTypeId !== "fal-app") return [];
      const id = externalIdOf(resourceId, accountId, resourceTypeId);
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - METRICS_WINDOW_MS;
      try {
        const query = {
          endpoint_id: id,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          timezone: "UTC",
          expand: ["time_series", ...ANALYTICS_METRICS],
        };
        const pages = await allPages(
          (cursor) =>
            resourceTypeId === "fal-model"
              ? this.api.get("/models/analytics", { query: { ...query, ...afterCursor(cursor) } })
              : this.api.get("/serverless/analytics", {
                  query: { ...query, ...afterCursor(cursor) },
                }),
          {
            path: `/${resourceTypeId === "fal-model" ? "models" : "serverless"}/analytics`,
            key: "time_series",
            maxPages: ANALYTICS_MAX_PAGES,
            partial: true,
          },
        );
        return analyticsSeries(pages, id);
      } catch (err) {
        if (statusOf(err) === 403 || statusOf(err) === 404) return [];
        throw err;
      }
    });
  }

  /** `POST /serverless/logs/history?app_id=&limit=` with no label filters. */
  getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "fal-app") return { text: "", containers: [], activeContainer: "" };
      const id = externalIdOf(resourceId, accountId, typeId);
      const res = await call(() =>
        this.api.post("/serverless/logs/history", {
          query: { app_id: id, limit: Math.min(params.tailLines ?? 500, 1000) },
          body: [],
        }),
      );
      const text = (res.items ?? [])
        .slice()
        .reverse()
        .map((l) => `${s(l.timestamp)} ${s(l.level).toUpperCase()} ${s(l.message)}\n`)
        .join("");
      return { text, containers: [id], activeContainer: id };
    });
  }

  // ---------------------------------------------------------- billing

  /**
   * Billed usage: `GET /models/usage` and `GET /serverless/usage`, daily
   * buckets in UTC, `cost_total` (after discounts). BILLING or FULL.
   */
  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const end = new Date(Date.parse(`${range.toDate}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const span = { start: range.fromDate, end, timezone: "UTC" };
      const [models, serverless] = await Promise.all([
        allPages(
          (cursor) =>
            this.api.get("/models/usage", {
              query: {
                ...span,
                timeframe: "day",
                expand: ["time_series", "auth_method"],
                limit: 1000,
                ...afterCursor(cursor),
              },
            }),
          { path: "/models/usage", key: "time_series", maxPages: COST_MAX_PAGES },
        ),
        allPages(
          (cursor) =>
            this.api.get("/serverless/usage", {
              query: {
                ...span,
                timeframe: "day",
                expand: "time_series",
                limit: 1000,
                ...afterCursor(cursor),
              },
            }),
          { path: "/serverless/usage", key: "time_series", maxPages: COST_MAX_PAGES },
        ).catch((err): ServerlessUsagePage[] => {
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        }),
      ]);
      const apps = await this.readApps(environmentsOfUsage(serverless));
      return [...modelUsageRows(models, range), ...serverlessUsageRows(serverless, range, apps)];
    });
  }

  /** `GET /account/billing?expand=credits` */
  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      const res = await call(() =>
        this.api.get("/account/billing", { query: { expand: "credits" } }),
      );
      if (!res.credits || typeof res.credits.current_balance !== "number") return [];
      const currency = (res.credits.currency || "USD").toUpperCase();
      return [
        { key: currency, label: "fal credits", remaining: res.credits.current_balance, currency },
      ];
    });
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
      items = JSON.parse(r.resolvedOutputs["__requests__"] ?? "[]");
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
    const status: StatusDotNode = { kind: "status-dot", status: this.statusFor(r) };
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
              ...muted(s(f["description"])),
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
        let revisions: Partial<Revision>[] = [];
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
          subtitle: joinSubtitle("API Key", s(f["access"])),
          status,
          sections: [
            section("Key", [
              kv(
                [
                  ["Key ID", f["keyId"]],
                  ["Alias", f["alias"]],
                  ["Access", f["access"]],
                  ["Permissions", f["permissions"]],
                  ["Description", f["description"]],
                  ["Created", f["createdAt"]],
                  ["Expires", s(f["expiresAt"]) || "Never"],
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
