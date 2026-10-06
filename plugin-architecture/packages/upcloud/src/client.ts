import type {
  CostEstimate,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreateSizePricingRequest,
  CreditBalance,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightResult,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { buildCostEstimate, withMetricsCapability } from "@infrawrench/plugin-base";
import * as actions from "./actions.js";
import { type UpCloudApi, createUpCloudApi, splitPair, statusOf, trailingId } from "./api.js";
import { fetchUpCloudCostData } from "./cost-data.js";
import {
  type Catalog,
  createResource,
  getCreateConfig,
  loadCatalog,
  planMonthly,
} from "./create.js";
import { fetchCredits, fetchQuotas } from "./credits-quotas.js";
import { enrichDetail } from "./enrich.js";
import * as listers from "./listers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  fetchDatabaseMetrics,
  fetchObjectStorageMetrics,
  fetchServerTransfer,
} from "./metrics.js";
import { dashboardStats, renderDetail, renderSidebarItem } from "./render.js";
import { applyUpdate } from "./update.js";

type Lister = (api: UpCloudApi, accountId: string) => Promise<ResourceInstance[]>;

const LISTERS: Record<string, Lister> = {
  server: listers.listServers,
  storage: listers.listStorages,
  backup: listers.listBackups,
  template: listers.listTemplates,
  network: listers.listNetworks,
  router: listers.listRouters,
  "floating-ip": listers.listFloatingIps,
  "kubernetes-cluster": listers.listClusters,
  "node-group": listers.listNodeGroups,
  database: listers.listDatabases,
  "database-user": listers.listDatabaseUsers,
  "database-db": listers.listLogicalDbs,
  "load-balancer": listers.listLoadBalancers,
  "object-storage": listers.listObjectStorages,
  bucket: listers.listBuckets,
  "object-storage-user": listers.listOsUsers,
  account: listers.listAccount,
};

const PROBES: Array<{ id: string; label: string; path: string; permission: string }> = [
  {
    id: "servers",
    label: "Servers, storage and networking",
    path: "/server",
    permission: "Server and storage access",
  },
  {
    id: "managed",
    label: "Kubernetes, databases and load balancers",
    path: "/database?limit=1&offset=0",
    permission: "Managed service access",
  },
  {
    id: "costs",
    label: "Billing summary and credits",
    path: `/account/billing/summary/${new Date().toISOString().slice(0, 7)}`,
    permission: "Billing role",
  },
];

export const UPCLOUD_PREFLIGHT = {
  capabilities: PROBES.map((p) => ({
    id: p.id,
    label: p.label,
    requiredPermissions: [{ id: p.id, label: p.permission }],
    ...(p.id === "servers" ? { essential: true } : {}),
  })),
};

/** UpCloud client, one per account (an API token or an API user). */
export class UpCloudClient implements PluginClient {
  private readonly api: UpCloudApi;
  private catalogCache: { at: number; value: Promise<Catalog> } | null = null;

  constructor(
    credentials: Record<string, string>,
    private readonly resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiToken = credentials["apiToken"]?.trim();
    const username = credentials["username"]?.trim();
    const password = credentials["password"] ?? "";
    if (!apiToken && !(username && password)) {
      throw new Error("UpCloud plugin: enter an API token, or an API username and password");
    }
    this.api = createUpCloudApi({
      ...(apiToken ? { apiToken } : {}),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      services,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
    });
  }

  private catalog = (): Promise<Catalog> => {
    if (!this.catalogCache || Date.now() - this.catalogCache.at > 6 * 3600_000) {
      const value = loadCatalog(this.api);
      value.catch(() => (this.catalogCache = null));
      this.catalogCache = { at: Date.now(), value };
    }
    return this.catalogCache.value;
  };

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = LISTERS[typeId];
    if (!lister) throw new Error(`UpCloud plugin: unknown resource type "${typeId}"`);
    return lister(this.api, accountId);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = trailingId(resourceId);
    if (typeId === "server") {
      const res = await this.api.get<{ server?: listers.Json }>(`/server/${id}`);
      if (res.server) return listers.mapServer(res.server, accountId);
    }
    if (typeId === "storage") {
      const res = await this.api.get<{ storage?: listers.Json }>(`/storage/${id}`);
      if (res.storage) return listers.mapStorage(res.storage, accountId);
    }
    if (typeId === "database")
      return listers.mapDatabase(await this.api.get(`/database/${id}`), accountId);
    if (typeId === "kubernetes-cluster")
      return listers.mapCluster(await this.api.get(`/kubernetes/${id}`), accountId);
    if (typeId === "load-balancer")
      return listers.mapLoadBalancer(await this.api.get(`/load-balancer/${id}`), accountId);
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) {
      const err = new Error(`UpCloud plugin: ${typeId} ${id} not found`) as Error & {
        status: number;
      };
      err.status = 404;
      throw err;
    }
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = trailingId(resourceId);
    if (
      typeId === "kubernetes-cluster" &&
      (outputKey === "kubeconfig" || outputKey === "apiEndpoint")
    ) {
      const kubeconfig = await this.kubeconfig(id);
      return outputKey === "kubeconfig"
        ? kubeconfig
        : (/server:\s*(\S+)/.exec(kubeconfig)?.[1] ?? "");
    }
    if (typeId === "database") {
      const db = await this.api.get<listers.Json>(`/database/${id}`);
      const params = (db["service_uri_params"] as listers.Json | undefined) ?? {};
      switch (outputKey) {
        case "connectionString":
          return listers.str(db["service_uri"]);
        case "host":
          return listers.str(params["host"]);
        case "port":
          return listers.str(params["port"]);
        case "username":
          return listers.str(params["user"]);
        case "password":
          return listers.str(params["password"]);
        case "database":
          return listers.str(params["dbname"]);
      }
    }
    if (typeId === "database-user" && outputKey === "password") {
      const [dbId, user] = splitPair(id);
      const u = await this.api.get<listers.Json>(
        `/database/${dbId}/users/${encodeURIComponent(user)}`,
      );
      return listers.str(u["password"]);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`UpCloud plugin: cannot resolve output "${outputKey}" for ${typeId}`);
  }

  private async kubeconfig(id: string): Promise<string> {
    const res = await this.api.get<{ kubeconfig?: string }>(`/kubernetes/${id}/kubeconfig`);
    return res.kubeconfig ?? "";
  }

  enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    return enrichDetail(this.api, this.catalog, resource);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
      DEFAULT_METRICS_WINDOW_MS,
    );
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    return dashboardStats(await this.getResource(typeId, resourceId, accountId));
  }

  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = trailingId(resourceId);
    if (typeId === "database") return fetchDatabaseMetrics(this.api, id, timeRange);
    if (typeId === "server") return fetchServerTransfer(this.api, id, timeRange);
    if (typeId === "object-storage") return fetchObjectStorageMetrics(this.api, id);
    return [];
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "database")
      throw new Error("UpCloud plugin: logs are available for databases only");
    const id = trailingId(resourceId);
    const limit = Math.min(params.tailLines ?? 200, 1000);
    const res = await this.api.get<{
      logs?: Array<{ time?: string; hostname?: string; msg?: string; service?: string }>;
    }>(`/database/${id}/logs?limit=${limit}&order=desc`);
    const lines = [...(res.logs ?? [])]
      .reverse()
      .map((l) => `${l.time ?? ""} ${l.hostname ?? ""} ${l.msg ?? ""}`.trim());
    return {
      text: lines.length ? `${lines.join("\n")}\n` : "",
      containers: ["database"],
      activeContainer: "database",
    };
  }

  getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(this.api, this.catalog, typeId, parentResourceId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return createResource(this.api, this.catalog, typeId, accountId, fields, parentResourceId);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    await applyUpdate(this.api, typeId, resourceId, fields);
    return this.getResource(typeId, resourceId, accountId);
  }

  deleteResource(typeId: string, resourceId: string): Promise<void> {
    return actions.deleteResource(this.api, typeId, resourceId);
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
  ): Promise<void> {
    return actions.attachResource(
      this.api,
      sourceTypeId,
      sourceResourceId,
      targetTypeId,
      targetResourceId,
    );
  }

  invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    return actions.invokeAction(this.api, typeId, resourceId, actionId);
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    return actions.executeCommand(this.api, typeId, resourceId, command, args);
  }

  async getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): Promise<Record<string, number>> {
    if (!["server", "kubernetes-cluster", "node-group"].includes(typeId)) return {};
    const cat = await this.catalog();
    const out: Record<string, number> = {};
    for (const s of request.sizes) {
      const price = planMonthly(cat, s.id, request.regionId);
      if (price !== undefined) out[s.id] = price;
    }
    return out;
  }

  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    try {
      const cat = await this.catalog();
      const zone = fields["zone"] ?? fields["region"];
      if (typeId === "server") {
        const plan = fields["plan"] ?? "";
        const monthly = planMonthly(cat, plan, zone);
        if (monthly === undefined) return null;
        const backup =
          fields["simpleBackup"] && fields["simpleBackup"] !== "no" ? fields["simpleBackup"] : "";
        const backupPrice = backup
          ? cat.prices[zone ?? ""]?.[`simple_backup_${backup}_${plan}`]?.price
          : undefined;
        return buildCostEstimate(
          [
            { label: `Plan ${plan}`, monthlyAmount: monthly },
            typeof backupPrice === "number"
              ? { label: `Simple backup (${backup})`, monthlyAmount: (backupPrice / 100) * 672 }
              : null,
          ],
          {
            currency: "EUR",
            notes: ["List prices in EUR; UpCloud bills in the account currency."],
          },
        );
      }
      if (typeId === "node-group" || typeId === "kubernetes-cluster") {
        const plan =
          fields["plan"] && typeId === "node-group" ? fields["plan"] : (fields["nodePlan"] ?? "");
        const count = Number(fields["count"] ?? fields["nodeCount"] ?? 1) || 1;
        const monthly = planMonthly(cat, plan, zone);
        if (monthly === undefined) return null;
        return buildCostEstimate(
          [
            {
              label: `${plan} nodes`,
              monthlyAmount: monthly * count,
              quantity: count,
              unit: "node",
            },
          ],
          {
            currency: "EUR",
            partial: typeId === "kubernetes-cluster",
          },
        );
      }
      return null;
    } catch {
      return null;
    }
  }

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchUpCloudCostData(this.api, range);
  }

  fetchCreditBalance(): Promise<CreditBalance[]> {
    return fetchCredits(this.api);
  }

  fetchQuotas(): Promise<QuotaUsage[]> {
    return fetchQuotas(this.api);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    let identity: string | undefined;
    try {
      identity =
        listers.str(
          (await this.api.get<{ account?: listers.Json }>("/account")).account?.["username"],
        ) || undefined;
    } catch {
      identity = undefined;
    }
    const checks = await Promise.all(
      PROBES.map(async (p) => {
        try {
          await this.api.get(p.path);
          return { capabilityId: p.id, status: "ok" as const };
        } catch (err) {
          const status = statusOf(err);
          if (status === 401 || status === 403) {
            return {
              capabilityId: p.id,
              status: "missing" as const,
              missingPermissions: [{ id: p.id, label: p.permission }],
              message:
                status === 401
                  ? "UpCloud rejected the credentials. Check the token, or that the user has API access and the address you connect from is allowed."
                  : "The user is not allowed to do this. Grant the permission (or the Billing role for costs) under People in the UpCloud Hub.",
              helpLink: { label: "Manage UpCloud users", url: "https://hub.upcloud.com/people" },
            };
          }
          return {
            capabilityId: p.id,
            status: "unknown" as const,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
    return { checks, ...(identity ? { identity } : {}) };
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    const id = trailingId(resourceId);
    if (typeId === "kubernetes-cluster" && formatId === "kubeconfig") {
      const content = await this.kubeconfig(id);
      if (!content)
        throw new Error(
          "UpCloud has not issued a kubeconfig for this cluster yet; try again once it is running.",
        );
      return {
        content,
        filename: `upcloud-${id}-kubeconfig.yaml`,
        mimeType: "application/yaml",
        warning: "This file grants full administrative access to the cluster.",
      };
    }
    if (typeId === "object-storage-user" && formatId === "access-key") {
      const [serviceId, username] = splitPair(id);
      const key = await this.api.send<listers.Json>(
        "POST",
        `/object-storage-2/${serviceId}/users/${encodeURIComponent(username)}/access-keys`,
        {},
      );
      const service = await this.api
        .get<listers.Json>(`/object-storage-2/${serviceId}`)
        .catch(() => ({}) as listers.Json);
      const endpoint = listers.publicEndpoint(service);
      const accessKey = listers.str(key["access_key_id"]);
      const secret = listers.str(key["secret_access_key"]);
      return {
        content: `[default]\naws_access_key_id = ${accessKey}\naws_secret_access_key = ${secret}\n${endpoint ? `endpoint_url = ${endpoint}\n` : ""}`,
        filename: `${username}-credentials.ini`,
        mimeType: "text/plain",
        fields: [
          { label: "Access Key ID", value: accessKey },
          { label: "Secret Access Key", value: secret, sensitive: true, hint: "Only shown once" },
          ...(endpoint ? [{ label: "Endpoint", value: endpoint }] : []),
        ],
        warning:
          "UpCloud shows the secret only once. Save it now; a new access key can be created at any time.",
      };
    }
    throw new Error(`UpCloud plugin: no credential format "${formatId}" for ${typeId}`);
  }
}
