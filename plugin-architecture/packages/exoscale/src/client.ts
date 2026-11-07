import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import {
  DEFAULT_ZONE,
  type AnyVariant,
  type ExoscaleApi,
  type ZoneApi,
  createExoscaleApi,
  rawId,
  statusOf,
} from "./api.js";
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

const reportMonth = rawId(lastMonth());

const PROBES: Array<{
  id: string;
  label: string;
  read: (z: ZoneApi) => Promise<object>;
  permission: string;
}> = [
  {
    id: "compute",
    label: "Instances, volumes and networking",
    read: (z) => z.get("/instance"),
    permission: "compute service",
  },
  {
    id: "managed",
    label: "SKS, DBaaS and load balancers",
    read: (z) => z.get("/dbaas-service"),
    permission: "dbaas service",
  },
  {
    id: "dns",
    label: "DNS zones and records",
    read: (z) => z.get("/dns-domain"),
    permission: "dns service",
  },
  {
    id: "storage",
    label: "SOS buckets",
    read: (z) => z.get("/sos-buckets-usage"),
    permission: "sos service",
  },
  {
    id: "costs",
    label: "Billing reports and quotas",
    read: (z) => z.get(`/focus-report/${reportMonth}`),
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
  return Object.assign(new Error(`Exoscale plugin: ${typeId} ${resourceId} not found`), {
    status: 404,
  });
}

/** Exoscale client, one per IAM API key (key + secret, EXO2-HMAC-SHA256 signed). */
export class ExoscaleClient implements PluginClient {
  private readonly api: ExoscaleApi;
  private typeCache: { at: number; value: Promise<listers.TypeIndex> } | null = null;

  constructor(
    credentials: Credentials,
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

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const lister = LISTERS[typeId];
      if (!lister) throw new Error(`Exoscale plugin: unknown resource type "${typeId}"`);
      return lister(this.api, accountId, this.types);
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const ext = resourceId.startsWith(`${accountId}:${typeId}:`)
        ? resourceId.slice(accountId.length + typeId.length + 2)
        : resourceId;
      const { zone, id } = zonal(ext);
      const z = this.api.at(zone);
      const ref = rawId(id);
      switch (typeId) {
        case "instance":
          return listers.mapInstance(
            await z.get(`/instance/${ref}`),
            zone,
            accountId,
            await this.types().catch(() => undefined),
          );
        case "block-storage":
          return listers.mapVolume(await z.get(`/block-storage/${ref}`), zone, accountId);
        case "sks-cluster":
          return listers.mapCluster(await z.get(`/sks-cluster/${ref}`), zone, accountId);
        case "nlb":
          return listers.mapNlb(await z.get(`/load-balancer/${ref}`), zone, accountId);
        case "private-network":
          return listers.mapPrivateNetwork(await z.get(`/private-network/${ref}`), zone, accountId);
        case "security-group":
          return listers.mapSecurityGroup(
            await this.api.at(DEFAULT_ZONE).get(`/security-group/${rawId(ext)}`),
            accountId,
          );
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId || r.externalId === ext);
      if (!found) throw notFound(typeId, ext);
      return found;
    });
  }

  private async dbaasService(ext: string): Promise<listers.DbaasService> {
    const { zone, id: name } = zonal(ext);
    const list = await this.api.at(DEFAULT_ZONE).get("/dbaas-service");
    const svc = (list["dbaas-services"] ?? []).find((s) => listers.str(s["name"]) === name);
    if (!svc) throw notFound("dbaas", ext);
    const type = listers.dbaasPath(listers.str(svc["type"]));
    return {
      ...svc,
      ...(await this.api
        .at(listers.str(svc["zone"]) || zone)
        .get(`/dbaas-${rawId(type)}/${rawId(name)}`)),
    };
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const ext = resource.externalId ?? "";
      if (typeId === "sks-cluster" && outputKey === "kubeconfig") return this.kubeconfig(ext);
      if (typeId === "dbaas") {
        const svc = await this.dbaasService(ext);
        const params = svc["uri-params"] ?? {};
        const info: AnyVariant<NonNullable<listers.DbaasService["connection-info"]>> =
          svc["connection-info"] ?? {};
        switch (outputKey) {
          case "connectionString":
            return listers.str(svc["uri"]) || listers.str(info["uri"]?.[0]);
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
        const service = zonal(parts.join("/"));
        const res = await actions.revealPassword(this.api, service.zone, service.id, user);
        return listers.str(res["password"]);
      }
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined) return value;
      throw new Error(`Exoscale plugin: cannot resolve output "${outputKey}" for ${typeId}`);
    });
  }

  /** `POST /sks-cluster-kubeconfig/{id}` returns the file base64-encoded. */
  private async kubeconfig(ext: string): Promise<string> {
    const { zone, id } = zonal(ext);
    const res = await this.api.at(zone).post(`/sks-cluster-kubeconfig/${rawId(id)}`, {
      body: {
        user: "infrawrench-admin",
        groups: ["system:masters"],
        ttl: 30 * 24 * 3600,
      },
    });
    return res.kubeconfig ? base64ToUtf8(res.kubeconfig) : "";
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return enrichDetail(this.api, resource);
    });
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

  fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      return dashboardStats(await runPluginEffect(this.getResource(typeId, resourceId, accountId)));
    });
  }

  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      if (typeId !== "dbaas") return [];
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const { zone, id } = zonal(r.externalId ?? "");
      return fetchDbaasMetrics(this.api, zone, id, timeRange);
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "dbaas")
        throw new Error("Exoscale plugin: logs are available for DBaaS services only");
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const { zone, id } = zonal(r.externalId ?? "");
      const res = await this.api.at(zone).post(`/dbaas-service-logs/${rawId(id)}`, {
        body: {
          limit: Math.min(params.tailLines ?? 200, 1000),
          "sort-order": "desc",
        },
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
    });
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return getCreateConfig(this.api, typeId, parentResourceId);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return createResource(this.api, typeId, accountId, fields, parentResourceId);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      await applyUpdate(this.api, typeId, resourceId, fields);
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      return actions.deleteResource(this.api, typeId, resourceId);
    });
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      return actions.attachResource(
        this.api,
        sourceTypeId,
        sourceResourceId,
        targetTypeId,
        targetResourceId,
      );
    });
  }

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      return actions.invokeAction(this.api, typeId, resourceId, actionId);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      return actions.executeCommand(this.api, typeId, resourceId, command, args);
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchExoscaleCostData(this.api, range, this.services);
    });
  }

  fetchCreditBalance(): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      try {
        const lb = listers.liveBalance(await this.api.at(DEFAULT_ZONE).get("/live-balance"));
        if (typeof lb.balance !== "number" || !lb.currency) return [];
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
    });
  }

  fetchQuotas(): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      return fetchQuotas(this.api);
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      const identity = await this.api
        .at(DEFAULT_ZONE)
        .get("/organization")
        .then((o) => listers.str(o["name"]) || undefined)
        .catch(() => undefined);
      const checks = await Promise.all(
        PROBES.map(async (p) => {
          try {
            await p.read(this.api.at(DEFAULT_ZONE));
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
    });
  }

  exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      if (typeId === "sks-cluster" && formatId === "kubeconfig") {
        const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
    });
  }

  listStorageObjects(bucket: string, prefix: string): PluginEffect<StorageObject[]> {
    return attempt(async () => {
      return storage.listObjects(this.api, bucket, prefix);
    });
  }

  uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): PluginEffect<void> {
    return attempt(async () => {
      return storage.uploadObject(this.api, bucket, key, file, onProgress);
    });
  }

  makeStorageFolder(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      return storage.makeFolder(this.api, bucket, key);
    });
  }

  deleteStorageObject(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      return storage.deleteObject(this.api, bucket, key);
    });
  }
}
