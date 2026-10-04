import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, externalIdOf } from "@infrawrench/plugin-base";
import type {
  BillingRates,
  BillingSummary,
  ModalApp,
  ModalAppInfo,
  ModalEnvironment,
} from "./api.js";
import {
  billingRates,
  billingSummary,
  createEnvironment,
  dashboardUrl,
  deleteEnvironment,
  deleteObject,
  environmentBillingSummary,
  getAppInfo,
  getAppTags,
  getDeploymentHistory,
  getFunction,
  getFunctionCurrentStats,
  listApps,
  listDicts,
  listEnvironments,
  listQueues,
  listSecrets,
  listVolumes,
  stopApp,
  updateEnvironment,
  workspaceName,
} from "./api.js";
import { fetchModalCostData } from "./cost-data.js";
import type { ModalContext } from "./grpc.js";
import { DEFAULT_SERVER_URL, GrpcCode, grpcCodeOf } from "./grpc.js";
import {
  mapApp,
  mapDict,
  mapEnvironment,
  mapFunction,
  mapQueue,
  mapSecret,
  mapVolume,
  mapWorkspace,
} from "./mappers.js";
import {
  COST_METRICS_WINDOW_MS,
  FUNCTION_METRICS_WINDOW_MS,
  costSeries,
  functionSeries,
  rangeOrDefault,
} from "./metrics.js";
import {
  APP_INFO_KEY,
  BILLING_NOTE_KEY,
  DEPLOYMENTS_KEY,
  FUNCTION_KEY,
  RATES_KEY,
  STATS_KEY,
  SUMMARY_KEY,
  TAGS_KEY,
  renderModalDetail,
  renderModalSidebar,
} from "./render.js";

const CACHE_TTL_MS = 30_000;
/** Bound on `AppGetInfo` calls per listing; a workspace with more deployed apps lists the newest. */
const MAX_APP_INFO = 300;
const APP_INFO_CONCURRENCY = 4;
const BILLING_NOTE =
  "Modal returns billing data to Team and Enterprise workspaces; on other plans, spend is shown in the Modal dashboard only.";

const DELETABLE = {
  volume: "volume",
  secret: "secret",
  dict: "dict",
  queue: "queue",
} as const;

function monthStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function usd(n: unknown): string {
  return typeof n === "number"
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

interface FunctionRow {
  app: ModalApp;
  info: ModalAppInfo;
}

export class ModalClient implements PluginClient {
  private readonly ctx: ModalContext;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const tokenId = (credentials["tokenId"] ?? "").trim();
    const tokenSecret = (credentials["tokenSecret"] ?? "").trim();
    if (!tokenId) throw new Error("Modal plugin: missing tokenId credential");
    if (!tokenSecret) throw new Error("Modal plugin: missing tokenSecret credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      tokenId,
      tokenSecret,
      serverUrl: DEFAULT_SERVER_URL,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
  }

  /** Memoise a read for a few seconds so one sync does not repeat it per type. */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private invalidate(): void {
    this.cache.clear();
  }

  private environments(): Promise<ModalEnvironment[]> {
    return this.cached("environments", () => listEnvironments(this.ctx));
  }

  /**
   * Environment names to list per-environment objects under. A token that may
   * not list environments still sees its default one (the empty name).
   */
  private async environmentNames(): Promise<string[]> {
    try {
      const envs = await this.environments();
      return envs.length > 0 ? envs.map((e) => e.name) : [""];
    } catch (err) {
      if (grpcCodeOf(err) === GrpcCode.PERMISSION_DENIED) return [""];
      throw err;
    }
  }

  private async perEnvironment<T>(key: string, load: (env: string) => Promise<T[]>): Promise<T[]> {
    return this.cached(key, async () => {
      const names = await this.environmentNames();
      const lists = await Promise.all(names.map((n) => load(n)));
      return lists.flat();
    });
  }

  private apps(): Promise<ModalApp[]> {
    return this.perEnvironment("apps", (env) => listApps(this.ctx, env));
  }

  /** Deployed apps with their functions (`AppGetInfo`), newest deployments first. */
  private deployedFunctions(): Promise<FunctionRow[]> {
    return this.cached("functions", async () => {
      const deployed = (await this.apps())
        .filter((a) => a.state === "deployed")
        .sort((a, b) => (b.deployedAt ?? b.createdAt ?? 0) - (a.deployedAt ?? a.createdAt ?? 0))
        .slice(0, MAX_APP_INFO);
      const rows = await mapLimited(deployed, APP_INFO_CONCURRENCY, async (app) => {
        try {
          return { app, info: await getAppInfo(this.ctx, app.appId) };
        } catch (err) {
          // An app stopped between the two calls simply has no functions now.
          if (grpcCodeOf(err) === GrpcCode.NOT_FOUND) return undefined;
          throw err;
        }
      });
      return rows.filter((r): r is FunctionRow => !!r);
    });
  }

  private async workspace(): Promise<string> {
    return this.cached("workspace", () => workspaceName(this.ctx));
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "workspace": {
        const [name, envs, summary, url] = await Promise.all([
          this.workspace(),
          this.environments().catch(() => [] as ModalEnvironment[]),
          billingSummary(this.ctx, monthStartMs()).catch(() => undefined),
          dashboardUrl(this.ctx).catch(() => ""),
        ]);
        return [mapWorkspace(accountId, name, envs.length, summary, url)];
      }
      case "environment":
        return (await this.environments()).map((e) => mapEnvironment(accountId, e));
      case "app":
        return (await this.apps()).map((a) => mapApp(accountId, a));
      case "function":
        return (await this.deployedFunctions()).flatMap(({ app, info }) =>
          info.functions.map((s) => mapFunction(accountId, "function", app, s)),
        );
      case "scheduled-function":
        return (await this.deployedFunctions()).flatMap(({ app, info }) =>
          info.functions
            .filter((s) => s.schedule)
            .map((s) => mapFunction(accountId, "scheduled-function", app, s)),
        );
      case "volume":
        return (await this.perEnvironment("volumes", (env) => listVolumes(this.ctx, env))).map(
          (v) => mapVolume(accountId, v),
        );
      case "secret":
        return (await this.perEnvironment("secrets", (env) => listSecrets(this.ctx, env))).map(
          (s) => mapSecret(accountId, s),
        );
      case "dict":
        return (await this.perEnvironment("dicts", (env) => listDicts(this.ctx, env))).map((d) =>
          mapDict(accountId, d),
        );
      case "queue":
        return (await this.perEnvironment("queues", (env) => listQueues(this.ctx, env))).map((q) =>
          mapQueue(accountId, q),
        );
      default:
        throw new Error(`Modal plugin: unknown resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  private async findListed(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) throw new Error(`Modal plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "function" || typeId === "scheduled-function") {
      return this.getFunctionResource(typeId, resourceId, accountId);
    }
    const found = await this.findListed(typeId, resourceId, accountId);
    const stash: Record<string, string> = {};
    switch (typeId) {
      case "workspace": {
        const [summary, rates] = await Promise.all([
          billingSummary(this.ctx, monthStartMs()).catch(
            () => undefined as BillingSummary | undefined,
          ),
          billingRates(this.ctx).catch(() => undefined as BillingRates | undefined),
        ]);
        if (summary) stash[SUMMARY_KEY] = JSON.stringify(summary);
        else stash[BILLING_NOTE_KEY] = BILLING_NOTE;
        if (rates) stash[RATES_KEY] = JSON.stringify(rates);
        break;
      }
      case "environment": {
        const envId = String(found.fields["environmentId"] ?? "");
        const [summary, url] = await Promise.all([
          envId
            ? environmentBillingSummary(this.ctx, monthStartMs(), envId).catch(() => undefined)
            : Promise.resolve(undefined),
          dashboardUrl(this.ctx, String(found.fields["name"] ?? "")).catch(() => ""),
        ]);
        if (summary) stash[SUMMARY_KEY] = JSON.stringify(summary);
        if (url) stash["url"] = url;
        break;
      }
      case "app": {
        const appId = found.externalId ?? "";
        const [info, tags, history] = await Promise.all([
          getAppInfo(this.ctx, appId).catch(() => undefined),
          getAppTags(this.ctx, appId).catch(() => undefined),
          getDeploymentHistory(this.ctx, appId).catch(() => undefined),
        ]);
        if (info) stash[APP_INFO_KEY] = JSON.stringify(info);
        if (tags) stash[TAGS_KEY] = JSON.stringify(tags);
        if (history) stash[DEPLOYMENTS_KEY] = JSON.stringify(history);
        break;
      }
      default:
        break;
    }
    return { ...found, resolvedOutputs: { ...found.resolvedOutputs, ...stash } };
  }

  /**
   * One function by id: its definition, its app's summary for the GPU and
   * schedule columns, and its live stats. Three calls, rather than listing
   * every deployed app to find one row.
   */
  private async getFunctionResource(
    typeId: "function" | "scheduled-function",
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const functionId = externalIdOf(resourceId);
    const [detail, stats] = await Promise.all([
      getFunction(this.ctx, functionId).catch(() => undefined),
      getFunctionCurrentStats(this.ctx, functionId).catch(() => undefined),
    ]);
    const info = detail?.appId
      ? await getAppInfo(this.ctx, detail.appId).catch(() => undefined)
      : undefined;
    const summary = info?.functions.find((f) => f.functionId === functionId);
    const found =
      info && summary
        ? mapFunction(
            accountId,
            typeId,
            { appId: info.appId, name: info.description, environment: info.environment },
            summary,
          )
        : await this.findListed(typeId, resourceId, accountId);
    const stash: Record<string, string> = {};
    if (detail) {
      stash[FUNCTION_KEY] = JSON.stringify(detail);
      if (detail.webUrl) stash["webUrl"] = detail.webUrl;
    }
    if (stats) stash[STATS_KEY] = JSON.stringify(stats);
    return { ...found, resolvedOutputs: { ...found.resolvedOutputs, ...stash } };
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Modal plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs, quotas
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    switch (resourceTypeId) {
      case "function":
      case "scheduled-function": {
        const stats = await getFunctionCurrentStats(this.ctx, externalIdOf(resourceId));
        return [
          { label: "Queued", value: String(stats.backlog) },
          { label: "Running", value: String(stats.runningInputs) },
          { label: "Containers", value: String(stats.totalTasks) },
        ];
      }
      default:
        break;
    }
    const r = await this.findListed(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    switch (resourceTypeId) {
      case "workspace":
        return [
          { label: "Billed this month", value: usd(f["monthBilled"]) },
          { label: "Metered this month", value: usd(f["monthMetered"]) },
        ];
      case "environment":
        return [
          { label: "Containers", value: String(f["currentConcurrentTasks"] ?? 0) },
          { label: "GPUs", value: String(f["currentConcurrentGpus"] ?? 0) },
          {
            label: "Spend this cycle",
            value: usd(f["cycleUsage"]),
            ...(f["spendLimitReached"] === true ? { variant: "status-error" as const } : {}),
          },
        ];
      case "app":
        return [
          {
            label: "State",
            value: String(f["state"] ?? "—"),
            variant: f["state"] === "deployed" ? "status-healthy" : "default",
          },
          { label: "Containers", value: String(f["runningTasks"] ?? 0) },
        ];
      case "queue":
        return [
          { label: "Items", value: String(f["totalSize"] ?? 0) },
          { label: "Partitions", value: String(f["partitions"] ?? 0) },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    const cost = async (filter: { environmentIds?: string[]; appIds?: string[] }) => {
      const rates = await billingRates(this.ctx).catch(() => undefined);
      try {
        return await costSeries(
          this.ctx,
          rangeOrDefault(timeRange, COST_METRICS_WINDOW_MS),
          filter,
          rates,
        );
      } catch (err) {
        const code = grpcCodeOf(err);
        if (code === GrpcCode.PERMISSION_DENIED || code === GrpcCode.FAILED_PRECONDITION) {
          throw new Error(BILLING_NOTE);
        }
        throw err;
      }
    };
    switch (resourceTypeId) {
      case "workspace":
        return cost({});
      case "environment": {
        const env = await this.findListed("environment", resourceId, accountId);
        const envId = String(env.fields["environmentId"] ?? "");
        return envId ? cost({ environmentIds: [envId] }) : [];
      }
      case "app":
        return cost({ appIds: [id] });
      case "function":
      case "scheduled-function":
        return functionSeries(this.ctx, id, rangeOrDefault(timeRange, FUNCTION_METRICS_WINDOW_MS));
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchModalCostData(this.ctx, range);
  }

  /**
   * Per-environment limits, each a used/limit pair Modal itself reports on
   * `EnvironmentListItem`: concurrent containers and GPUs where a cap is set,
   * and spend this cycle against the environment's spend limit.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    let envs: ModalEnvironment[];
    try {
      envs = await listEnvironments(this.ctx);
    } catch (err) {
      if (grpcCodeOf(err) === GrpcCode.PERMISSION_DENIED) {
        throw new QuotaAccessError(
          "This Modal token cannot list environments, so their limits cannot be read.",
          { label: "Modal environments", url: "https://modal.com/docs/guide/environments" },
        );
      }
      throw err;
    }
    const out: QuotaUsage[] = [];
    for (const e of envs) {
      const key = e.id || e.name;
      if (e.maxConcurrentTasks !== undefined && e.maxConcurrentTasks > 0) {
        out.push({
          id: `${key}:concurrent-containers`,
          service: "Environments",
          name: `Concurrent containers (${e.name})`,
          limit: e.maxConcurrentTasks,
          used: e.currentConcurrentTasks,
          unit: "containers",
          adjustable: true,
        });
      }
      if (e.maxConcurrentGpus !== undefined && e.maxConcurrentGpus > 0) {
        out.push({
          id: `${key}:concurrent-gpus`,
          service: "Environments",
          name: `Concurrent GPUs (${e.name})`,
          limit: e.maxConcurrentGpus,
          used: e.currentConcurrentGpus,
          unit: "GPUs",
          adjustable: true,
        });
      }
      if (e.effectiveSpendLimit > 0) {
        out.push({
          id: `${key}:cycle-spend`,
          service: "Billing",
          name: `Spend this cycle (${e.name})`,
          limit: e.effectiveSpendLimit,
          used: e.currentCycleUsage,
          unit: "USD",
          adjustable: true,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Create / update / delete / actions
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId !== "environment") {
      throw new Error(`Modal plugin: cannot create "${typeId}" from Infrawrench`);
    }
    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          placeholder: "staging",
          description: "Letters, numbers, dashes and underscores.",
        },
        {
          key: "webhookSuffix",
          label: "Web Endpoint Suffix",
          kind: "text",
          required: false,
          description:
            "Optional. Added to the URLs of this environment's web endpoints; Modal picks one when left empty.",
        },
        {
          key: "maxConcurrentTasks",
          label: "Max Concurrent Containers",
          kind: "number",
          required: false,
          description: "Optional cap on containers running at once.",
        },
        {
          key: "maxConcurrentGpus",
          label: "Max Concurrent GPUs",
          kind: "number",
          required: false,
          description: "Optional cap on GPUs in use at once.",
        },
      ],
    };
  }

  private limitsPatch(fields: Record<string, string>): {
    webhookSuffix?: string;
    maxConcurrentTasks?: number;
    maxConcurrentGpus?: number;
  } {
    const patch: {
      webhookSuffix?: string;
      maxConcurrentTasks?: number;
      maxConcurrentGpus?: number;
    } = {};
    const suffix = (fields["webhookSuffix"] ?? "").trim();
    if (suffix) patch.webhookSuffix = suffix;
    for (const key of ["maxConcurrentTasks", "maxConcurrentGpus"] as const) {
      const raw = (fields[key] ?? "").trim();
      if (!raw) continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("Concurrency limits must be whole numbers of at least 1.");
      }
      patch[key] = n;
    }
    return patch;
  }

  private async findEnvironment(accountId: string, name: string): Promise<ResourceInstance> {
    this.invalidate();
    const env = (await this.environments()).find((e) => e.name === name);
    if (!env) throw new Error(`Modal plugin: environment "${name}" not found after saving`);
    return mapEnvironment(accountId, env);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "environment") {
      throw new Error(`Modal plugin: cannot create "${typeId}" from Infrawrench`);
    }
    const name = (fields["name"] ?? "").trim();
    if (!name) throw new Error("An environment needs a name.");
    const patch = this.limitsPatch(fields);
    await createEnvironment(this.ctx, name);
    if (Object.keys(patch).length > 0) await updateEnvironment(this.ctx, name, patch);
    return this.findEnvironment(accountId, name);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId !== "environment") {
      throw new Error(`Modal plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    const current = await this.findListed("environment", resourceId, accountId);
    const currentName = String(current.fields["name"] ?? "");
    for (const key of ["maxConcurrentTasks", "maxConcurrentGpus"]) {
      if (key in fields && !(fields[key] ?? "").trim() && current.fields[key] !== undefined) {
        throw new Error(
          "Modal's API cannot remove a concurrency cap once set. Enter a higher limit instead, or remove the cap in the Modal dashboard.",
        );
      }
    }
    const patch = {
      ...this.limitsPatch(fields),
      ...("name" in fields &&
      (fields["name"] ?? "").trim() &&
      fields["name"]!.trim() !== currentName
        ? { name: fields["name"]!.trim() }
        : {}),
    };
    if (Object.keys(patch).length > 0) await updateEnvironment(this.ctx, currentName, patch);
    return this.findEnvironment(accountId, patch.name ?? currentName);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    if (typeId === "environment") {
      const env = await this.findListed("environment", resourceId, accountId);
      await deleteEnvironment(this.ctx, String(env.fields["name"] ?? ""));
      this.invalidate();
      return;
    }
    const kind = DELETABLE[typeId as keyof typeof DELETABLE];
    if (!kind) throw new Error(`Modal plugin: "${typeId}" cannot be deleted from Infrawrench`);
    await deleteObject(this.ctx, kind, externalIdOf(resourceId));
    this.invalidate();
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === "app" && actionId === "stop") {
      await stopApp(this.ctx, externalIdOf(resourceId));
      this.invalidate();
      return;
    }
    throw new Error(`Modal plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderModalDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderModalSidebar(resource);
  }
}
