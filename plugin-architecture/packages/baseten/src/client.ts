import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { QuotaAccessError, withMetricsCapability } from "@infrawrench/plugin-base";
import { BasetenApi, isStatus } from "./api.js";
import { buildAutoscalingPatch } from "./autoscaling.js";
import { fetchLogs } from "./logs.js";
import {
  fetchBasetenCostData,
  fetchDeploymentUsage,
  fetchUsageSummary,
  BILLING_EARLIEST,
} from "./cost-data.js";
import {
  externalOf,
  indexInstanceTypes,
  mapChain,
  mapDeployment,
  mapEnvironment,
  mapInstanceType,
  mapModel,
  mapModelApi,
  mapSecret,
  mapTrainingJob,
  mapTrainingProject,
  money,
  parseScopedId,
  round,
  type DeploymentUsage,
  type InstanceTypeIndex,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  fetchModelApiMetrics,
  fetchModelMetrics,
  fetchTrainingJobMetrics,
} from "./metrics.js";
import {
  ENRICH_DAILY,
  ENRICH_DEPLOYMENTS,
  ENRICH_ENVIRONMENTS,
  renderBasetenDetail,
  renderBasetenSidebarItem,
  type DailyUsageRow,
} from "./render.js";
import { IDLE_WINDOW_DAYS } from "./resource-types.js";
import type {
  BasetenChain,
  BasetenDeployment,
  BasetenEnvironment,
  BasetenInstanceType,
  BasetenInstanceTypePrice,
  BasetenModel,
  BasetenModelApi,
  BasetenPagination,
  BasetenSecret,
  BasetenTeam,
  BasetenTrainingCapacity,
  BasetenTrainingJob,
  BasetenTrainingProject,
} from "./types.js";

const MODELS_TTL_MS = 60_000;
const CATALOG_TTL_MS = 10 * 60_000;
const USAGE_TTL_MS = 5 * 60_000;
const FAN_OUT = 8;

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

const enc = encodeURIComponent;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

function cached<T>(slot: Cached<T> | undefined, ttl: number, load: () => Promise<T>): Cached<T> {
  if (slot && Date.now() - slot.at < ttl) return slot;
  const value = load();
  const next = { at: Date.now(), value };
  value.catch(() => {
    next.at = 0;
  });
  return next;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
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

function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
    return out;
  } catch {
    return {};
  }
}

/**
 * Baseten plugin client. One per account (one API key). A personal key sees
 * every model the user can; a team key sees that team's models. Deployments
 * and environments are listed per model.
 */
export class BasetenClient implements PluginClient {
  readonly api: BasetenApi;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private modelsCache: Cached<BasetenModel[]> | undefined;
  private catalogCache: Cached<InstanceTypeIndex> | undefined;
  private usageCache: Cached<Map<string, DeploymentUsage> | null> | undefined;
  private teamsCache: Cached<BasetenTeam[]> | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Baseten plugin: missing apiKey credential");
    this.api = new BasetenApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  // ── Discovery ────────────────────────────────────────────────────────

  models(): Promise<BasetenModel[]> {
    this.modelsCache = cached(this.modelsCache, MODELS_TTL_MS, () =>
      this.api.request<{ models?: BasetenModel[] }>("/v1/models").then((r) => r?.models ?? []),
    );
    return this.modelsCache.value;
  }

  teams(): Promise<BasetenTeam[]> {
    this.teamsCache = cached(this.teamsCache, CATALOG_TTL_MS, () =>
      this.api
        .request<{ teams?: BasetenTeam[] }>("/v1/teams")
        .then((r) => r?.teams ?? [])
        .catch(() => []),
    );
    return this.teamsCache.value;
  }

  /** Instance types joined with their published prices; prices are optional. */
  instanceTypes(): Promise<InstanceTypeIndex> {
    this.catalogCache = cached(this.catalogCache, CATALOG_TTL_MS, async () => {
      const [types, prices] = await Promise.all([
        this.api
          .request<{ instance_types?: BasetenInstanceType[] }>("/v1/instance_types")
          .then((r) => r?.instance_types ?? [])
          .catch(() => [] as BasetenInstanceType[]),
        this.api
          .request<{ instance_types?: BasetenInstanceTypePrice[] }>("/v1/instance_type_prices")
          .then((r) => r?.instance_types ?? [])
          .catch(() => [] as BasetenInstanceTypePrice[]),
      ]);
      return indexInstanceTypes(types, prices);
    });
    return this.catalogCache.value;
  }

  /** Per-deployment usage over the idle window; null when billing is unreadable. */
  deploymentUsage(): Promise<Map<string, DeploymentUsage> | null> {
    this.usageCache = cached(this.usageCache, USAGE_TTL_MS, () =>
      fetchDeploymentUsage(this.api, IDLE_WINDOW_DAYS).catch(() => null),
    );
    return this.usageCache.value;
  }

  private invalidateModels(): void {
    this.modelsCache = undefined;
  }

  private async modelById(modelId: string): Promise<Pick<BasetenModel, "id" | "name">> {
    const models = await this.models().catch(() => []);
    return models.find((m) => m.id === modelId) ?? { id: modelId };
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "model":
        return (await this.models()).map((m) => mapModel(m, accountId));
      case "deployment": {
        const [models, index, usage] = await Promise.all([
          this.models(),
          this.instanceTypes(),
          this.deploymentUsage(),
        ]);
        const lists = await mapLimit(models, FAN_OUT, async (m) => {
          try {
            const res = await this.api.request<{ deployments?: BasetenDeployment[] }>(
              `/v1/models/${enc(m.id)}/deployments`,
            );
            return (res?.deployments ?? []).map((d) =>
              mapDeployment(d, m, accountId, index, usage),
            );
          } catch (e) {
            if (isStatus(e, 403, 404)) return [];
            throw e;
          }
        });
        return lists.flat();
      }
      case "environment": {
        const [models, index] = await Promise.all([this.models(), this.instanceTypes()]);
        const lists = await mapLimit(models, FAN_OUT, async (m) => {
          try {
            const res = await this.api.request<{ environments?: BasetenEnvironment[] }>(
              `/v1/models/${enc(m.id)}/environments`,
            );
            return (res?.environments ?? []).map((e) => mapEnvironment(e, m, accountId, index));
          } catch (e) {
            if (isStatus(e, 403, 404)) return [];
            throw e;
          }
        });
        return lists.flat();
      }
      case "chain": {
        const res = await this.api.request<{ chains?: BasetenChain[] }>("/v1/chains");
        return (res?.chains ?? []).map((c) => mapChain(c, accountId));
      }
      case "instance-type": {
        const index = await this.instanceTypes();
        const seen = new Set<string>();
        const out: ResourceInstance[] = [];
        for (const entry of index.values()) {
          if (seen.has(entry.type.id)) continue;
          seen.add(entry.type.id);
          out.push(mapInstanceType(entry.type, entry.pricePerMinute, accountId));
        }
        return out;
      }
      case "secret": {
        const res = await this.api.request<{ secrets?: BasetenSecret[] }>("/v1/secrets");
        return (res?.secrets ?? []).map((s) => mapSecret(s, accountId));
      }
      case "training-project": {
        const res = await this.api.request<{ training_projects?: BasetenTrainingProject[] }>(
          "/v1/training_projects",
        );
        return (res?.training_projects ?? []).map((p) => mapTrainingProject(p, accountId));
      }
      case "training-job": {
        const res = await this.api.request<{ training_jobs?: BasetenTrainingJob[] }>(
          "/v1/training_jobs/search",
          { method: "POST", body: {} },
        );
        return (res?.training_jobs ?? []).map((j) => mapTrainingJob(j, accountId));
      }
      case "model-api":
        return (await this.listModelApis()).map((m) => mapModelApi(m, accountId));
      default:
        throw new Error(`Baseten plugin: unknown resource type "${typeId}"`);
    }
  }

  private async listModelApis(): Promise<BasetenModelApi[]> {
    const out: BasetenModelApi[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res: { items?: BasetenModelApi[]; pagination?: BasetenPagination } | undefined =
        await this.api.request("/v1/model_apis", {
          query: { added_only: true, limit: 1000, ...(cursor ? { cursor } : {}) },
        });
      out.push(...(res?.items ?? []));
      if (!res?.pagination?.has_more || !res.pagination.cursor) break;
      cursor = res.pagination.cursor;
    }
    return out;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const external = externalOf(resourceId);
    if (typeId === "model") {
      const m = await this.api.request<BasetenModel>(`/v1/models/${enc(external)}`);
      return mapModel(m, accountId);
    }
    if (typeId === "deployment") {
      const { scope: modelId, id } = parseScopedId(resourceId);
      const [d, model, index, usage] = await Promise.all([
        this.api.request<BasetenDeployment>(`/v1/models/${enc(modelId)}/deployments/${enc(id)}`),
        this.modelById(modelId),
        this.instanceTypes(),
        this.deploymentUsage(),
      ]);
      return mapDeployment(d, model, accountId, index, usage);
    }
    if (typeId === "environment") {
      const { scope: modelId, id: name } = parseScopedId(resourceId);
      const [e, model, index] = await Promise.all([
        this.api.request<BasetenEnvironment>(
          `/v1/models/${enc(modelId)}/environments/${enc(name)}`,
        ),
        this.modelById(modelId),
        this.instanceTypes(),
      ]);
      return mapEnvironment(e, model, accountId, index);
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === external);
    if (!found) throw new Error(`Baseten plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    return resource.resolvedOutputs[outputKey] ?? "";
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const fields = { ...resource.fields };
    if (resource.resourceTypeId === "deployment") {
      const { scope: modelId, id } = parseScopedId(resource.externalId ?? resource.id);
      const [envs, daily] = await Promise.all([
        this.api
          .request<{ environments?: BasetenEnvironment[] }>(
            `/v1/models/${enc(modelId)}/environments`,
          )
          .then((r) => (r?.environments ?? []).map((e) => e.name))
          .catch(() => [] as string[]),
        this.dailyDeploymentUsage(id).catch(() => [] as DailyUsageRow[]),
      ]);
      fields[ENRICH_ENVIRONMENTS] = JSON.stringify(envs);
      if (daily.length) fields[ENRICH_DAILY] = JSON.stringify(daily);
    } else if (resource.resourceTypeId === "environment") {
      const modelId = String(
        resource.fields["modelId"] ?? parseScopedId(resource.externalId ?? resource.id).scope,
      );
      const deployments = await this.api
        .request<{ deployments?: BasetenDeployment[] }>(`/v1/models/${enc(modelId)}/deployments`)
        .then((r) => (r?.deployments ?? []).map((d) => ({ id: d.id, name: d.name || d.id })))
        .catch(() => [] as Array<{ id: string; name: string }>);
      fields[ENRICH_DEPLOYMENTS] = JSON.stringify(deployments);
    }
    return { ...resource, fields };
  }

  /** Last 14 days of billed usage for one deployment, newest first. */
  private async dailyDeploymentUsage(deploymentId: string): Promise<DailyUsageRow[]> {
    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    const from = fromDate < BILLING_EARLIEST ? BILLING_EARLIEST : fromDate;
    const summary = await fetchUsageSummary(this.api, from, to);
    const item = (summary.dedicated_usage?.breakdown ?? []).find(
      (i) =>
        i.billable_resource.kind === "MODEL_DEPLOYMENT" && i.billable_resource.id === deploymentId,
    );
    return (item?.daily ?? [])
      .map((d) => ({
        date: String(d.date).slice(0, 10),
        requests: d.inference_requests ?? 0,
        minutes: d.minutes ?? 0,
        cost: round(money(d.subtotal)),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderBasetenDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
      DEFAULT_METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderBasetenSidebarItem(resource);
  }

  // ── Create / update / delete ─────────────────────────────────────────

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    if (typeId === "environment") {
      const fromParent = parentResourceId?.includes(":model:") === true;
      const models = fromParent ? [] : await this.models().catch(() => []);
      return {
        fields: [
          ...(fromParent
            ? []
            : [
                {
                  key: "modelId",
                  label: "Model",
                  kind: "select" as const,
                  required: true,
                  options: models.map((m) => ({
                    id: m.id,
                    label: m.name || m.id,
                    ...(m.team_name ? { description: m.team_name } : {}),
                  })),
                },
              ]),
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "staging",
            description: "Lowercase letters, numbers and hyphens.",
          },
          {
            key: "minReplica",
            label: "Min Replicas",
            kind: "number",
            required: false,
            minValue: 0,
            defaultValue: "0",
          },
          {
            key: "maxReplica",
            label: "Max Replicas",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "1",
          },
          {
            key: "concurrencyTarget",
            label: "Concurrency Target",
            kind: "number",
            required: false,
            minValue: 1,
            defaultValue: "1",
          },
          {
            key: "promotionCleanup",
            label: "After Promotion",
            kind: "select",
            required: false,
            defaultValue: "SCALE_TO_ZERO",
            options: [
              { id: "SCALE_TO_ZERO", label: "Scale previous deployment to zero" },
              { id: "DEACTIVATE", label: "Deactivate previous deployment" },
              { id: "KEEP", label: "Keep previous deployment running" },
            ],
          },
        ],
      };
    }
    if (typeId === "secret") {
      const teams = await this.teams();
      return {
        fields: [
          {
            key: "name",
            label: "Name",
            kind: "text",
            required: true,
            placeholder: "hf_access_token",
          },
          { key: "value", label: "Value", kind: "password", required: true },
          ...(teams.length > 1
            ? [
                {
                  key: "teamId",
                  label: "Team",
                  kind: "select" as const,
                  required: false,
                  defaultValue: teams.find((t) => t.default)?.id ?? teams[0]!.id,
                  options: teams.map((t) => ({ id: t.id, label: t.name || t.id })),
                },
              ]
            : []),
        ],
      };
    }
    throw new Error(`Baseten plugin: cannot create "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const name = str(fields["name"]);
    if (!name) throw new Error("Baseten plugin: enter a name");
    if (typeId === "environment") {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        throw new Error("Environment names use lowercase letters, numbers and hyphens.");
      }
      const modelId = parentResourceId?.includes(":model:")
        ? externalOf(parentResourceId)
        : str(fields["modelId"]);
      if (!modelId) throw new Error("Baseten plugin: choose a model");
      const autoscaling = buildAutoscalingPatch(fields, {});
      const cleanup = str(fields["promotionCleanup"]);
      const env = await this.api.request<BasetenEnvironment>(
        `/v1/models/${enc(modelId)}/environments`,
        {
          method: "POST",
          body: {
            name,
            ...(autoscaling ? { autoscaling_settings: autoscaling } : {}),
            ...(cleanup ? { promotion_settings: { promotion_cleanup_strategy: cleanup } } : {}),
          },
        },
      );
      const [model, index] = await Promise.all([this.modelById(modelId), this.instanceTypes()]);
      return mapEnvironment(env ?? { name, model_id: modelId }, model, accountId, index);
    }
    if (typeId === "secret") {
      const value = fields["value"] ?? "";
      if (!value) throw new Error("Baseten plugin: enter the secret value");
      const teamId = str(fields["teamId"]);
      const secret = await this.api.request<BasetenSecret>(
        teamId ? `/v1/teams/${enc(teamId)}/secrets` : "/v1/secrets",
        { method: "POST", body: { name, value } },
      );
      return mapSecret(secret ?? { name }, accountId);
    }
    throw new Error(`Baseten plugin: cannot create "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "model": {
        const name = str(fields["name"]);
        if (name) {
          await this.api.request(`/v1/models/${enc(externalOf(resourceId))}`, {
            method: "PATCH",
            body: { name },
          });
          this.invalidateModels();
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "deployment": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const patch = buildAutoscalingPatch(fields, current.fields, {
          development: current.fields["isDevelopment"] === true,
        });
        if (patch) {
          const { scope: modelId, id } = parseScopedId(resourceId);
          await this.api.request(
            `/v1/models/${enc(modelId)}/deployments/${enc(id)}/autoscaling_settings`,
            { method: "PATCH", body: patch },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "environment": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const autoscaling = buildAutoscalingPatch(fields, current.fields);
        const body: Record<string, unknown> = {};
        if (autoscaling) body["autoscaling_settings"] = autoscaling;
        const promotion: Record<string, unknown> = {};
        if (fields["promotionCleanup"]) {
          promotion["promotion_cleanup_strategy"] = str(fields["promotionCleanup"]);
        }
        if (fields["rollingDeploy"] !== undefined) {
          promotion["rolling_deploy"] = fields["rollingDeploy"] === "true";
        }
        if (Object.keys(promotion).length) body["promotion_settings"] = promotion;
        if (fields["backpressurePolicy"]) {
          body["request_backpressure_settings"] = { policy: str(fields["backpressurePolicy"]) };
        }
        if (Object.keys(body).length) {
          const { scope: modelId, id: name } = parseScopedId(resourceId);
          await this.api.request(`/v1/models/${enc(modelId)}/environments/${enc(name)}`, {
            method: "PATCH",
            body,
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "secret": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const value = fields["value"] ?? "";
        if (value) {
          const teamId = await this.teamIdByName(String(current.fields["teamName"] ?? ""));
          await this.api.request(teamId ? `/v1/teams/${enc(teamId)}/secrets` : "/v1/secrets", {
            method: "POST",
            body: { name: String(current.fields["name"]), value },
          });
        }
        return current;
      }
      default:
        throw new Error(`Baseten plugin: cannot update "${typeId}"`);
    }
  }

  private async teamIdByName(teamName: string): Promise<string> {
    if (!teamName) return "";
    const teams = await this.teams();
    return teams.find((t) => t.name === teamName)?.id ?? "";
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const external = externalOf(resourceId);
    switch (typeId) {
      case "model":
        await this.api.request(`/v1/models/${enc(external)}`, { method: "DELETE" });
        this.invalidateModels();
        return;
      case "deployment": {
        const { scope: modelId, id } = parseScopedId(resourceId);
        await this.api.request(`/v1/models/${enc(modelId)}/deployments/${enc(id)}`, {
          method: "DELETE",
        });
        return;
      }
      case "environment": {
        const { scope: modelId, id: name } = parseScopedId(resourceId);
        if (name === "production") {
          throw new Error("Baseten does not allow deleting the production environment.");
        }
        await this.api.request(`/v1/models/${enc(modelId)}/environments/${enc(name)}`, {
          method: "DELETE",
        });
        return;
      }
      case "chain":
        await this.api.request(`/v1/chains/${enc(external)}`, { method: "DELETE" });
        return;
      case "secret": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const name = String(current.fields["name"]);
        const teamId = await this.teamIdByName(String(current.fields["teamName"] ?? ""));
        await this.api.request(
          teamId ? `/v1/teams/${enc(teamId)}/secrets/${enc(name)}` : `/v1/secrets/${enc(name)}`,
          { method: "DELETE" },
        );
        return;
      }
      case "training-project":
        await this.api.request(`/v1/training_projects/${enc(external)}`, { method: "DELETE" });
        return;
      case "training-job": {
        const job = await this.getResource(typeId, resourceId, accountId);
        await this.api.request(
          `/v1/training_projects/${enc(String(job.fields["projectId"]))}/jobs/${enc(external)}`,
          { method: "DELETE" },
        );
        return;
      }
      default:
        throw new Error(`Baseten plugin: cannot delete "${typeId}"`);
    }
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "deployment") {
      const { scope: modelId, id } = parseScopedId(resourceId);
      const base = `/v1/models/${enc(modelId)}/deployments/${enc(id)}`;
      switch (actionId) {
        case "activate":
        case "deactivate":
        case "retry":
          await this.api.request(`${base}/${actionId}`, { method: "POST" });
          return;
        case "promote": {
          const current = await this.getResource(typeId, resourceId, accountId);
          const path =
            current.fields["isDevelopment"] === true
              ? `/v1/models/${enc(modelId)}/deployments/development/promote`
              : `${base}/promote`;
          await this.api.request(path, {
            method: "POST",
            body: { scale_down_previous_production: true },
          });
          return;
        }
        case "scale-to-zero":
          await this.api.request(`${base}/autoscaling_settings`, {
            method: "PATCH",
            body: { min_replica: 0 },
          });
          return;
      }
    }
    if (typeId === "environment") {
      const { scope: modelId, id: name } = parseScopedId(resourceId);
      const base = `/v1/models/${enc(modelId)}/environments/${enc(name)}`;
      const paths: Record<string, string> = {
        activate: "activate",
        deactivate: "deactivate",
        "cancel-promotion": "cancel_promotion",
        "pause-promotion": "pause_promotion",
        "resume-promotion": "resume_promotion",
      };
      const suffix = paths[actionId];
      if (suffix) {
        await this.api.request(`${base}/${suffix}`, { method: "POST" });
        return;
      }
    }
    if (typeId === "training-job" && actionId === "stop") {
      const job = await this.getResource(typeId, resourceId, accountId);
      await this.api.request(
        `/v1/training_projects/${enc(String(job.fields["projectId"]))}/jobs/${enc(job.externalId ?? externalOf(job.id))}/stop`,
        { method: "POST", body: {} },
      );
      return;
    }
    throw new Error(`Baseten plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (command !== "promoteToEnvironment") {
      throw new Error(`Baseten plugin: unknown command "${command}"`);
    }
    const vals = parseFormArg(args[0]);
    const scaleDown = vals["scaleDownPrevious"] !== "false";
    let modelId: string;
    let envName: string;
    let deploymentId: string;
    if (typeId === "deployment") {
      ({ scope: modelId, id: deploymentId } = parseScopedId(resourceId));
      envName = str(vals["environment"]);
    } else if (typeId === "environment") {
      ({ scope: modelId, id: envName } = parseScopedId(resourceId));
      deploymentId = str(vals["deploymentId"]);
    } else {
      throw new Error(`Baseten plugin: cannot promote a "${typeId}"`);
    }
    if (!envName || !deploymentId) throw new Error("Baseten plugin: choose what to promote");
    await this.api.request(`/v1/models/${enc(modelId)}/environments/${enc(envName)}/promote`, {
      method: "POST",
      body: { deployment_id: deploymentId, scale_down_previous_deployment: scaleDown },
    });
    return null;
  }

  // ── Logs ─────────────────────────────────────────────────────────────

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    let path: string;
    if (typeId === "deployment") {
      const { scope: modelId, id } = parseScopedId(resourceId);
      path = `/v1/models/${enc(modelId)}/deployments/${enc(id)}/logs`;
    } else if (typeId === "environment") {
      const { scope: modelId, id: name } = parseScopedId(resourceId);
      path = `/v1/models/${enc(modelId)}/environments/${enc(name)}/logs`;
    } else if (typeId === "training-job") {
      const job = await this.getResource(typeId, resourceId, accountId);
      path = `/v1/training_projects/${enc(String(job.fields["projectId"]))}/jobs/${enc(job.externalId ?? externalOf(job.id))}/logs`;
    } else {
      throw new Error(`Baseten plugin: no logs for "${typeId}"`);
    }
    return fetchLogs(this.api, path, params.tailLines, params.container);
  }

  // ── Metrics ──────────────────────────────────────────────────────────

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    switch (resourceTypeId) {
      case "deployment": {
        const { scope: modelId, id } = parseScopedId(resourceId);
        return fetchModelMetrics(
          this.api,
          `/v1/models/${enc(modelId)}/deployments/${enc(id)}/metrics`,
          timeRange,
        );
      }
      case "environment": {
        const { scope: modelId, id: name } = parseScopedId(resourceId);
        return fetchModelMetrics(
          this.api,
          `/v1/models/${enc(modelId)}/environments/${enc(name)}/metrics`,
          timeRange,
        );
      }
      case "model-api":
        return fetchModelApiMetrics(this.api, externalOf(resourceId), timeRange);
      case "training-job": {
        const job = await this.getResource(resourceTypeId, resourceId, accountId);
        return fetchTrainingJobMetrics(
          this.api,
          String(job.fields["projectId"]),
          job.externalId ?? externalOf(job.id),
          timeRange,
        );
      }
      default:
        return [];
    }
  }

  // ── Costs and quotas ─────────────────────────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchBasetenCostData(this.api, range);
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    let res: BasetenTrainingCapacity;
    try {
      res = await this.api.request<BasetenTrainingCapacity>("/v1/training/capacity");
    } catch (e) {
      if (isStatus(e, 401, 403)) {
        throw new QuotaAccessError("Baseten refused the training GPU capacity for this API key.");
      }
      throw e;
    }
    const out: QuotaUsage[] = [];
    for (const c of res?.gpu_capacities ?? []) {
      if (!c.gpu_type || !c.limit || c.limit <= 0) continue;
      out.push({
        id: `training-gpus/${c.gpu_type}`,
        service: "Training",
        name: `Concurrent ${c.gpu_type} GPUs`,
        limit: c.limit,
        used: c.usage_count ?? 0,
        unit: "GPUs",
        adjustable: true,
      });
    }
    for (const c of res?.team_gpu_capacities ?? []) {
      if (!c.gpu_type || !c.limit || c.limit <= 0) continue;
      out.push({
        id: `training-gpus/${c.team_id ?? c.team_name}/${c.gpu_type}`,
        service: "Training",
        name: `Concurrent ${c.gpu_type} GPUs (${c.team_name || c.team_id} team)`,
        limit: c.limit,
        used: c.usage_count ?? 0,
        unit: "GPUs",
        adjustable: true,
      });
    }
    return out;
  }
}
