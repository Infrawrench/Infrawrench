import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
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
  StorageObject,
} from "@infrawrench/plugin-base";
import { CreditAccessError, withMetricsCapability } from "@infrawrench/plugin-base";
import * as actions from "./actions.js";
import { DEFAULT_ZONE, type ExoscaleApi, createExoscaleApi, statusOf } from "./api.js";
import { fetchExoscaleCostData } from "./cost-data.js";
import { createResource, getCreateConfig } from "./create.js";
import { enrichDetail } from "./enrich.js";
import * as listers from "./listers.js";
import { DEFAULT_METRICS_WINDOW_MS, fetchDbaasMetrics } from "./metrics.js";
import * as storage from "./object-storage.js";
import { fetchQuotas } from "./quotas.js";
import { dashboardStats, renderDetail, renderSidebarItem } from "./render.js";
import { applyUpdate } from "./update.js";

type Lister = (
  api: ExoscaleApi,
  accountId: string,
  types: () => Promise<listers.TypeIndex>,
) => Promise<ResourceInstance[]>;

const plain =
  (fn: (api: ExoscaleApi, accountId: string) => Promise<ResourceInstance[]>): Lister =>
  (api, accountId) =>
    fn(api, accountId);

const LISTERS: Record<string, Lister> = {
  instance: async (api, acct, types) =>
    listers.listInstances(api, acct, await types().catch(() => undefined)),
  "block-storage": plain(listers.listVolumes),
  "block-storage-snapshot": plain(listers.listVolumeSnapshots),
  snapshot: plain(listers.listSnapshots),
  template: plain(listers.listTemplates),
  "private-network": plain(listers.listPrivateNetworks),
  "security-group": plain(listers.listSecurityGroups),
  "elastic-ip": plain(listers.listElasticIps),
  "sks-cluster": plain(listers.listClusters),
  "sks-nodepool": async (api, acct, types) =>
    listers.listNodepools(api, acct, await types().catch(() => undefined)),
  nlb: plain(listers.listNlbs),
  "instance-pool": async (api, acct, types) =>
    listers.listInstancePools(api, acct, await types().catch(() => undefined)),
  dbaas: plain(listers.listDbaas),
  "dbaas-user": plain(listers.listDbaasUsers),
  "dbaas-database": plain(listers.listDbaasDatabases),
  "dns-domain": plain(listers.listDomains),
  "dns-record": plain(listers.listRecords),
  bucket: plain(listers.listBuckets),
  "ssh-key": plain(listers.listSshKeys),
  "anti-affinity-group": plain(listers.listAntiAffinityGroups),
  organization: plain(listers.listOrganization),
};

const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

const PROBES: Array<{ id: string; label: string; path: string; permission: string }> = [
  {
    id: "compute",
    label: "Instances, volumes and networking",
    path: "/instance",
    permission: "compute service",
  },
  {
    id: "managed",
    label: "SKS, DBaaS and load balancers",
    path: "/dbaas-service",
    permission: "dbaas service",
  },
  { id: "dns", label: "DNS zones and records", path: "/dns-domain", permission: "dns service" },
  { id: "storage", label: "SOS buckets", path: "/sos-buckets-usage", permission: "sos service" },
  {
    id: "costs",
    label: "Billing reports and quotas",
    path: `/focus-report/${lastMonth()}`,
    permission: "billing access",
  },
];

export const EXOSCALE_PREFLIGHT = {
  capabilities: PROBES.map((p) => ({
    id: p.id,
    label: p.label,
    requiredPermissions: [{ id: p.id, label: p.permission }],
    ...(p.id === "compute" ? { essential: true } : {}),
  })),
};

const IAM_HELP = { label: "Manage IAM roles", url: "https://portal.exoscale.com/iam/roles" };

function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Split a `{zone}/{id}` external id (global ids get the default zone). */
function zonal(ext: string): { zone: string; id: string } {
  const i = ext.indexOf("/");
  return i < 0 ? { zone: DEFAULT_ZONE, id: ext } : { zone: ext.slice(0, i), id: ext.slice(i + 1) };
}

function notFound(typeId: string, resourceId: string): Error {
  const err = new Error(`Exoscale plugin: ${typeId} ${resourceId} not found`) as Error & {
    status: number;
  };
  err.status = 404;
  return err;
}

/** Exoscale client, one per IAM API key (key + secret, EXO2-HMAC-SHA256 signed). */
export class ExoscaleClient implements PluginClient {
  private readonly api: ExoscaleApi;
  private typeCache: { at: number; value: Promise<listers.TypeIndex> } | null = null;

  constructor(
    credentials: Record<string, string>,
    private readonly resourceTypes: ResourceTypeDefinition[],
    private readonly services?: HostServices,
  ) {
    const apiKey = credentials["apiKey"]?.trim();
    const apiSecret = credentials["apiSecret"]?.trim();
    if (!apiKey || !apiSecret) throw new Error("Exoscale plugin: enter the API key and its secret");
    this.api = createExoscaleApi({
      apiKey,
      apiSecret,
      services,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
    });
  }

  private types = (): Promise<listers.TypeIndex> => {
    if (!this.typeCache || Date.now() - this.typeCache.at > 6 * 3600_000) {
      const value = listers.loadTypeIndex(this.api);
      value.catch(() => (this.typeCache = null));
      this.typeCache = { at: Date.now(), value };
    }
    return this.typeCache.value;
  };

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const lister = LISTERS[typeId];
    if (!lister) throw new Error(`Exoscale plugin: unknown resource type "${typeId}"`);
    return lister(this.api, accountId, this.types);
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const ext = resourceId.startsWith(`${accountId}:${typeId}:`)
      ? resourceId.slice(accountId.length + typeId.length + 2)
      : resourceId;
    const { zone, id } = zonal(ext);
    switch (typeId) {
      case "instance":
        return listers.mapInstance(
          await this.api.get(zone, `/instance/${id}`),
          zone,
          accountId,
          await this.types().catch(() => undefined),
        );
      case "block-storage":
        return listers.mapVolume(await this.api.get(zone, `/block-storage/${id}`), zone, accountId);
      case "sks-cluster":
        return listers.mapCluster(await this.api.get(zone, `/sks-cluster/${id}`), zone, accountId);
      case "nlb":
        return listers.mapNlb(await this.api.get(zone, `/load-balancer/${id}`), zone, accountId);
      case "private-network":
        return listers.mapPrivateNetwork(
          await this.api.get(zone, `/private-network/${id}`),
          zone,
          accountId,
        );
      case "security-group":
        return listers.mapSecurityGroup(
          await this.api.get(DEFAULT_ZONE, `/security-group/${ext}`),
          accountId,
        );
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId || r.externalId === ext);
    if (!found) throw notFound(typeId, ext);
    return found;
  }

  private async dbaasService(ext: string): Promise<listers.Json> {
    const { zone, id: name } = zonal(ext);
    const list = await this.api.get<{ "dbaas-services"?: listers.Json[] }>(
      DEFAULT_ZONE,
      "/dbaas-service",
    );
    const svc = (list["dbaas-services"] ?? []).find((s) => listers.str(s["name"]) === name);
    if (!svc) throw notFound("dbaas", ext);
    const type = listers.dbaasPath(listers.str(svc["type"]));
    return {
      ...svc,
      ...(await this.api.get<listers.Json>(
        listers.str(svc["zone"]) || zone,
        `/dbaas-${type}/${name}`,
      )),
    };
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const ext = resource.externalId ?? "";
    if (typeId === "sks-cluster" && outputKey === "kubeconfig") return this.kubeconfig(ext);
    if (typeId === "dbaas") {
      const svc = await this.dbaasService(ext);
      const params = (svc["uri-params"] as listers.Json | undefined) ?? {};
      const info = (svc["connection-info"] as listers.Json | undefined) ?? {};
      switch (outputKey) {
        case "connectionString":
          return listers.str(svc["uri"]) || listers.str((info["uri"] as string[] | undefined)?.[0]);
        case "host":
          return listers.str(params["host"]);
        case "port":
          return listers.str(params["port"]);
        case "username":
          return listers.str(params["user"]);
        case "password":
          return listers.str(params["password"]);
      }
    }
    if (typeId === "dbaas-user" && outputKey === "password") {
      const parts = ext.split("/");
      const user = parts.pop() ?? "";
      const res = (await actions.executeCommand(
        this.api,
        "dbaas",
        `${accountId}:dbaas:${parts.join("/")}`,
        "reveal-password",
        [JSON.stringify({ username: user })],
      )) as listers.Json;
      return listers.str(res["password"]);
    }
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Exoscale plugin: cannot resolve output "${outputKey}" for ${typeId}`);
  }

  /** `POST /sks-cluster-kubeconfig/{id}` returns the file base64-encoded. */
  private async kubeconfig(ext: string): Promise<string> {
    const { zone, id } = zonal(ext);
    const res = await this.api.send<{ kubeconfig?: string }>(
      zone,
      "POST",
      `/sks-cluster-kubeconfig/${id}`,
      {
        user: "infrawrench-admin",
        groups: ["system:masters"],
        ttl: 30 * 24 * 3600,
      },
    );
    return res.kubeconfig ? base64ToUtf8(res.kubeconfig) : "";
  }

  enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    return enrichDetail(this.api, resource);
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
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (typeId !== "dbaas") return [];
    const r = await this.getResource(typeId, resourceId, accountId);
    const { zone, id } = zonal(r.externalId ?? "");
    return fetchDbaasMetrics(this.api, zone, id, timeRange);
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "dbaas")
      throw new Error("Exoscale plugin: logs are available for DBaaS services only");
    const r = await this.getResource(typeId, resourceId, accountId);
    const { zone, id } = zonal(r.externalId ?? "");
    const res = await this.api.send<{
      logs?: Array<{ time?: string; node?: string; unit?: string; message?: string }>;
    }>(zone, "POST", `/dbaas-service-logs/${id}`, {
      limit: Math.min(params.tailLines ?? 200, 1000),
      "sort-order": "desc",
    });
    const lines = [...(res.logs ?? [])]
      .reverse()
      .map((l) =>
        `${l.time ?? ""} ${l.node ?? ""} ${l.unit ?? ""} ${l.message ?? ""}`
          .replace(/\s+/g, " ")
          .trim(),
      );
    return {
      text: lines.length ? `${lines.join("\n")}\n` : "",
      containers: ["service"],
      activeContainer: "service",
    };
  }

  getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return getCreateConfig(this.api, typeId, parentResourceId);
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return createResource(this.api, typeId, accountId, fields, parentResourceId);
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

  fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchExoscaleCostData(this.api, range, this.services);
  }

  async fetchCreditBalance(): Promise<CreditBalance[]> {
    try {
      const res = await this.api.get<{ "live-balance"?: { balance?: number; currency?: string } }>(
        DEFAULT_ZONE,
        "/live-balance",
      );
      const lb = res["live-balance"];
      if (!lb || typeof lb.balance !== "number" || !lb.currency) return [];
      return [
        {
          key: "default",
          label: "Account balance",
          remaining: Math.max(0, lb.balance),
          currency: lb.currency,
        },
      ];
    } catch (err) {
      const s = statusOf(err);
      if (s === 401 || s === 403)
        throw new CreditAccessError(
          "This API key's role cannot read the organization balance.",
          IAM_HELP,
        );
      throw err;
    }
  }

  fetchQuotas(): Promise<QuotaUsage[]> {
    return fetchQuotas(this.api);
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const identity = await this.api
      .get<listers.Json>(DEFAULT_ZONE, "/organization")
      .then((o) => listers.str(o["name"]) || undefined)
      .catch(() => undefined);
    const checks = await Promise.all(
      PROBES.map(async (p) => {
        try {
          await this.api.get(DEFAULT_ZONE, p.path);
          return { capabilityId: p.id, status: "ok" as const };
        } catch (err) {
          const status = statusOf(err);
          // No report yet for a new organization is still access.
          if (status === 404 && p.id === "costs")
            return { capabilityId: p.id, status: "ok" as const };
          if (status === 401 || status === 403) {
            return {
              capabilityId: p.id,
              status: "missing" as const,
              missingPermissions: [{ id: p.id, label: p.permission }],
              message:
                status === 401
                  ? "Exoscale rejected the key. Check the key and secret, and that the key has not been revoked."
                  : "The key's IAM role does not allow this. Add the service to the role in the Portal under IAM, Roles.",
              helpLink: IAM_HELP,
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
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId === "sks-cluster" && formatId === "kubeconfig") {
      const r = await this.getResource(typeId, resourceId, accountId);
      const content = await this.kubeconfig(r.externalId ?? "");
      if (!content)
        throw new Error(
          "Exoscale did not return a kubeconfig; try again once the cluster is running.",
        );
      return {
        content,
        filename: `${r.displayName || "sks"}-kubeconfig.yaml`,
        mimeType: "application/yaml",
        warning: "This file grants full administrative access to the cluster for 30 days.",
      };
    }
    throw new Error(`Exoscale plugin: no credential format "${formatId}" for ${typeId}`);
  }

  listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return storage.listObjects(this.api, bucket, prefix);
  }

  uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return storage.uploadObject(this.api, bucket, key, file, onProgress);
  }

  makeStorageFolder(bucket: string, key: string): Promise<void> {
    return storage.makeFolder(this.api, bucket, key);
  }

  deleteStorageObject(bucket: string, key: string): Promise<void> {
    return storage.deleteObject(this.api, bucket, key);
  }
}
