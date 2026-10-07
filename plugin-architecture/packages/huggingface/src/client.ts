import type {
  ChatMessage,
  ChatStreamEvent,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CredentialExport,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { streamOpenAiSseChat } from "@infrawrench/plugin-base";
import {
  CATALOG_BASE,
  ENDPOINTS_BASE,
  HUB_BASE,
  ROUTER_BASE,
  enc,
  encRepo,
  hfJson,
  hfPaginate,
  statusOf,
  type HfContext,
} from "./http.js";
import {
  externalIdOf,
  mapEndpoint,
  mapJob,
  mapMemberToken,
  mapProviderModel,
  mapRepo,
  mapScheduledJob,
  mapServiceAccount,
  mapSpace,
  mapWebhook,
  pickableComputes,
} from "./mappers.js";
import { buildCreateConfig } from "./create-config.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./constants.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { endpointMetricSeries } from "./metrics.js";
import { inferenceUsageRows, jobsUsageRows } from "./cost.js";
import type {
  AllGraphs,
  CatalogList,
  Endpoint,
  EndpointList,
  HardwareFlavor,
  InferenceUsagePeriod,
  Job,
  JobsUsage,
  LogEntry,
  MemberToken,
  RepoInfo,
  Replicas,
  RouterModels,
  ScheduledJob,
  ServiceAccount,
  SpaceKeyEntry,
  VendorQuotas,
  Vendors,
  Webhook,
  WhoAmI,
  ZeroGpuQuota,
} from "./wire.js";

const MODEL_EXPAND = [
  "private",
  "gated",
  "disabled",
  "downloads",
  "likes",
  "pipeline_tag",
  "library_name",
  "lastModified",
  "createdAt",
  "usedStorage",
];
const DATASET_EXPAND = [
  "private",
  "gated",
  "disabled",
  "downloads",
  "likes",
  "lastModified",
  "createdAt",
  "usedStorage",
];
const SPACE_EXPAND = [
  "private",
  "sdk",
  "likes",
  "lastModified",
  "createdAt",
  "usedStorage",
  "runtime",
  "subdomain",
  "cardData",
];

const CACHE_MS = 5 * 60 * 1000;

function expandQuery(fields: string[]): string {
  return fields.map((f) => `expand[]=${encodeURIComponent(f)}`).join("&");
}

function parseForm(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed))
      out[k] = v === undefined || v === null ? "" : String(v);
    return out;
  } catch {
    return {};
  }
}

function intOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Hugging Face plugin client: Hub repositories, Spaces, Jobs, Inference
 * Endpoints, Inference Providers, organization service accounts and member
 * tokens, webhooks, usage-based cost and quotas.
 */
export class HuggingFaceClient implements PluginClient {
  private readonly ctx: HfContext;
  private readonly configuredNamespace: string;
  private whoamiCache?: { at: number; value: WhoAmI };
  private vendorsCache?: { at: number; value: Vendors };

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("Hugging Face plugin: missing apiToken credential");
    this.ctx = {
      token,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.configuredNamespace = (credentials["namespace"] ?? "").trim();
  }

  // ------------------------------------------------------------ identity

  /** `GET /api/whoami-v2`: the token's user, orgs and plan. */
  async whoami(): Promise<WhoAmI> {
    if (this.whoamiCache && Date.now() - this.whoamiCache.at < CACHE_MS) {
      return this.whoamiCache.value;
    }
    const value = await hfJson<WhoAmI>(this.ctx, `${HUB_BASE}/api/whoami-v2`);
    this.whoamiCache = { at: Date.now(), value };
    return value;
  }

  /** The user or organization this account manages. Defaults to the token's user. */
  async namespace(): Promise<string> {
    if (this.configuredNamespace) return this.configuredNamespace;
    const me = await this.whoami();
    if (!me.name) throw new Error("Hugging Face plugin: could not resolve the token's user");
    return me.name;
  }

  /** True when the namespace is an organization rather than the token's user. */
  async isOrgNamespace(): Promise<boolean> {
    const ns = await this.namespace();
    const me = await this.whoami();
    if (me.name === ns) return false;
    return (me.orgs ?? []).some((o) => o.name === ns) || Boolean(this.configuredNamespace);
  }

  /** `GET /v2/provider/{namespace}`: vendors, regions and computes with prices. */
  private async vendors(): Promise<Vendors> {
    if (this.vendorsCache && Date.now() - this.vendorsCache.at < CACHE_MS) {
      return this.vendorsCache.value;
    }
    const ns = await this.namespace();
    let value: Vendors;
    try {
      value = await hfJson<Vendors>(this.ctx, `${ENDPOINTS_BASE}/v2/provider/${enc(ns)}`);
    } catch (err) {
      // The public catalogue has the same shape, minus per-namespace quota.
      if (statusOf(err) !== 401 && statusOf(err) !== 403) throw err;
      value = await hfJson<Vendors>(this.ctx, `${ENDPOINTS_BASE}/v2/provider`);
    }
    this.vendorsCache = { at: Date.now(), value };
    return value;
  }

  // ------------------------------------------------------------- listing

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "hf-inference-endpoint":
        return this.listEndpoints(accountId);
      case "hf-model":
        return this.listRepos(accountId, "model");
      case "hf-dataset":
        return this.listRepos(accountId, "dataset");
      case "hf-space":
        return this.listSpaces(accountId);
      case "hf-job":
        return this.listJobs(accountId);
      case "hf-scheduled-job":
        return this.listScheduledJobs(accountId);
      case "hf-provider-model":
        return this.listProviderModels(accountId);
      case "hf-service-account":
        return this.listServiceAccounts(accountId);
      case "hf-member-token":
        return this.listMemberTokens(accountId);
      case "hf-webhook":
        return this.listWebhooks(accountId);
      default:
        throw new Error(`Hugging Face plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * `GET /v2/endpoint/{namespace}?limit=&cursor=`. A namespace without
   * Inference Endpoints billing set up answers 401/403; that reads as "no
   * endpoints", not as a broken account.
   */
  private async listEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const items: Endpoint[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 50; page++) {
        const qs = new URLSearchParams({ limit: "100" });
        if (cursor) qs.set("cursor", cursor);
        const res = await hfJson<EndpointList>(
          this.ctx,
          `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}?${qs.toString()}`,
        );
        items.push(...(res.items ?? []));
        cursor = res.nextCursor ?? undefined;
        if (!cursor || (res.items ?? []).length === 0) break;
      }
    } catch (err) {
      if (statusOf(err) === 401 || statusOf(err) === 403) return [];
      throw err;
    }
    const vendors = await this.vendors().catch(() => undefined);
    return items.filter((e) => e.name).map((e) => mapEndpoint(accountId, e, vendors, ns));
  }

  /** `GET /api/{models|datasets}?author={namespace}&expand[]=…`, paginated by Link header. */
  private async listRepos(
    accountId: string,
    kind: "model" | "dataset",
  ): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const path = kind === "model" ? "models" : "datasets";
    const expand = kind === "model" ? MODEL_EXPAND : DATASET_EXPAND;
    const repos = await hfPaginate<RepoInfo>(
      this.ctx,
      `${HUB_BASE}/api/${path}?author=${enc(ns)}&limit=1000&${expandQuery(expand)}`,
    );
    return repos.filter((r) => r.id).map((r) => mapRepo(accountId, kind, r));
  }

  /** `GET /api/spaces?author={namespace}&expand[]=runtime…` */
  private async listSpaces(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const repos = await hfPaginate<RepoInfo>(
      this.ctx,
      `${HUB_BASE}/api/spaces?author=${enc(ns)}&limit=1000&${expandQuery(SPACE_EXPAND)}`,
    );
    return repos.filter((r) => r.id).map((r) => mapSpace(accountId, r));
  }

  /** `GET /api/jobs/{namespace}` */
  private async listJobs(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const jobs = await hfJson<Job[]>(this.ctx, `${HUB_BASE}/api/jobs/${enc(ns)}`).catch((err) => {
      if (statusOf(err) === 403) return [] as Job[];
      throw err;
    });
    return (jobs ?? []).filter((j) => j.id).map((j) => mapJob(accountId, j));
  }

  /** `GET /api/scheduled-jobs/{namespace}` */
  private async listScheduledJobs(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const jobs = await hfJson<ScheduledJob[]>(
      this.ctx,
      `${HUB_BASE}/api/scheduled-jobs/${enc(ns)}`,
    ).catch((err) => {
      if (statusOf(err) === 403) return [] as ScheduledJob[];
      throw err;
    });
    return (jobs ?? []).filter((j) => j.id).map((j) => mapScheduledJob(accountId, j));
  }

  /** `GET https://router.huggingface.co/v1/models` */
  private async listProviderModels(accountId: string): Promise<ResourceInstance[]> {
    const res = await hfJson<RouterModels>(this.ctx, `${ROUTER_BASE}/models`);
    return (res.data ?? []).filter((m) => m.id).map((m) => mapProviderModel(accountId, m));
  }

  /**
   * `GET /api/organizations/{name}/service-accounts`. Users have none, and
   * orgs below Team/Enterprise (or tokens without the permission) answer
   * 401/403/404, all of which mean "nothing to show here".
   */
  private async listServiceAccounts(accountId: string): Promise<ResourceInstance[]> {
    if (!(await this.isOrgNamespace())) return [];
    const ns = await this.namespace();
    try {
      const list = await hfJson<ServiceAccount[]>(
        this.ctx,
        `${HUB_BASE}/api/organizations/${enc(ns)}/service-accounts`,
      );
      return (list ?? []).filter((s) => s._id).map((s) => mapServiceAccount(accountId, s));
    } catch (err) {
      if ([401, 402, 403, 404].includes(statusOf(err) ?? 0)) return [];
      throw err;
    }
  }

  /** `GET /api/organizations/{name}/settings/tokens` (Team/Enterprise, org admins). */
  private async listMemberTokens(accountId: string): Promise<ResourceInstance[]> {
    if (!(await this.isOrgNamespace())) return [];
    const ns = await this.namespace();
    try {
      const list = await hfJson<MemberToken[]>(
        this.ctx,
        `${HUB_BASE}/api/organizations/${enc(ns)}/settings/tokens`,
      );
      return (list ?? []).filter((t) => t._id).map((t) => mapMemberToken(accountId, t));
    } catch (err) {
      if ([401, 402, 403, 404].includes(statusOf(err) ?? 0)) return [];
      throw err;
    }
  }

  /** `GET /api/settings/webhooks`: the token user's webhooks (not per-org). */
  private async listWebhooks(accountId: string): Promise<ResourceInstance[]> {
    try {
      const list = await hfJson<Webhook[]>(this.ctx, `${HUB_BASE}/api/settings/webhooks`);
      return (list ?? []).filter((w) => w.id).map((w) => mapWebhook(accountId, w));
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  // ----------------------------------------------------------------- get

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId, accountId, typeId);
    const ns = await this.namespace();
    switch (typeId) {
      case "hf-inference-endpoint": {
        const endpoint = await hfJson<Endpoint>(
          this.ctx,
          `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(id)}`,
        );
        const vendors = await this.vendors().catch(() => undefined);
        return mapEndpoint(accountId, endpoint, vendors, ns);
      }
      case "hf-model":
      case "hf-dataset": {
        const kind = typeId === "hf-model" ? "model" : "dataset";
        const expand = kind === "model" ? MODEL_EXPAND : DATASET_EXPAND;
        const repo = await hfJson<RepoInfo>(
          this.ctx,
          `${HUB_BASE}/api/${kind}s/${encRepo(id)}?${expandQuery(expand)}`,
        );
        return mapRepo(accountId, kind, { ...repo, id: repo.id ?? id });
      }
      case "hf-space": {
        const repo = await hfJson<RepoInfo>(
          this.ctx,
          `${HUB_BASE}/api/spaces/${encRepo(id)}?${expandQuery(SPACE_EXPAND)}`,
        );
        return mapSpace(accountId, { ...repo, id: repo.id ?? id });
      }
      case "hf-job": {
        const job = await hfJson<Job>(this.ctx, `${HUB_BASE}/api/jobs/${enc(ns)}/${enc(id)}`);
        return mapJob(accountId, job);
      }
      case "hf-scheduled-job": {
        const job = await hfJson<ScheduledJob>(
          this.ctx,
          `${HUB_BASE}/api/scheduled-jobs/${enc(ns)}/${enc(id)}`,
        );
        return mapScheduledJob(accountId, job);
      }
      case "hf-service-account": {
        const sa = await hfJson<ServiceAccount>(
          this.ctx,
          `${HUB_BASE}/api/organizations/${enc(ns)}/service-accounts/${enc(id)}`,
        );
        const mapped = mapServiceAccount(accountId, sa);
        mapped.resolvedOutputs["__tokens__"] = JSON.stringify(sa.accessTokens ?? []);
        return mapped;
      }
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.externalId === id || r.id === resourceId);
        if (!found) {
          throw Object.assign(
            new Error(`Hugging Face plugin: resource ${typeId}/${id} not found`),
            { status: 404 },
          );
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
    if (outputKey === "baseUrl") return ROUTER_BASE;
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey] ?? resource.fields[outputKey];
    return value === undefined || value === null ? "" : String(value);
  }

  /**
   * Extra reads for the detail page: an endpoint's hardware alternatives and
   * replicas, a Space's secrets, variables and hardware menu, a service
   * account's tokens. Stashed under `__…__` outputs because `renderDetail`
   * is synchronous.
   */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const ns = await this.namespace();
    const out = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
    if (resource.resourceTypeId === "hf-inference-endpoint") {
      const name = String(resource.fields["name"] ?? resource.externalId ?? "");
      const [vendors, replicas] = await Promise.all([
        this.vendors().catch(() => undefined),
        hfJson<Replicas>(
          this.ctx,
          `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(name)}/replica`,
        ).catch(() => ({ items: [] }) as Replicas),
      ]);
      const computes = pickableComputes(
        vendors,
        String(resource.fields["vendor"] ?? ""),
        String(resource.fields["region"] ?? ""),
      );
      out.resolvedOutputs["__computes__"] = JSON.stringify(computes);
      out.resolvedOutputs["__replicas__"] = JSON.stringify(replicas.items ?? []);
    } else if (resource.resourceTypeId === "hf-space") {
      const repo = resource.externalId ?? "";
      const [secrets, variables, hardware] = await Promise.all([
        hfJson<Record<string, SpaceKeyEntry>>(
          this.ctx,
          `${HUB_BASE}/api/spaces/${encRepo(repo)}/secrets`,
        ).catch(() => ({})),
        hfJson<Record<string, SpaceKeyEntry>>(
          this.ctx,
          `${HUB_BASE}/api/spaces/${encRepo(repo)}/variables`,
        ).catch(() => ({})),
        this.spaceHardware().catch(() => [] as HardwareFlavor[]),
      ]);
      out.resolvedOutputs["__secrets__"] = JSON.stringify(Object.values(secrets ?? {}));
      out.resolvedOutputs["__variables__"] = JSON.stringify(Object.values(variables ?? {}));
      out.resolvedOutputs["__hardware__"] = JSON.stringify(hardware);
    } else if (
      resource.resourceTypeId === "hf-service-account" &&
      !out.resolvedOutputs["__tokens__"]
    ) {
      const sa = await hfJson<ServiceAccount>(
        this.ctx,
        `${HUB_BASE}/api/organizations/${enc(ns)}/service-accounts/${enc(resource.externalId ?? "")}`,
      );
      out.resolvedOutputs["__tokens__"] = JSON.stringify(sa.accessTokens ?? []);
    }
    return out;
  }

  /** `GET /api/spaces/hardware`: public list of Space flavors with per-minute prices. */
  async spaceHardware(): Promise<HardwareFlavor[]> {
    return (await hfJson<HardwareFlavor[]>(this.ctx, `${HUB_BASE}/api/spaces/hardware`)) ?? [];
  }

  /** `GET /api/jobs/hardware`: Jobs flavors with per-minute prices. */
  async jobHardware(): Promise<HardwareFlavor[]> {
    return (await hfJson<HardwareFlavor[]>(this.ctx, `${HUB_BASE}/api/jobs/hardware`)) ?? [];
  }

  // -------------------------------------------------------------- create

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    const ns = await this.namespace();
    switch (typeId) {
      case "hf-inference-endpoint": {
        const [vendors, catalog, ownModels, trending] = await Promise.all([
          this.vendors().catch(() => ({ vendors: [] }) as Vendors),
          hfJson<CatalogList>(this.ctx, `${CATALOG_BASE}/list`).catch(() => ({ items: [] })),
          hfJson<RepoInfo[]>(
            this.ctx,
            `${HUB_BASE}/api/models?author=${enc(ns)}&limit=200&${expandQuery(["pipeline_tag"])}`,
          ).catch(() => [] as RepoInfo[]),
          hfJson<RepoInfo[]>(
            this.ctx,
            `${HUB_BASE}/api/models?sort=trendingScore&limit=50&${expandQuery(["pipeline_tag"])}`,
          ).catch(() => [] as RepoInfo[]),
        ]);
        return buildCreateConfig("hf-inference-endpoint", {
          vendors,
          catalog,
          ownModels,
          trending,
        });
      }
      case "hf-space":
        return buildCreateConfig("hf-space", {
          spaceHardware: await this.spaceHardware().catch(() => []),
          namespace: ns,
        });
      case "hf-job":
      case "hf-scheduled-job": {
        const [hardware, spaces] = await Promise.all([
          this.jobHardware().catch(() => [] as HardwareFlavor[]),
          hfJson<RepoInfo[]>(this.ctx, `${HUB_BASE}/api/spaces?author=${enc(ns)}&limit=200`).catch(
            () => [] as RepoInfo[],
          ),
        ]);
        return buildCreateConfig(typeId, { jobHardware: hardware, ownSpaces: spaces });
      }
      case "hf-model":
      case "hf-dataset":
      case "hf-service-account":
        return buildCreateConfig(typeId, { namespace: ns });
      default:
        throw new Error(`Hugging Face plugin: ${typeId} cannot be created`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const ns = await this.namespace();
    const isOrg = await this.isOrgNamespace();
    switch (typeId) {
      case "hf-inference-endpoint":
        return this.createEndpoint(accountId, ns, fields);
      case "hf-model":
      case "hf-dataset":
      case "hf-space": {
        const kind =
          typeId === "hf-model" ? "model" : typeId === "hf-dataset" ? "dataset" : "space";
        const name = (fields["name"] ?? "").trim();
        if (!name) throw new Error("Hugging Face plugin: a repository name is required");
        const body: Record<string, unknown> = {
          name,
          type: kind,
          ...(isOrg ? { organization: ns } : {}),
        };
        const visibility = fields["visibility"] || "public";
        if (kind === "space") {
          body["visibility"] = visibility;
          body["sdk"] = fields["sdk"] || "gradio";
          if (fields["hardware"]) body["hardware"] = fields["hardware"];
          if (fields["shortDescription"]) body["short_description"] = fields["shortDescription"];
          const sleep = intOrUndefined(fields["sleepTimeSeconds"]);
          if (sleep !== undefined && fields["hardware"] && fields["hardware"] !== "cpu-basic") {
            body["sleepTimeSeconds"] = sleep;
          }
        } else {
          body["private"] = visibility === "private";
        }
        if (fields["license"]) body["license"] = fields["license"];
        if (fields["region"]) body["region"] = fields["region"];
        // https://huggingface.co/.well-known/openapi.json: POST /api/repos/create
        await hfJson(this.ctx, `${HUB_BASE}/api/repos/create`, { method: "POST", body });
        const repoId = `${ns}/${name}`;
        return this.getResource(typeId, `${accountId}:${typeId}:${repoId}`, accountId);
      }
      case "hf-job": {
        const job = await hfJson<Job>(this.ctx, `${HUB_BASE}/api/jobs/${enc(ns)}`, {
          method: "POST",
          body: jobSpecFrom(fields),
        });
        return mapJob(accountId, job);
      }
      case "hf-scheduled-job": {
        const schedule = (fields["schedule"] ?? "").trim();
        if (!schedule) throw new Error("Hugging Face plugin: a schedule is required");
        const job = await hfJson<ScheduledJob>(
          this.ctx,
          `${HUB_BASE}/api/scheduled-jobs/${enc(ns)}`,
          {
            method: "POST",
            body: {
              jobSpec: jobSpecFrom(fields),
              schedule,
              suspend: false,
              concurrency: fields["concurrency"] === "true",
            },
          },
        );
        return mapScheduledJob(accountId, job);
      }
      case "hf-service-account": {
        if (!isOrg) {
          throw new Error(
            "Hugging Face plugin: service accounts belong to organizations. Point this account at an organization namespace.",
          );
        }
        const created = await hfJson<ServiceAccount & { fullname?: string }>(
          this.ctx,
          `${HUB_BASE}/api/organizations/${enc(ns)}/service-accounts`,
          {
            method: "POST",
            body: {
              name: (fields["name"] ?? "").trim(),
              ...(fields["description"] ? { description: fields["description"] } : {}),
            },
          },
        );
        return mapServiceAccount(accountId, {
          ...created,
          name: created.name ?? created.fullname ?? fields["name"] ?? "",
        });
      }
      default:
        throw new Error(`Hugging Face plugin: ${typeId} cannot be created`);
    }
  }

  /**
   * Two ways to create an endpoint:
   * - from the Inference Catalog: `POST endpoints.huggingface.co/api/v1/catalog/recipe/{id}/deploy`,
   *   which picks a tested engine and hardware for the model;
   * - custom: `POST /v2/endpoint/{namespace}` with the chosen compute.
   */
  private async createEndpoint(
    accountId: string,
    ns: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const name = (fields["name"] ?? "").trim();
    if (!/^[a-z0-9-]{1,32}$/.test(name)) {
      throw new Error(
        "Hugging Face plugin: endpoint names are 1 to 32 lowercase letters, digits or hyphens",
      );
    }
    if ((fields["source"] ?? "catalog") === "catalog") {
      const recipe = fields["recipe"];
      if (!recipe) throw new Error("Hugging Face plugin: pick a model from the catalog");
      const res = await hfJson<{ endpoint?: Endpoint }>(
        this.ctx,
        `${CATALOG_BASE}/recipe/${enc(recipe)}/deploy`,
        { method: "POST", body: { namespace: ns, config: { name } } },
      );
      return mapEndpoint(accountId, res.endpoint ?? { name }, undefined, ns);
    }

    const repository =
      fields["repository"] === "__other__"
        ? (fields["repositoryOther"] ?? "").trim()
        : (fields["repository"] ?? "").trim();
    if (!repository) throw new Error("Hugging Face plugin: pick the model to serve");
    const vendors = await this.vendors();
    const computeId = fields["compute"] ?? "";
    let chosen:
      { vendor: string; region: string; compute: import("./wire.js").Compute } | undefined;
    for (const v of vendors.vendors ?? []) {
      for (const r of v.regions ?? []) {
        const hit = (r.computes ?? []).find((c) => c.id === computeId);
        if (hit) chosen = { vendor: String(v.name), region: String(r.name), compute: hit };
      }
    }
    if (!chosen) throw new Error("Hugging Face plugin: pick the hardware to run on");

    const image = fields["containerImage"]?.trim()
      ? { custom: { url: fields["containerImage"].trim() } }
      : { huggingface: {} };
    const minReplica = intOrUndefined(fields["minReplica"]) ?? 0;
    const body: Record<string, unknown> = {
      name,
      type: fields["type"] || "authenticated",
      provider: { vendor: chosen.vendor, region: chosen.region },
      compute: {
        accelerator: chosen.compute.accelerator,
        instanceType: chosen.compute.instanceType,
        instanceSize: chosen.compute.instanceSize,
        scaling: {
          minReplica,
          maxReplica: Math.max(intOrUndefined(fields["maxReplica"]) ?? 1, 1),
          ...(minReplica === 0
            ? { scaleToZeroTimeout: intOrUndefined(fields["scaleToZeroTimeout"]) ?? 15 }
            : {}),
        },
      },
      model: {
        repository,
        framework: "pytorch",
        image,
        ...(fields["task"] ? { task: fields["task"] } : {}),
        ...(fields["revision"]?.trim() ? { revision: fields["revision"].trim() } : {}),
      },
      ...(fields["tags"]?.trim() ? { tags: splitList(fields["tags"]) } : {}),
    };
    const created = await hfJson<Endpoint>(this.ctx, `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}`, {
      method: "POST",
      body,
    });
    return mapEndpoint(accountId, created, vendors, ns);
  }

  // -------------------------------------------------------------- update

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId, accountId, typeId);
    const ns = await this.namespace();
    switch (typeId) {
      case "hf-inference-endpoint": {
        // https://api.endpoints.huggingface.cloud/openapi.json: PUT /v2/endpoint/{ns}/{name}
        const scaling: Record<string, number> = {};
        const min = intOrUndefined(fields["minReplica"]);
        const max = intOrUndefined(fields["maxReplica"]);
        const timeout = intOrUndefined(fields["scaleToZeroTimeout"]);
        if (min !== undefined) scaling["minReplica"] = min;
        if (max !== undefined) scaling["maxReplica"] = max;
        if (timeout !== undefined) scaling["scaleToZeroTimeout"] = timeout;
        const body: Record<string, unknown> = {};
        if (Object.keys(scaling).length) body["compute"] = { scaling };
        if (fields["type"]) body["type"] = fields["type"];
        if (fields["tags"] !== undefined) body["tags"] = splitList(fields["tags"]);
        const model: Record<string, unknown> = {};
        if (fields["repository"]) model["repository"] = fields["repository"];
        if (fields["revision"] !== undefined) model["revision"] = fields["revision"] || null;
        if (Object.keys(model).length) body["model"] = model;
        const updated = await hfJson<Endpoint>(
          this.ctx,
          `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(id)}`,
          { method: "PUT", body },
        );
        return mapEndpoint(accountId, updated, await this.vendors().catch(() => undefined), ns);
      }
      case "hf-model":
      case "hf-dataset":
      case "hf-space": {
        const kind =
          typeId === "hf-model" ? "models" : typeId === "hf-dataset" ? "datasets" : "spaces";
        const body: Record<string, unknown> = {};
        if (fields["visibility"]) {
          if (kind === "spaces") body["visibility"] = fields["visibility"];
          else body["private"] = fields["visibility"] === "private";
        }
        if (fields["gated"] !== undefined && kind !== "spaces") {
          body["gated"] =
            fields["gated"] === "auto" || fields["gated"] === "manual" ? fields["gated"] : false;
        }
        if (fields["discussionsDisabled"] !== undefined) {
          body["discussionsDisabled"] = fields["discussionsDisabled"] === "true";
        }
        // PUT /api/{models|datasets|spaces}/{namespace}/{repo}/settings
        await hfJson(this.ctx, `${HUB_BASE}/api/${kind}/${encRepo(id)}/settings`, {
          method: "PUT",
          body,
        });
        const fresh = await this.getResource(typeId, resourceId, accountId);
        if (fields["discussionsDisabled"] !== undefined) {
          fresh.fields["discussionsDisabled"] = fields["discussionsDisabled"] === "true";
        }
        return fresh;
      }
      case "hf-scheduled-job": {
        if (fields["schedule"]) {
          // POST /api/scheduled-jobs/{namespace}/{id}/schedule
          const job = await hfJson<ScheduledJob>(
            this.ctx,
            `${HUB_BASE}/api/scheduled-jobs/${enc(ns)}/${enc(id)}/schedule`,
            { method: "POST", body: { schedule: fields["schedule"].trim() } },
          );
          return mapScheduledJob(accountId, job);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Hugging Face plugin: ${typeId} cannot be edited`);
    }
  }

  // -------------------------------------------------------------- delete

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    const id = externalIdOf(resourceId, accountId, typeId);
    const ns = await this.namespace();
    switch (typeId) {
      case "hf-inference-endpoint":
        await hfJson(this.ctx, `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(id)}`, {
          method: "DELETE",
        });
        return;
      case "hf-model":
      case "hf-dataset":
      case "hf-space": {
        const [owner, ...rest] = id.split("/");
        const name = rest.join("/");
        const type =
          typeId === "hf-model" ? "model" : typeId === "hf-dataset" ? "dataset" : "space";
        // DELETE /api/repos/delete with {name, organization, type}
        await hfJson(this.ctx, `${HUB_BASE}/api/repos/delete`, {
          method: "DELETE",
          body: { name, organization: owner, type },
        });
        return;
      }
      case "hf-scheduled-job":
        await hfJson(this.ctx, `${HUB_BASE}/api/scheduled-jobs/${enc(ns)}/${enc(id)}`, {
          method: "DELETE",
        });
        return;
      case "hf-service-account":
        await hfJson(
          this.ctx,
          `${HUB_BASE}/api/organizations/${enc(ns)}/service-accounts/${enc(id)}`,
          {
            method: "DELETE",
          },
        );
        return;
      case "hf-webhook":
        await hfJson(this.ctx, `${HUB_BASE}/api/settings/webhooks/${enc(id)}`, {
          method: "DELETE",
        });
        return;
      default:
        throw new Error(`Hugging Face plugin: ${typeId} cannot be deleted`);
    }
  }

  // ------------------------------------------------------------- actions

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId, accountId, typeId);
    const ns = await this.namespace();
    const post = (url: string, body?: unknown) =>
      hfJson(this.ctx, url, { method: "POST", ...(body !== undefined ? { body } : {}) });

    if (typeId === "hf-inference-endpoint") {
      // POST /v2/endpoint/{ns}/{name}/{pause|resume|scale-to-zero}
      if (actionId === "pause" || actionId === "resume" || actionId === "scale-to-zero") {
        await post(`${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(id)}/${actionId}`);
        return;
      }
    } else if (typeId === "hf-space") {
      const base = `${HUB_BASE}/api/spaces/${encRepo(id)}`;
      if (actionId === "restart") return void (await post(`${base}/restart`));
      if (actionId === "factory-reboot") return void (await post(`${base}/restart?factory=true`));
      if (actionId === "pause") return void (await post(`${base}/pause`));
      if (actionId.startsWith("delete-secret:")) {
        await hfJson(this.ctx, `${base}/secrets`, {
          method: "DELETE",
          body: { key: actionId.slice("delete-secret:".length) },
        });
        return;
      }
      if (actionId.startsWith("delete-variable:")) {
        await hfJson(this.ctx, `${base}/variables`, {
          method: "DELETE",
          body: { key: actionId.slice("delete-variable:".length) },
        });
        return;
      }
    } else if (typeId === "hf-job" && actionId === "cancel") {
      await post(`${HUB_BASE}/api/jobs/${enc(ns)}/${enc(id)}/cancel`);
      return;
    } else if (typeId === "hf-scheduled-job") {
      if (actionId === "suspend" || actionId === "resume" || actionId === "run") {
        await post(`${HUB_BASE}/api/scheduled-jobs/${enc(ns)}/${enc(id)}/${actionId}`);
        return;
      }
    } else if (typeId === "hf-member-token" && actionId === "revoke") {
      await post(`${HUB_BASE}/api/organizations/${enc(ns)}/settings/tokens/${enc(id)}/revoke`);
      return;
    } else if (typeId === "hf-webhook" && (actionId === "enable" || actionId === "disable")) {
      await post(`${HUB_BASE}/api/settings/webhooks/${enc(id)}/${actionId}`);
      return;
    } else if (typeId === "hf-service-account" && actionId.startsWith("delete-token:")) {
      const tokenId = actionId.slice("delete-token:".length);
      await hfJson(
        this.ctx,
        `${HUB_BASE}/api/organizations/${enc(ns)}/service-accounts/${enc(id)}/tokens/${enc(tokenId)}`,
        { method: "DELETE" },
      );
      return;
    }
    throw new Error(`Hugging Face plugin: unknown action "${actionId}" for ${typeId}`);
  }

  /** Form-driven actions (`prompt-nosql-command`): hardware, sleep time, secrets, variables. */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalIdOf(resourceId, accountId, typeId);
    const ns = await this.namespace();
    const form = parseForm(args[0]);
    if (typeId === "hf-inference-endpoint" && command === "changeHardware") {
      const vendors = await this.vendors();
      let chosen: import("./wire.js").Compute | undefined;
      for (const v of vendors.vendors ?? []) {
        for (const r of v.regions ?? []) {
          chosen ??= (r.computes ?? []).find((c) => c.id === form["compute"]);
        }
      }
      if (!chosen) throw new Error("Hugging Face plugin: pick the new hardware");
      await hfJson(this.ctx, `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(id)}`, {
        method: "PUT",
        body: {
          compute: {
            accelerator: chosen.accelerator,
            instanceType: chosen.instanceType,
            instanceSize: chosen.instanceSize,
          },
        },
      });
      return { ok: true };
    }
    if (typeId === "hf-space") {
      const base = `${HUB_BASE}/api/spaces/${encRepo(id)}`;
      switch (command) {
        case "changeHardware": {
          const flavor = form["flavor"];
          if (!flavor) throw new Error("Hugging Face plugin: pick the hardware");
          const sleep = intOrUndefined(form["sleepTimeSeconds"]);
          await hfJson(this.ctx, `${base}/hardware`, {
            method: "POST",
            body: {
              flavor,
              ...(sleep !== undefined && flavor !== "cpu-basic" ? { sleepTimeSeconds: sleep } : {}),
            },
          });
          return { ok: true };
        }
        case "setSleepTime": {
          const seconds = intOrUndefined(form["seconds"]);
          if (seconds === undefined) throw new Error("Hugging Face plugin: pick a sleep time");
          await hfJson(this.ctx, `${base}/sleeptime`, { method: "POST", body: { seconds } });
          return { ok: true };
        }
        case "addSecret":
        case "addVariable": {
          const key = (form["key"] ?? "").trim();
          if (!key) throw new Error("Hugging Face plugin: a key is required");
          await hfJson(this.ctx, `${base}/${command === "addSecret" ? "secrets" : "variables"}`, {
            method: "POST",
            body: {
              key,
              value: form["value"] ?? "",
              ...(form["description"] ? { description: form["description"] } : {}),
            },
          });
          return { ok: true };
        }
      }
    }
    throw new Error(`Hugging Face plugin: unknown command "${command}" for ${typeId}`);
  }

  /**
   * Mint a service-account token:
   * `POST /api/organizations/{name}/service-accounts/{id}/tokens`.
   * The secret is returned once and never again.
   */
  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "hf-service-account") {
      throw new Error(`Hugging Face plugin: ${typeId} has no credentials to export`);
    }
    const id = externalIdOf(resourceId, accountId, typeId);
    const ns = await this.namespace();
    const permissions: Record<string, string[]> = {
      "read-token": ["org.read", "repo.content.read"],
      "write-token": ["org.read", "repo.write"],
      "inference-token": ["inference.serverless.write", "inference.endpoints.infer.write"],
    };
    const chosen = permissions[formatId];
    if (!chosen) throw new Error(`Hugging Face plugin: unknown token format "${formatId}"`);
    const created = await hfJson<{
      token?: string;
      tokenInfo?: { _id?: string; displayName?: string };
    }>(this.ctx, `${HUB_BASE}/api/organizations/${enc(ns)}/service-accounts/${enc(id)}/tokens`, {
      method: "POST",
      body: {
        displayName: `infrawrench-${formatId}-${new Date().toISOString().slice(0, 10)}`,
        permissions: chosen,
      },
    });
    const token = created.token ?? "";
    if (!token) throw new Error("Hugging Face plugin: the token was created but not returned");
    return {
      content: token,
      filename: `${id}-${formatId}.txt`,
      mimeType: "text/plain",
      fields: [
        { label: "Token", value: token, sensitive: true },
        { label: "Name", value: created.tokenInfo?.displayName ?? "" },
        { label: "Permissions", value: chosen.join(", ") },
      ],
      warning: "Save this token now: Hugging Face never shows it again.",
    };
  }

  // ------------------------------------------------------------- metrics

  /**
   * `POST /v2/endpoint/{ns}/{name}/metrics` with `{start, stop}` returns every
   * graph the console draws in one call.
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "hf-inference-endpoint") return [];
    const id = externalIdOf(resourceId, accountId, resourceTypeId);
    const ns = await this.namespace();
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
    let graphs: AllGraphs;
    try {
      graphs = await hfJson<AllGraphs>(
        this.ctx,
        `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(id)}/metrics`,
        {
          method: "POST",
          body: { start: new Date(startMs).toISOString(), stop: new Date(endMs).toISOString() },
        },
      );
    } catch (err) {
      if (statusOf(err) === 404) return [];
      throw err;
    }
    return endpointMetricSeries(graphs);
  }

  // ---------------------------------------------------------------- logs

  /** `GET /v3/endpoint/{ns}/{name}/logs?limit=&order=desc[&replica=]` */
  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "hf-inference-endpoint") {
      return { text: "", containers: [], activeContainer: "" };
    }
    const id = externalIdOf(resourceId, accountId, typeId);
    const ns = await this.namespace();
    const replicas = await hfJson<Replicas>(
      this.ctx,
      `${ENDPOINTS_BASE}/v2/endpoint/${enc(ns)}/${enc(id)}/replica`,
    ).catch(() => ({ items: [] }) as Replicas);
    const containers = [
      "All replicas",
      ...(replicas.items ?? []).map((r) => String(r.id ?? "")).filter(Boolean),
    ];
    const active =
      params.container && containers.includes(params.container) ? params.container : "All replicas";
    const qs = new URLSearchParams({
      limit: String(Math.min(Math.max(params.tailLines ?? 500, 1), 5000)),
      order: "desc",
    });
    if (active !== "All replicas") qs.set("replica", active);
    const entries = await hfJson<LogEntry[]>(
      this.ctx,
      `${ENDPOINTS_BASE}/v3/endpoint/${enc(ns)}/${enc(id)}/logs?${qs.toString()}`,
    );
    const text = (entries ?? [])
      .slice()
      .reverse()
      .map((e) => {
        const replica = active === "All replicas" && e.replica_id ? ` [${e.replica_id}]` : "";
        return `${e.timestamp ?? ""}${replica} ${e.line ?? ""}\n`;
      })
      .join("");
    return { text, containers, activeContainer: active };
  }

  // ---------------------------------------------------------------- chat

  /**
   * Playground. Provider models go through the router
   * (`POST https://router.huggingface.co/v1/chat/completions`, model suffix
   * `:fastest`/`:cheapest`/`:{provider}` picks the provider); endpoints are
   * called directly at `{url}/v1/chat/completions`, which TGI, vLLM and
   * SGLang containers serve.
   */
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
    options?: { model?: string },
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    let url: string;
    let model: string;
    if (typeId === "hf-provider-model") {
      url = `${ROUTER_BASE}/chat/completions`;
      model = options?.model || externalIdOf(resourceId, accountId, typeId);
    } else if (typeId === "hf-inference-endpoint") {
      let resource: ResourceInstance;
      try {
        resource = await this.getResource(typeId, resourceId, accountId);
      } catch (err) {
        yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
        return;
      }
      const base = String(resource.fields["url"] ?? "").replace(/\/+$/, "");
      if (!base) {
        yield { kind: "error", message: "This endpoint has no URL yet. Wait until it is running." };
        return;
      }
      url = `${base}/v1/chat/completions`;
      model = String(resource.fields["repository"] ?? "tgi") || "tgi";
    } else {
      yield { kind: "error", message: `Hugging Face plugin: no playground for ${typeId}` };
      return;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.ctx.token}`,
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
          res.status === 401 || res.status === 403
            ? 'Hugging Face rejected the token for inference. Fine-grained tokens need "Make calls to Inference Providers" (or access to this endpoint\'s namespace).'
            : res.status === 402
              ? "Inference Providers credits are exhausted for this account. Add credits or a payment method on huggingface.co."
              : `Chat request failed (${res.status}): ${text.slice(0, 500) || res.statusText}`,
      };
      return;
    }
    yield* streamOpenAiSseChat(res.body);
  }

  // --------------------------------------------------------------- quotas

  /**
   * Inference Endpoints accelerator quotas (`GET /v2/provider/quotas/{ns}`)
   * and the token user's ZeroGPU quota (`GET /api/spaces/zero-gpu/quota`).
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const ns = await this.namespace();
    const out: QuotaUsage[] = [];
    const quotas = await hfJson<VendorQuotas>(
      this.ctx,
      `${ENDPOINTS_BASE}/v2/provider/quotas/${enc(ns)}`,
    ).catch(() => ({ vendors: [] }) as VendorQuotas);
    for (const vendor of quotas.vendors ?? []) {
      for (const q of vendor.quotas ?? []) {
        if (!q.instanceType || !q.maxAccelerators || q.maxAccelerators <= 0) continue;
        out.push({
          id: `endpoints/${vendor.name}/${q.instanceType}`,
          service: "inference-endpoints",
          name: `${q.architecture ?? q.instanceType} accelerators on ${String(vendor.name ?? "").toUpperCase()}`,
          limit: q.maxAccelerators,
          used: q.usedAccelerators ?? 0,
          unit: "accelerators",
          adjustable: true,
          docsUrl: "https://huggingface.co/docs/inference-endpoints/en/support",
        });
      }
    }
    if (!(await this.isOrgNamespace())) {
      const zero = await hfJson<ZeroGpuQuota>(
        this.ctx,
        `${HUB_BASE}/api/spaces/zero-gpu/quota`,
      ).catch(() => undefined);
      if (zero && typeof zero.base === "number" && zero.base > 0) {
        out.push({
          id: "spaces/zero-gpu",
          service: "spaces",
          name: "ZeroGPU daily quota",
          limit: zero.base,
          used: Math.max(0, zero.base - (zero.current ?? zero.base)),
          unit: "GPU-seconds",
          adjustable: false,
          docsUrl: "https://huggingface.co/docs/hub/spaces-zerogpu",
        });
      }
    }
    return out;
  }

  // ----------------------------------------------------------------- cost

  /**
   * Billed spend the Hub exposes with a documented shape:
   * - organizations: Inference Providers usage per day, model, provider and
   *   member (`GET /api/organizations/{name}/billing/usage/inference`);
   * - users: Jobs usage for the current billing period, per job
   *   (`GET /api/settings/billing/usage/jobs`).
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const ns = await this.namespace();
    if (await this.isOrgNamespace()) {
      // Both dates must fall within the last 12 months.
      const floor = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
      const from = range.fromDate < floor ? floor : range.fromDate;
      if (from > range.toDate) return [];
      const qs = new URLSearchParams({
        startDate: `${from}T00:00:00.000Z`,
        endDate: `${range.toDate}T23:59:59.999Z`,
        limit: "31",
      });
      const periods = await hfPaginate<InferenceUsagePeriod>(
        this.ctx,
        `${HUB_BASE}/api/organizations/${enc(ns)}/billing/usage/inference?${qs.toString()}`,
        30,
      );
      return inferenceUsageRows(periods, range);
    }
    const usage = await hfJson<JobsUsage>(this.ctx, `${HUB_BASE}/api/settings/billing/usage/jobs`);
    return jobsUsageRows(usage, range);
  }

  // --------------------------------------------------------------- render

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build a Jobs `jobSpec` from create-form fields. */
export function jobSpecFrom(fields: Record<string, string>): Record<string, unknown> {
  const image = (fields["image"] ?? "").trim();
  const space = fields["spaceId"] && fields["spaceId"] !== "__none__" ? fields["spaceId"] : "";
  if (!image && !space) throw new Error("Hugging Face plugin: pick a Docker image or a Space");
  const command = (fields["command"] ?? "").trim();
  const env: Record<string, string> = {};
  for (const line of (fields["environment"] ?? "").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const timeout = intOrUndefined(fields["timeoutSeconds"]);
  return {
    ...(space ? { spaceId: space } : { dockerImage: image }),
    // The API takes argv. A single shell line is the friendliest thing to
    // type, so it runs under `sh -c`, which every common base image has.
    ...(command ? { command: ["/bin/sh", "-c", command] } : {}),
    flavor: fields["flavor"] || "cpu-basic",
    environment: env,
    ...(timeout !== undefined && timeout > 0 ? { timeoutSeconds: timeout } : {}),
  };
}
