import type {
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  PluginClient,
  PreflightResult,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { withMetricsCapability } from "@infrawrench/plugin-base";
import * as actions from "./actions.js";
import { type CivoApi, createCivoApi, regional, statusOf } from "./api.js";
import { createResource, getCreateConfig } from "./create.js";
import { enrichDetail } from "./enrich.js";
import * as listers from "./listers.js";
import { ObjectStoreBrowser } from "./object-storage.js";
import { fetchQuotas } from "./quotas.js";
import { RegionCache } from "./regions.js";
import { dashboardStats, renderDetail, renderSidebarItem } from "./render.js";
import type {
  CivoCluster,
  CivoDatabase,
  CivoInstance,
  CivoObjectStoreCredential,
} from "./types.js";
import { applyUpdate } from "./update.js";

type Lister = (ctx: listers.ListContext, accountId: string) => Promise<ResourceInstance[]>;

const LISTERS: Record<string, Lister> = {
  instance: listers.listInstances,
  volume: listers.listVolumes,
  "volume-snapshot": listers.listVolumeSnapshots,
  "instance-snapshot": listers.listInstanceSnapshots,
  "kubernetes-cluster": listers.listClusters,
  "node-pool": listers.listPools,
  database: listers.listDatabases,
  "database-backup": listers.listDatabaseBackups,
  "load-balancer": listers.listLoadBalancers,
  firewall: listers.listFirewalls,
  network: listers.listNetworks,
  "reserved-ip": listers.listIps,
  domain: listers.listDomains,
  "dns-record": listers.listDnsRecords,
  "object-store": listers.listObjectStores,
  "object-store-credential": listers.listCredentials,
  "ssh-key": listers.listSshKeys,
  account: listers.listAccount,
};

/** Connection URI for a Civo database's default user. */
export function connectionString(db: CivoDatabase): string {
  const host = db.dns_entry || db.public_ipv4 || "";
  const user = encodeURIComponent(db.username ?? "");
  const pass = encodeURIComponent(db.password ?? "");
  const port = db.port ?? "";
  const pg = (db.software ?? "").toLowerCase().startsWith("postgres");
  return pg
    ? `postgresql://${user}:${pass}@${host}:${port}/postgres?sslmode=require`
    : `mysql://${user}:${pass}@${host}:${port}/mysql`;
}

const PROBES: Array<{ id: string; label: string; path: string }> = [
  { id: "compute", label: "Instances, volumes and networking", path: "/instances" },
  { id: "kubernetes", label: "Kubernetes", path: "/kubernetes/clusters" },
  { id: "databases", label: "Databases", path: "/databases" },
  { id: "dns", label: "DNS", path: "/dns" },
  { id: "quota", label: "Quota and usage", path: "/quota" },
];

export const CIVO_PREFLIGHT = {
  capabilities: PROBES.map((p) => ({
    id: p.id,
    label: p.label,
    requiredPermissions: [{ id: "api-key", label: "Account API key" }],
    ...(p.id === "compute" ? { essential: true } : {}),
  })),
};

/** Civo client, one per account (one API key). */
export class CivoClient implements PluginClient {
  private readonly api: CivoApi;
  private readonly ctx: listers.ListContext;
  private readonly storage: ObjectStoreBrowser;

  constructor(
    credentials: Record<string, string>,
    private readonly resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = credentials["apiKey"]?.trim();
    if (!apiKey) throw new Error("Civo plugin: missing apiKey credential");
    this.api = createCivoApi({
      apiKey,
      services,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
    });
    this.ctx = { api: this.api, regions: new RegionCache(this.api) };
    this.storage = new ObjectStoreBrowser(this.api);
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = LISTERS[typeId];
    if (!lister) throw new Error(`Civo plugin: unknown resource type "${typeId}"`);
    return lister(this.ctx, accountId);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const { region, id } = regional(resourceId);
    if (typeId === "instance")
      return listers.mapInstance(
        await this.api.get<CivoInstance>(`/instances/${id}`, { region }),
        region,
        accountId,
      );
    if (typeId === "kubernetes-cluster") {
      return listers.mapCluster(
        await this.api.get<CivoCluster>(`/kubernetes/clusters/${id}`, { region }),
        region,
        accountId,
      );
    }
    if (typeId === "database")
      return listers.mapDatabase(
        await this.api.get<CivoDatabase>(`/databases/${id}`, { region }),
        region,
        accountId,
      );
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) {
      const err = new Error(`Civo plugin: ${typeId} ${id} not found`) as Error & { status: number };
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
    const { region, id } = regional(resourceId);
    if (
      typeId === "kubernetes-cluster" &&
      (outputKey === "kubeconfig" || outputKey === "apiEndpoint")
    ) {
      const c = await this.api.get<CivoCluster>(`/kubernetes/clusters/${id}`, { region });
      return (outputKey === "kubeconfig" ? c.kubeconfig : c.api_endpoint) ?? "";
    }
    if (typeId === "instance" && outputKey === "initialPassword") {
      return (
        (await this.api.get<CivoInstance>(`/instances/${id}`, { region })).initial_password ?? ""
      );
    }
    if (typeId === "database") {
      const db = await this.api.get<CivoDatabase>(`/databases/${id}`, { region });
      switch (outputKey) {
        case "connectionString":
          return connectionString(db);
        case "host":
          return db.dns_entry || db.public_ipv4 || "";
        case "port":
          return String(db.port ?? "");
        case "username":
          return db.username ?? "";
        case "password":
          return db.password ?? "";
        case "database":
          return (db.software ?? "").toLowerCase().startsWith("postgres") ? "postgres" : "mysql";
      }
    }
    if (
      typeId === "object-store-credential" &&
      (outputKey === "secretKey" || outputKey === "accessKey")
    ) {
      const c = await this.api.get<CivoObjectStoreCredential>(`/objectstore/credentials/${id}`, {
        region,
      });
      return (outputKey === "secretKey" ? c.secret_access_key_id : c.access_key_id) ?? "";
    }
    if (typeId === "object-store" && (outputKey === "secretKey" || outputKey === "accessKey")) {
      const access = await this.storage.access(`${region}/${id}`);
      return outputKey === "secretKey" ? access.config.secretKey : access.config.accessKey;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Civo plugin: cannot resolve output "${outputKey}" for ${typeId}`);
  }

  enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    return enrichDetail(this.api, resource);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return withMetricsCapability(
      renderDetail(resource, this.resourceTypes),
      this.resourceTypes,
      resource.resourceTypeId,
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

  getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(this.ctx, typeId, parentResourceId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return createResource(this.ctx, typeId, accountId, fields, parentResourceId);
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

  fetchQuotas(): Promise<QuotaUsage[]> {
    return fetchQuotas(this.api);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const region = (await this.ctx.regions.codes())[0];
    const checks = await Promise.all(
      PROBES.map(async (p) => {
        try {
          await this.api.get(
            p.path,
            region && p.id !== "dns" && p.id !== "quota" ? { region } : undefined,
          );
          return { capabilityId: p.id, status: "ok" as const };
        } catch (err) {
          const status = statusOf(err);
          if (status === 401 || status === 403) {
            return {
              capabilityId: p.id,
              status: "missing" as const,
              missingPermissions: [{ id: "api-key", label: "Account API key" }],
              message: "Civo rejected the key. Copy a key from Profile, Security, API Keys.",
              helpLink: {
                label: "Open Civo security settings",
                url: "https://dashboard.civo.com/security",
              },
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
    return { checks };
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "kubernetes-cluster" || formatId !== "kubeconfig") {
      throw new Error(`Civo plugin: no credential format "${formatId}" for ${typeId}`);
    }
    const { region, id } = regional(resourceId);
    const c = await this.api.get<CivoCluster>(`/kubernetes/clusters/${id}`, { region });
    if (!c.kubeconfig)
      throw new Error(
        "Civo has not issued a kubeconfig for this cluster yet; try again once it is ready.",
      );
    return {
      content: c.kubeconfig,
      filename: `${c.name ?? id}-kubeconfig.yaml`,
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
