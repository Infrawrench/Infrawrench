import type { Credentials } from "./plugin.js";
import { attempt, attemptStream, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import {
  hostFetch,
  pathEncode,
  requireListPage,
  streamOpenAiSseChat,
  type ApiBody,
  type ApiResponse,
} from "@infrawrench/plugin-base";
import type { operations as EndpointOperations } from "./api-types.endpoints.gen.js";
import type { paths as HubPaths } from "./api-types.hub.gen.js";
import { createHfApis, repoSegment, type HfApis } from "./api.js";
import { CATALOG_BASE, ROUTER_BASE, hfJson, statusOf, type HfContext } from "./http.js";
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
  ExactCompute,
  ExactVendors,
  HardwareFlavor,
  Job,
  RepoInfo,
  Replicas,
  RouterModels,
  ScheduledJob,
  VendorQuotas,
  WhoAmI,
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

type RepoCreateBody = ApiBody<HubPaths["/api/repos/create"]["post"]>;
type RepoSettingsBody = ApiBody<HubPaths["/api/spaces/{namespace}/{repo}/settings"]["put"]>;
type EndpointUpdateBody = ApiBody<EndpointOperations["update_endpoint"]>;
type EndpointCreateBody = ApiBody<EndpointOperations["create_endpoint"]>;
type ServiceAccountTokenBody = ApiBody<
  HubPaths["/api/organizations/{name}/service-accounts/{serviceAccountId}/tokens"]["post"]
>;
type JobSpecBody = NonNullable<
  ApiBody<HubPaths["/api/scheduled-jobs/{namespace}"]["post"]>["jobSpec"]
>;
type ServiceAccountCreated = ApiResponse<
  HubPaths["/api/organizations/{name}/service-accounts"]["post"]
> & { name?: string };

function parseForm(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: Record<string, unknown> = JSON.parse(raw);
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
  private readonly api: HfApis;
  private readonly configuredNamespace: string;
  private whoamiCache?: { at: number; value: WhoAmI };
  private vendorsCache?: { at: number; value: ExactVendors };

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("Hugging Face plugin: missing apiToken credential");
    this.ctx = {
      token,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.api = createHfApis(this.ctx);
    this.configuredNamespace = (credentials["namespace"] ?? "").trim();
  }

  // ------------------------------------------------------------ identity

  /** `GET /api/whoami-v2`: the token's user, orgs and plan. */
  async whoami(): Promise<WhoAmI> {
    if (this.whoamiCache && Date.now() - this.whoamiCache.at < CACHE_MS) {
      return this.whoamiCache.value;
    }
    const value: WhoAmI = await this.api.hub.get("/api/whoami-v2");
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
  private async vendors(): Promise<ExactVendors> {
    if (this.vendorsCache && Date.now() - this.vendorsCache.at < CACHE_MS) {
      return this.vendorsCache.value;
    }
    const ns = await this.namespace();
    let value: ExactVendors;
    try {
      value = await this.api.endpoints.get(`/v2/provider/${pathEncode(ns)}`);
    } catch (err) {
      // The public catalogue has the same shape, minus per-namespace quota.
      if (statusOf(err) !== 401 && statusOf(err) !== 403) throw err;
      value = await this.api.endpoints.get("/v2/provider");
    }
    this.vendorsCache = { at: Date.now(), value };
    return value;
  }

  /**
   * A 401 on a listing can mean the feature is off for this namespace or that the
   * token is dead, and a dead token reading as nothing there would prune every row.
   * So ask the Hub, past the cache, and let its own failure throw.
   */
  private async confirmTokenIfRejected(err: unknown): Promise<void> {
    if (statusOf(err) === 401) await this.api.hub.get("/api/whoami-v2");
  }

  // ------------------------------------------------------------- listing

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
    });
  }

  /**
   * `GET /v2/endpoint/{namespace}?limit=&cursor=`. A namespace without
   * Inference Endpoints billing set up answers 401/403; that reads as "no
   * endpoints", not as a broken account.
   */
  private async listEndpoints(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    let items: Endpoint[];
    try {
      items = await this.api.endpoints.getAll(`/v2/endpoint/${pathEncode(ns)}`, "items");
    } catch (err) {
      if (statusOf(err) !== 401 && statusOf(err) !== 403) throw err;
      await this.confirmTokenIfRejected(err);
      return [];
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
    const repos =
      kind === "model"
        ? await this.api.repos.getAll("/api/models", null, {
            query: { author: ns, limit: 1000, "expand[]": MODEL_EXPAND },
          })
        : await this.api.repos.getAll("/api/datasets", null, {
            query: { author: ns, limit: 1000, "expand[]": DATASET_EXPAND },
          });
    return repos.filter((r) => r.id).map((r) => mapRepo(accountId, kind, r));
  }

  /** `GET /api/spaces?author={namespace}&expand[]=runtime…` */
  private async listSpaces(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const repos = await this.api.repos.getAll("/api/spaces", null, {
      query: { author: ns, limit: 1000, "expand[]": SPACE_EXPAND },
    });
    return repos.filter((r) => r.id).map((r) => mapSpace(accountId, r));
  }

  /**
   * `GET /api/jobs/{namespace}`, paginated by Link header. The document gives no page
   * size and no way to set one, nor an order, so this is not a rolling window: 500
   * pages reaches 10,000 rows even at 20 a page, and past that the read throws.
   */
  private async listJobs(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const jobs = await this.api.hub
      .getAll(`/api/jobs/${pathEncode(ns)}`, null, { maxPages: 500 })
      .catch((err): Job[] => {
        if (statusOf(err) === 403) return [];
        throw err;
      });
    return jobs.filter((j) => j.id).map((j) => mapJob(accountId, j));
  }

  /** `GET /api/scheduled-jobs/{namespace}` */
  private async listScheduledJobs(accountId: string): Promise<ResourceInstance[]> {
    const ns = await this.namespace();
    const jobs = await this.api.hub
      .getAll(`/api/scheduled-jobs/${pathEncode(ns)}`, null)
      .catch((err): ScheduledJob[] => {
        if (statusOf(err) === 403) return [];
        throw err;
      });
    return jobs.filter((j) => j.id).map((j) => mapScheduledJob(accountId, j, ns));
  }

  /** `GET https://router.huggingface.co/v1/models` */
  private async listProviderModels(accountId: string): Promise<ResourceInstance[]> {
    const res = await hfJson<RouterModels>(this.ctx, `${ROUTER_BASE}/models`);
    const models = requireListPage(res.data, {
      vendor: "Hugging Face",
      path: "/v1/models",
      key: "data",
    });
    return models.filter((m) => m.id).map((m) => mapProviderModel(accountId, m));
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
      const list = await this.api.hub.getAll(
        `/api/organizations/${pathEncode(ns)}/service-accounts`,
        null,
      );
      return list.filter((s) => s._id).map((s) => mapServiceAccount(accountId, s));
    } catch (err) {
      if (![401, 402, 403, 404].includes(statusOf(err) ?? 0)) throw err;
      await this.confirmTokenIfRejected(err);
      return [];
    }
  }

  /** `GET /api/organizations/{name}/settings/tokens` (Team/Enterprise, org admins), paginated by Link header. */
  private async listMemberTokens(accountId: string): Promise<ResourceInstance[]> {
    if (!(await this.isOrgNamespace())) return [];
    const ns = await this.namespace();
    try {
      // The document's largest page, so 100 pages is 10,000 tokens.
      const list = await this.api.hub.getAll(
        `/api/organizations/${pathEncode(ns)}/settings/tokens`,
        null,
        { query: { limit: 100 }, maxPages: 100 },
      );
      return list.filter((t) => t._id).map((t) => mapMemberToken(accountId, t));
    } catch (err) {
      if (![401, 402, 403, 404].includes(statusOf(err) ?? 0)) throw err;
      await this.confirmTokenIfRejected(err);
      return [];
    }
  }

  /** `GET /api/settings/webhooks`: the token user's webhooks (not per-org). */
  private async listWebhooks(accountId: string): Promise<ResourceInstance[]> {
    try {
      const list = await this.api.hub.getAll("/api/settings/webhooks", null);
      return list.filter((w) => w.id).map((w) => mapWebhook(accountId, w));
    } catch (err) {
      if (statusOf(err) === 403) return [];
      throw err;
    }
  }

  // ----------------------------------------------------------------- get

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId, accountId, typeId);
      const ns = await this.namespace();
      switch (typeId) {
        case "hf-inference-endpoint": {
          const endpoint = await this.api.endpoints.get(
            `/v2/endpoint/${pathEncode(ns)}/${pathEncode(id)}`,
          );
          const vendors = await this.vendors().catch(() => undefined);
          return mapEndpoint(accountId, endpoint, vendors, ns);
        }
        case "hf-model":
        case "hf-dataset": {
          const kind = typeId === "hf-model" ? "model" : "dataset";
          const repo =
            kind === "model"
              ? await this.api.repos.get(`/api/models/${repoSegment(id)}`, {
                  query: { "expand[]": MODEL_EXPAND },
                })
              : await this.api.repos.get(`/api/datasets/${repoSegment(id)}`, {
                  query: { "expand[]": DATASET_EXPAND },
                });
          return mapRepo(accountId, kind, { ...repo, id: repo.id ?? id });
        }
        case "hf-space": {
          const repo = await this.api.repos.get(`/api/spaces/${repoSegment(id)}`, {
            query: { "expand[]": SPACE_EXPAND },
          });
          return mapSpace(accountId, { ...repo, id: repo.id ?? id });
        }
        case "hf-job": {
          const job = await this.api.hub.get(`/api/jobs/${pathEncode(ns)}/${pathEncode(id)}`);
          return mapJob(accountId, job);
        }
        case "hf-scheduled-job": {
          const job = await this.api.hub.get(
            `/api/scheduled-jobs/${pathEncode(ns)}/${pathEncode(id)}`,
          );
          return mapScheduledJob(accountId, job, ns);
        }
        case "hf-service-account": {
          const sa = await this.api.hub.get(
            `/api/organizations/${pathEncode(ns)}/service-accounts/${pathEncode(id)}`,
          );
          const mapped = mapServiceAccount(accountId, sa);
          mapped.resolvedOutputs["__tokens__"] = JSON.stringify(sa.accessTokens ?? []);
          return mapped;
        }
        default: {
          const all = await runPluginEffect(this.listResources(typeId, accountId));
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
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (outputKey === "baseUrl") return ROUTER_BASE;
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey] ?? resource.fields[outputKey];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  /**
   * Extra reads for the detail page: an endpoint's hardware alternatives and
   * replicas, a Space's secrets, variables and hardware menu, a service
   * account's tokens. Stashed under `__…__` outputs because `renderDetail`
   * is synchronous.
   */
  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ns = await this.namespace();
      const out = { ...resource, resolvedOutputs: { ...resource.resolvedOutputs } };
      if (resource.resourceTypeId === "hf-inference-endpoint") {
        const name = String(resource.fields["name"] ?? resource.externalId ?? "");
        const [vendors, replicas] = await Promise.all([
          this.vendors().catch(() => undefined),
          this.api.endpoints
            .get(`/v2/endpoint/${pathEncode(ns)}/${pathEncode(name)}/replica`)
            .catch((): Replicas => ({ items: [] })),
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
          this.api.hub.get(`/api/spaces/${repoSegment(repo)}/secrets`).catch(() => ({})),
          this.api.hub.get(`/api/spaces/${repoSegment(repo)}/variables`).catch(() => ({})),
          this.spaceHardware().catch((): HardwareFlavor[] => []),
        ]);
        out.resolvedOutputs["__secrets__"] = JSON.stringify(Object.values(secrets ?? {}));
        out.resolvedOutputs["__variables__"] = JSON.stringify(Object.values(variables ?? {}));
        out.resolvedOutputs["__hardware__"] = JSON.stringify(hardware);
      } else if (
        resource.resourceTypeId === "hf-service-account" &&
        !out.resolvedOutputs["__tokens__"]
      ) {
        const sa = await this.api.hub.get(
          `/api/organizations/${pathEncode(ns)}/service-accounts/${pathEncode(resource.externalId ?? "")}`,
        );
        out.resolvedOutputs["__tokens__"] = JSON.stringify(sa.accessTokens ?? []);
      }
      return out;
    });
  }

  /** `GET /api/spaces/hardware`: public list of Space flavors with per-minute prices. */
  async spaceHardware(): Promise<HardwareFlavor[]> {
    return (await this.api.hub.get("/api/spaces/hardware")) ?? [];
  }

  /** `GET /api/jobs/hardware`: Jobs flavors with per-minute prices. */
  async jobHardware(): Promise<HardwareFlavor[]> {
    return (await this.api.hub.get("/api/jobs/hardware")) ?? [];
  }

  // -------------------------------------------------------------- create

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const ns = await this.namespace();
      switch (typeId) {
        case "hf-inference-endpoint": {
          const [vendors, catalog, ownModels, trending] = await Promise.all([
            this.vendors().catch((): ExactVendors => ({ vendors: [] })),
            hfJson<CatalogList>(this.ctx, `${CATALOG_BASE}/list`).catch(() => ({ items: [] })),
            this.api.repos
              .get("/api/models", {
                query: { author: ns, limit: 200, "expand[]": ["pipeline_tag"] },
              })
              .catch((): RepoInfo[] => []),
            this.api.repos
              .get("/api/models", {
                query: { sort: "trendingScore", limit: 50, "expand[]": ["pipeline_tag"] },
              })
              .catch((): RepoInfo[] => []),
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
            this.jobHardware().catch((): HardwareFlavor[] => []),
            this.api.repos
              .get("/api/spaces", { query: { author: ns, limit: 200 } })
              .catch((): RepoInfo[] => []),
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
          const owner = isOrg ? { organization: ns } : {};
          const visibility = fields["visibility"] || "public";
          const sleep = intOrUndefined(fields["sleepTimeSeconds"]);
          const body: RepoCreateBody =
            kind === "space"
              ? {
                  name,
                  type: kind,
                  ...owner,
                  visibility,
                  sdk: fields["sdk"] || "gradio",
                  ...(fields["hardware"] ? { hardware: fields["hardware"] } : {}),
                  ...(fields["shortDescription"]
                    ? { short_description: fields["shortDescription"] }
                    : {}),
                  ...(sleep !== undefined &&
                  fields["hardware"] &&
                  fields["hardware"] !== "cpu-basic"
                    ? { sleepTimeSeconds: sleep }
                    : {}),
                  ...repoExtras(fields),
                }
              : {
                  name,
                  type: kind,
                  ...owner,
                  private: visibility === "private",
                  ...repoExtras(fields),
                };
          // https://huggingface.co/.well-known/openapi.json: POST /api/repos/create
          await this.api.hub.post("/api/repos/create", { body });
          const repoId = `${ns}/${name}`;
          return runPluginEffect(
            this.getResource(typeId, `${accountId}:${typeId}:${repoId}`, accountId),
          );
        }
        case "hf-job": {
          const job = await this.api.hub.post(`/api/jobs/${pathEncode(ns)}`, {
            body: jobSpecFrom(fields),
          });
          return mapJob(accountId, job);
        }
        case "hf-scheduled-job": {
          const schedule = (fields["schedule"] ?? "").trim();
          if (!schedule) throw new Error("Hugging Face plugin: a schedule is required");
          const job = await this.api.hub.post(`/api/scheduled-jobs/${pathEncode(ns)}`, {
            body: {
              jobSpec: jobSpecFrom(fields),
              schedule,
              suspend: false,
              concurrency: fields["concurrency"] === "true",
            },
          });
          return mapScheduledJob(accountId, job, ns);
        }
        case "hf-service-account": {
          if (!isOrg) {
            throw new Error(
              "Hugging Face plugin: service accounts belong to organizations. Point this account at an organization namespace.",
            );
          }
          // The document's answer has `fullname` where a listing has `name`.
          const created: ServiceAccountCreated = await this.api.hub.post(
            `/api/organizations/${pathEncode(ns)}/service-accounts`,
            {
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
    });
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
        `${CATALOG_BASE}/recipe/${pathEncode(recipe)}/deploy`,
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
    let chosen: { vendor: string; region: string; compute: ExactCompute } | undefined;
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
    const body: EndpointCreateBody = {
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
    const created = await this.api.endpoints.post(`/v2/endpoint/${pathEncode(ns)}`, { body });
    return mapEndpoint(accountId, created, vendors, ns);
  }

  // -------------------------------------------------------------- update

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId, accountId, typeId);
      const ns = await this.namespace();
      switch (typeId) {
        case "hf-inference-endpoint": {
          // https://api.endpoints.huggingface.cloud/openapi.json: PUT /v2/endpoint/{ns}/{name}
          const scaling: NonNullable<NonNullable<EndpointUpdateBody["compute"]>["scaling"]> = {};
          const min = intOrUndefined(fields["minReplica"]);
          const max = intOrUndefined(fields["maxReplica"]);
          const timeout = intOrUndefined(fields["scaleToZeroTimeout"]);
          if (min !== undefined) scaling.minReplica = min;
          if (max !== undefined) scaling.maxReplica = max;
          if (timeout !== undefined) scaling.scaleToZeroTimeout = timeout;
          const body: EndpointUpdateBody = {};
          if (Object.keys(scaling).length) body.compute = { scaling };
          if (fields["type"]) body.type = fields["type"];
          if (fields["tags"] !== undefined) body.tags = splitList(fields["tags"]);
          const model: NonNullable<EndpointUpdateBody["model"]> = {};
          if (fields["repository"]) model.repository = fields["repository"];
          if (fields["revision"] !== undefined) model.revision = fields["revision"] || null;
          if (Object.keys(model).length) body.model = model;
          const updated = await this.api.endpoints.put(
            `/v2/endpoint/${pathEncode(ns)}/${pathEncode(id)}`,
            { body },
          );
          return mapEndpoint(accountId, updated, await this.vendors().catch(() => undefined), ns);
        }
        case "hf-model":
        case "hf-dataset":
        case "hf-space": {
          const kind =
            typeId === "hf-model" ? "models" : typeId === "hf-dataset" ? "datasets" : "spaces";
          const body: RepoSettingsBody = {};
          if (fields["visibility"]) {
            if (kind === "spaces") body.visibility = fields["visibility"];
            else body.private = fields["visibility"] === "private";
          }
          if (fields["gated"] !== undefined && kind !== "spaces") {
            body.gated =
              fields["gated"] === "auto" || fields["gated"] === "manual" ? fields["gated"] : false;
          }
          if (fields["discussionsDisabled"] !== undefined) {
            body.discussionsDisabled = fields["discussionsDisabled"] === "true";
          }
          // PUT /api/{models|datasets|spaces}/{namespace}/{repo}/settings
          await this.api.hub.put(`/api/${kind}/${repoSegment(id)}/settings`, { body });
          const fresh = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          if (fields["discussionsDisabled"] !== undefined) {
            fresh.fields["discussionsDisabled"] = fields["discussionsDisabled"] === "true";
          }
          return fresh;
        }
        case "hf-scheduled-job": {
          if (fields["schedule"]) {
            // POST /api/scheduled-jobs/{namespace}/{id}/schedule
            const job = await this.api.hub.post(
              `/api/scheduled-jobs/${pathEncode(ns)}/${pathEncode(id)}/schedule`,
              { body: { schedule: fields["schedule"].trim() } },
            );
            return mapScheduledJob(accountId, job, ns);
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        default:
          throw new Error(`Hugging Face plugin: ${typeId} cannot be edited`);
      }
    });
  }

  // -------------------------------------------------------------- delete

  deleteResource(typeId: string, resourceId: string, accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId, accountId, typeId);
      const ns = await this.namespace();
      switch (typeId) {
        case "hf-inference-endpoint":
          await this.api.endpoints.delete(`/v2/endpoint/${pathEncode(ns)}/${pathEncode(id)}`);
          return;
        case "hf-model":
        case "hf-dataset":
        case "hf-space": {
          const [owner, ...rest] = id.split("/");
          const name = rest.join("/");
          const type =
            typeId === "hf-model" ? "model" : typeId === "hf-dataset" ? "dataset" : "space";
          // DELETE /api/repos/delete with {name, organization, type}
          await this.api.hub.delete("/api/repos/delete", {
            body: { name, organization: owner, type },
          });
          return;
        }
        case "hf-scheduled-job":
          await this.api.hub.delete(`/api/scheduled-jobs/${pathEncode(ns)}/${pathEncode(id)}`);
          return;
        case "hf-service-account":
          await this.api.hub.delete(
            `/api/organizations/${pathEncode(ns)}/service-accounts/${pathEncode(id)}`,
          );
          return;
        case "hf-webhook":
          await this.api.hub.delete(`/api/settings/webhooks/${pathEncode(id)}`);
          return;
        default:
          throw new Error(`Hugging Face plugin: ${typeId} cannot be deleted`);
      }
    });
  }

  // ------------------------------------------------------------- actions

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId, accountId, typeId);
      const ns = await this.namespace();
      const { hub, endpoints } = this.api;

      if (typeId === "hf-inference-endpoint") {
        // POST /v2/endpoint/{ns}/{name}/{pause|resume|scale-to-zero}
        if (actionId === "pause" || actionId === "resume" || actionId === "scale-to-zero") {
          await endpoints.post(`/v2/endpoint/${pathEncode(ns)}/${pathEncode(id)}/${actionId}`);
          return;
        }
      } else if (typeId === "hf-space") {
        const repo = repoSegment(id);
        if (actionId === "restart") return void (await hub.post(`/api/spaces/${repo}/restart`));
        if (actionId === "factory-reboot") {
          return void (await hub.post(`/api/spaces/${repo}/restart`, {
            query: { factory: true },
          }));
        }
        if (actionId === "pause") return void (await hub.post(`/api/spaces/${repo}/pause`));
        if (actionId.startsWith("delete-secret:")) {
          await hub.delete(`/api/spaces/${repo}/secrets`, {
            body: { key: actionId.slice("delete-secret:".length) },
          });
          return;
        }
        if (actionId.startsWith("delete-variable:")) {
          await hub.delete(`/api/spaces/${repo}/variables`, {
            body: { key: actionId.slice("delete-variable:".length) },
          });
          return;
        }
      } else if (typeId === "hf-job" && actionId === "cancel") {
        await hub.post(`/api/jobs/${pathEncode(ns)}/${pathEncode(id)}/cancel`);
        return;
      } else if (typeId === "hf-scheduled-job") {
        if (actionId === "suspend" || actionId === "resume" || actionId === "run") {
          await hub.post(`/api/scheduled-jobs/${pathEncode(ns)}/${pathEncode(id)}/${actionId}`);
          return;
        }
      } else if (typeId === "hf-member-token" && actionId === "revoke") {
        await hub.post(
          `/api/organizations/${pathEncode(ns)}/settings/tokens/${pathEncode(id)}/revoke`,
        );
        return;
      } else if (typeId === "hf-webhook" && (actionId === "enable" || actionId === "disable")) {
        await hub.post(`/api/settings/webhooks/${pathEncode(id)}/${pathEncode(actionId)}`);
        return;
      } else if (typeId === "hf-service-account" && actionId.startsWith("delete-token:")) {
        const tokenId = actionId.slice("delete-token:".length);
        await hub.delete(
          `/api/organizations/${pathEncode(ns)}/service-accounts/${pathEncode(id)}/tokens/${pathEncode(tokenId)}`,
        );
        return;
      }
      throw new Error(`Hugging Face plugin: unknown action "${actionId}" for ${typeId}`);
    });
  }

  /** Form-driven actions (`prompt-nosql-command`): hardware, sleep time, secrets, variables. */
  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const id = externalIdOf(resourceId, accountId, typeId);
      const ns = await this.namespace();
      const form = parseForm(args[0]);
      if (typeId === "hf-inference-endpoint" && command === "changeHardware") {
        const vendors = await this.vendors();
        let chosen: ExactCompute | undefined;
        for (const v of vendors.vendors ?? []) {
          for (const r of v.regions ?? []) {
            chosen ??= (r.computes ?? []).find((c) => c.id === form["compute"]);
          }
        }
        if (!chosen) throw new Error("Hugging Face plugin: pick the new hardware");
        await this.api.endpoints.put(`/v2/endpoint/${pathEncode(ns)}/${pathEncode(id)}`, {
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
        const repo = repoSegment(id);
        switch (command) {
          case "changeHardware": {
            const flavor = form["flavor"];
            if (!flavor) throw new Error("Hugging Face plugin: pick the hardware");
            const sleep = intOrUndefined(form["sleepTimeSeconds"]);
            await this.api.hub.post(`/api/spaces/${repo}/hardware`, {
              body: {
                flavor,
                ...(sleep !== undefined && flavor !== "cpu-basic"
                  ? { sleepTimeSeconds: sleep }
                  : {}),
              },
            });
            return { ok: true };
          }
          case "setSleepTime": {
            const seconds = intOrUndefined(form["seconds"]);
            if (seconds === undefined) throw new Error("Hugging Face plugin: pick a sleep time");
            await this.api.hub.post(`/api/spaces/${repo}/sleeptime`, { body: { seconds } });
            return { ok: true };
          }
          case "addSecret":
          case "addVariable": {
            const key = (form["key"] ?? "").trim();
            if (!key) throw new Error("Hugging Face plugin: a key is required");
            const body = {
              key,
              value: form["value"] ?? "",
              ...(form["description"] ? { description: form["description"] } : {}),
            };
            if (command === "addSecret") {
              await this.api.hub.post(`/api/spaces/${repo}/secrets`, { body });
            } else {
              await this.api.hub.post(`/api/spaces/${repo}/variables`, { body });
            }
            return { ok: true };
          }
        }
      }
      throw new Error(`Hugging Face plugin: unknown command "${command}" for ${typeId}`);
    });
  }

  /**
   * Mint a service-account token:
   * `POST /api/organizations/{name}/service-accounts/{id}/tokens`.
   * The secret is returned once and never again.
   */
  exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      if (typeId !== "hf-service-account") {
        throw new Error(`Hugging Face plugin: ${typeId} has no credentials to export`);
      }
      const id = externalIdOf(resourceId, accountId, typeId);
      const ns = await this.namespace();
      const permissions: Record<string, NonNullable<ServiceAccountTokenBody["permissions"]>> = {
        "read-token": ["org.read", "repo.content.read"],
        "write-token": ["org.read", "repo.write"],
        "inference-token": ["inference.serverless.write", "inference.endpoints.infer.write"],
      };
      const chosen = permissions[formatId];
      if (!chosen) throw new Error(`Hugging Face plugin: unknown token format "${formatId}"`);
      const created = await this.api.hub.post(
        `/api/organizations/${pathEncode(ns)}/service-accounts/${pathEncode(id)}/tokens`,
        {
          body: {
            displayName: `infrawrench-${formatId}-${new Date().toISOString().slice(0, 10)}`,
            permissions: chosen,
          },
        },
      );
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
    });
  }

  // ------------------------------------------------------------- metrics

  /**
   * `POST /v2/endpoint/{ns}/{name}/metrics` with `{start, stop}` returns every
   * graph the console draws in one call.
   */
  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (resourceTypeId !== "hf-inference-endpoint") return [];
      const id = externalIdOf(resourceId, accountId, resourceTypeId);
      const ns = await this.namespace();
      const endMs = timeRange?.endMs ?? Date.now();
      const startMs = timeRange?.startMs ?? endMs - DEFAULT_METRICS_WINDOW_MS;
      let graphs: AllGraphs;
      try {
        graphs = await this.api.endpoints.post(
          `/v2/endpoint/${pathEncode(ns)}/${pathEncode(id)}/metrics`,
          {
            body: { start: new Date(startMs).toISOString(), stop: new Date(endMs).toISOString() },
          },
        );
      } catch (err) {
        if (statusOf(err) === 404) return [];
        throw err;
      }
      return endpointMetricSeries(graphs);
    });
  }

  // ---------------------------------------------------------------- logs

  /** `GET /v3/endpoint/{ns}/{name}/logs?limit=&order=desc[&replica=]` */
  getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "hf-inference-endpoint") {
        return { text: "", containers: [], activeContainer: "" };
      }
      const id = externalIdOf(resourceId, accountId, typeId);
      const ns = await this.namespace();
      const replicas = await this.api.endpoints
        .get(`/v2/endpoint/${pathEncode(ns)}/${pathEncode(id)}/replica`)
        .catch((): Replicas => ({ items: [] }));
      const containers = [
        "All replicas",
        ...(replicas.items ?? []).map((r) => String(r.id ?? "")).filter(Boolean),
      ];
      const active =
        params.container && containers.includes(params.container)
          ? params.container
          : "All replicas";
      const entries = await this.api.endpoints.get(
        `/v3/endpoint/${pathEncode(ns)}/${pathEncode(id)}/logs`,
        {
          query: {
            limit: Math.min(Math.max(params.tailLines ?? 500, 1), 5000),
            order: "desc",
            ...(active !== "All replicas" ? { replica: active } : {}),
          },
        },
      );
      const text = oldestFirst(entries ?? [])
        .map((e) => {
          const replica = active === "All replicas" && e.replica_id ? ` [${e.replica_id}]` : "";
          return `${e.timestamp ?? ""}${replica} ${e.line ?? ""}\n`;
        })
        .join("");
      return { text, containers, activeContainer: active };
    });
  }

  // ---------------------------------------------------------------- chat

  /**
   * Playground. Provider models go through the router
   * (`POST https://router.huggingface.co/v1/chat/completions`, model suffix
   * `:fastest`/`:cheapest`/`:{provider}` picks the provider); endpoints are
   * called directly at `{url}/v1/chat/completions`, which TGI, vLLM and
   * SGLang containers serve.
   */
  private async *streamChatMessageIterable(
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
        resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
      res = await hostFetch({ http: this.ctx.http, caCert: this.ctx.caCert, stream: true }, url, {
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

  streamChatMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
    options?: { model?: string },
  ) {
    return attemptStream(() =>
      this.streamChatMessageIterable(typeId, resourceId, accountId, messages, options),
    );
  }

  // --------------------------------------------------------------- quotas

  /**
   * Inference Endpoints accelerator quotas (`GET /v2/provider/quotas/{ns}`)
   * and the token user's ZeroGPU quota (`GET /api/spaces/zero-gpu/quota`).
   */
  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      const ns = await this.namespace();
      const out: QuotaUsage[] = [];
      const quotas = await this.api.endpoints
        .get(`/v2/provider/quotas/${pathEncode(ns)}`)
        .catch((): VendorQuotas => ({ vendors: [] }));
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
        const zero = await this.api.hub.get("/api/spaces/zero-gpu/quota").catch(() => undefined);
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
    });
  }

  // ----------------------------------------------------------------- cost

  /**
   * Billed spend the Hub exposes with a documented shape:
   * - organizations: Inference Providers usage per day, model, provider and
   *   member (`GET /api/organizations/{name}/billing/usage/inference`);
   * - users: Jobs usage for the current billing period, per job
   *   (`GET /api/settings/billing/usage/jobs`).
   */
  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const ns = await this.namespace();
      if (await this.isOrgNamespace()) {
        // Both dates must fall within the last 12 months.
        const floor = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
        const from = range.fromDate < floor ? floor : range.fromDate;
        if (from > range.toDate) return [];
        const periods = await this.api.hub.getAll(
          `/api/organizations/${pathEncode(ns)}/billing/usage/inference`,
          null,
          {
            query: {
              startDate: `${from}T00:00:00.000Z`,
              endDate: `${range.toDate}T23:59:59.999Z`,
              limit: 31,
            },
            maxPages: 30,
          },
        );
        return inferenceUsageRows(periods, range);
      }
      const usage = await this.api.hub.get("/api/settings/billing/usage/jobs");
      return jobsUsageRows(usage, range);
    });
  }

  // --------------------------------------------------------------- render

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }
}

/** The `license` and `region` every repo kind takes, in the order they have always gone. */
function repoExtras(fields: Record<string, string>) {
  return {
    ...(fields["license"] ? { license: fields["license"] } : {}),
    ...(fields["region"] ? { region: fields["region"] } : {}),
  };
}

/**
 * The document says log entries are chronological whatever `order` is, with `order`
 * only choosing which end `limit` keeps. That is unconfirmed live and this code used
 * to assume the opposite, so an answer that does come newest first is turned round.
 */
function oldestFirst<T extends { timestamp?: string }>(entries: T[]): T[] {
  const first = Date.parse(entries[0]?.timestamp ?? "");
  const last = Date.parse(entries[entries.length - 1]?.timestamp ?? "");
  return first > last ? entries.slice().reverse() : entries;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Build a Jobs `jobSpec` from create-form fields. */
export function jobSpecFrom(fields: Record<string, string>): JobSpecBody {
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
