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
  MetricSeries,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { buildCostEstimate, withMetricsCapability } from "@infrawrench/plugin-base";
import * as actions from "./actions.js";
import { type VultrApi, createVultrApi, fromBase64, trailingId } from "./api.js";
import { type PlanCatalogCache, createPlanCatalog, planMonthly, sizePricing } from "./catalog.js";
import { fetchVultrCostData } from "./cost-data.js";
import { createResource, getCreateConfig } from "./create.js";
import { fetchCredits } from "./credits.js";
import { enrichDetail } from "./enrich.js";
import * as listers from "./listers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  fetchBandwidthMetrics,
  fetchDatabaseMetrics,
} from "./metrics.js";
import { ObjectStorageBrowser } from "./object-storage.js";
import { verifyVultrCredentials } from "./preflight.js";
import { dashboardStats, renderDetail, renderSidebarItem } from "./render.js";
import type {
  VultrBlock,
  VultrDatabase,
  VultrInstance,
  VultrKubernetesCluster,
  VultrLoadBalancer,
  VultrObjectStorage,
  VultrStartupScript,
} from "./types.js";
import { applyUpdate } from "./update.js";

type Lister = (api: VultrApi, accountId: string) => Promise<ResourceInstance[]>;

const LISTERS: Record<string, Lister> = {
  instance: listers.listInstances,
  "bare-metal": listers.listBareMetal,
  "block-storage": listers.listBlocks,
  snapshot: listers.listSnapshots,
  backup: listers.listBackups,
  "kubernetes-cluster": listers.listClusters,
  "node-pool": listers.listNodePools,
  database: listers.listDatabases,
  "database-user": listers.listDatabaseUsers,
  "database-db": listers.listLogicalDbs,
  "load-balancer": listers.listLoadBalancers,
  "firewall-group": listers.listFirewallGroups,
  vpc: listers.listVpcs,
  "reserved-ip": listers.listReservedIps,
  domain: listers.listDomains,
  "dns-record": listers.listDnsRecords,
  "object-storage": listers.listObjectStorages,
  bucket: listers.listBuckets,
  "ssh-key": listers.listSshKeys,
  "startup-script": listers.listStartupScripts,
  account: listers.listAccount,
  invoice: listers.listInvoices,
};

/** PEM as-is, or a base64-wrapped PEM decoded. */
export function pemOf(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (v.includes("-----BEGIN")) return v;
  const decoded = fromBase64(v);
  return decoded.includes("-----BEGIN") ? decoded.trim() : v;
}

/** Connection URI for a database's default user. */
export function connectionString(db: VultrDatabase, password?: string): string {
  const engine = db.database_engine ?? "";
  const user = encodeURIComponent(db.user ?? "");
  const pass = encodeURIComponent(password ?? db.password ?? "");
  const host = db.host ?? "";
  const port = db.port ?? "";
  switch (engine) {
    case "pg":
      return `postgresql://${user}:${pass}@${host}:${port}/${db.dbname || "defaultdb"}?sslmode=require`;
    case "mysql":
      return `mysql://${user}:${pass}@${host}:${port}/${db.dbname || "defaultdb"}?ssl-mode=REQUIRED`;
    case "valkey":
      return `rediss://${user}:${pass}@${host}:${port}`;
    case "kafka": {
      const params = new URLSearchParams({ sasl: "scram-sha-256", ssl: "true" });
      const ca = pemOf(db.ca_certificate);
      if (ca) params.set("ssl_ca", btoa(ca));
      return `kafka://${user}:${pass}@${host}:${db.sasl_port || port}?${params.toString()}`;
    }
    default:
      return "";
  }
}

/**
 * Vultr client, one per account (one API key). Provider logic lives in the
 * sibling modules; this class routes the host's calls to them.
 */
export class VultrClient implements PluginClient {
  private readonly api: VultrApi;
  private readonly catalog: PlanCatalogCache;
  private readonly storage: ObjectStorageBrowser;

  constructor(
    credentials: Record<string, string>,
    private readonly resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = credentials["apiKey"]?.trim();
    if (!apiKey) throw new Error("Vultr plugin: missing apiKey credential");
    this.api = createVultrApi({
      apiKey,
      services,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
    });
    this.catalog = createPlanCatalog(this.api);
    this.storage = new ObjectStorageBrowser(this.api);
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = LISTERS[typeId];
    if (!lister) throw new Error(`Vultr plugin: unknown resource type "${typeId}"`);
    return lister(this.api, accountId);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = trailingId(resourceId);
    switch (typeId) {
      case "instance": {
        const res = await this.api.get<{ instance?: VultrInstance }>(`/instances/${id}`);
        if (res.instance) return listers.mapInstance(res.instance, accountId);
        break;
      }
      case "block-storage": {
        const res = await this.api.get<{ block?: VultrBlock }>(`/blocks/${id}`);
        if (res.block) return listers.mapBlock(res.block, accountId);
        break;
      }
      case "kubernetes-cluster": {
        const res = await this.api.get<{ vke_cluster?: VultrKubernetesCluster }>(
          `/kubernetes/clusters/${id}`,
        );
        if (res.vke_cluster) return listers.mapCluster(res.vke_cluster, accountId);
        break;
      }
      case "database": {
        const res = await this.api.get<{ database?: VultrDatabase }>(`/databases/${id}`);
        if (res.database) return listers.mapDatabase(res.database, accountId);
        break;
      }
      case "load-balancer": {
        const res = await this.api.get<{ load_balancer?: VultrLoadBalancer }>(
          `/load-balancers/${id}`,
        );
        if (res.load_balancer) return listers.mapLoadBalancer(res.load_balancer, accountId);
        break;
      }
      case "startup-script": {
        // The list omits the script body; the single read carries it (base64).
        const res = await this.api.get<{ startup_script?: VultrStartupScript }>(
          `/startup-scripts/${id}`,
        );
        if (res.startup_script) {
          const r = listers.mapStartupScript(res.startup_script, accountId);
          r.fields["script"] = fromBase64(res.startup_script.script ?? "");
          return r;
        }
        break;
      }
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === id);
    if (!found) {
      const err = new Error(`Vultr plugin: ${typeId} ${id} not found`) as Error & {
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
      if (outputKey === "kubeconfig") return kubeconfig;
      return /server:\s*(\S+)/.exec(kubeconfig)?.[1] ?? "";
    }
    if (typeId === "database") {
      const res = await this.api.get<{ database?: VultrDatabase }>(`/databases/${id}`);
      const db = res.database;
      if (!db) throw new Error(`Vultr plugin: database ${id} not found`);
      switch (outputKey) {
        case "connectionString":
          return connectionString(db);
        case "host":
          return db.host ?? "";
        case "port":
          return db.port ?? "";
        case "username":
          return db.user ?? "";
        case "password":
          return db.password ?? "";
        case "database":
          return db.dbname ?? "";
        case "caCertificate":
          return pemOf(db.ca_certificate);
      }
    }
    if (typeId === "database-user" && outputKey === "password") {
      const [dbId, username] = [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)];
      const res = await this.api.get<{ user?: { password?: string } }>(
        `/databases/${dbId}/users/${encodeURIComponent(username)}`,
      );
      return res.user?.password ?? "";
    }
    if (typeId === "object-storage" && (outputKey === "accessKey" || outputKey === "secretKey")) {
      const res = await this.api.get<{ object_storage?: VultrObjectStorage }>(
        `/object-storage/${id}`,
      );
      return (
        (outputKey === "accessKey"
          ? res.object_storage?.s3_access_key
          : res.object_storage?.s3_secret_key) ?? ""
      );
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    if (outputKey.endsWith("Id")) return resource.externalId ?? "";
    throw new Error(`Vultr plugin: cannot resolve output "${outputKey}" for ${typeId}`);
  }

  private async kubeconfig(clusterId: string): Promise<string> {
    const res = await this.api.get<{ kube_config?: string }>(
      `/kubernetes/clusters/${clusterId}/config`,
    );
    return res.kube_config ? fromBase64(res.kube_config) : "";
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
    if (typeId === "instance")
      return fetchBandwidthMetrics(this.api, `/instances/${id}/bandwidth`, timeRange);
    if (typeId === "bare-metal")
      return fetchBandwidthMetrics(this.api, `/bare-metals/${id}/bandwidth`, timeRange);
    if (typeId === "database") return fetchDatabaseMetrics(this.api, id);
    return [];
  }

  getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig({ api: this.api, catalog: this.catalog }, typeId, parentResourceId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return createResource(
      { api: this.api, catalog: this.catalog },
      typeId,
      accountId,
      fields,
      parentResourceId,
    );
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
    if (!["instance", "kubernetes-cluster", "node-pool"].includes(typeId)) return {};
    return sizePricing(
      await this.catalog.get(),
      request.regionId,
      request.sizes.map((s) => s.id),
    );
  }

  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    try {
      const plans = await this.catalog.get();
      const planId = fields["plan"];
      const plan = plans.find((p) => p.id === planId);
      if (!plan) return null;
      const monthly = planMonthly(plan, fields["region"]);
      if (monthly === undefined) return null;
      if (typeId === "instance") {
        const backups = fields["backups"] === "true" || fields["backupsEnabled"] === "true";
        return buildCostEstimate([
          { label: `Plan ${plan.id}`, monthlyAmount: monthly },
          // Vultr prices automatic backups at 20% of the plan.
          backups ? { label: "Automatic backups", monthlyAmount: monthly * 0.2 } : null,
        ]);
      }
      if (typeId === "node-pool" || typeId === "kubernetes-cluster") {
        const count = Number(fields["nodeQuantity"] ?? fields["nodeCount"] ?? 1) || 1;
        return buildCostEstimate([
          {
            label: `${plan.id} nodes`,
            monthlyAmount: monthly * count,
            quantity: count,
            unit: "node",
          },
        ]);
      }
      return null;
    } catch {
      return null;
    }
  }

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchVultrCostData(this.api, range);
  }

  fetchCreditBalance(): Promise<CreditBalance[]> {
    return fetchCredits(this.api);
  }

  verifyCredentials(): Promise<PreflightResult> {
    return verifyVultrCredentials(this.api);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "kubernetes-cluster" || formatId !== "kubeconfig") {
      throw new Error(`Vultr plugin: no credential format "${formatId}" for ${typeId}`);
    }
    const id = trailingId(resourceId);
    const content = await this.kubeconfig(id);
    if (!content)
      throw new Error(
        "Vultr has not issued a kubeconfig for this cluster yet; try again once it is active.",
      );
    return {
      content,
      filename: `vke-${id}-kubeconfig.yaml`,
      mimeType: "application/yaml",
      warning: "This file grants full administrative access to the cluster.",
    };
  }

  listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return this.storage.list(bucket, prefix);
  }

  uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return this.storage.upload(bucket, key, file, onProgress);
  }

  makeStorageFolder(bucket: string, key: string): Promise<void> {
    return this.storage.makeFolder(bucket, key);
  }

  deleteStorageObject(bucket: string, key: string): Promise<void> {
    return this.storage.remove(bucket, key);
  }
}
