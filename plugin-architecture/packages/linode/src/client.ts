import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import { withMetricsCapability } from "@infrawrench/plugin-base";
import * as actions from "./actions.js";
import { type LinodeApi, createLinodeApi, segment, trailingId } from "./api.js";
import { fetchLinodeCostData } from "./cost-data.js";
import { createResource, getCreateConfig } from "./create.js";
import { fetchCredits } from "./credits.js";
import { enrichDetail } from "./enrich.js";
import { estimateFromCatalog, sizePricing } from "./estimate.js";
import * as listers from "./listers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  fetchDatabaseMetrics,
  fetchLinodeMetrics,
  fetchNodeBalancerMetrics,
} from "./metrics.js";
import * as objects from "./object-storage.js";
import { verifyLinodeCredentials } from "./preflight.js";
import { type PriceCatalogCache, createPriceCatalogCache } from "./pricing.js";
import { buildLkeNodeRates } from "./lke-node-rates.js";
import { dashboardStats, renderDetail, renderSidebarItem } from "./render.js";
import { applyUpdate } from "./update.js";
import type {
  CiComputeStatus,
  CiExecutorKind,
  CiHandle,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
} from "@infrawrench/plugin-base";
import {
  linodeCiListTagged,
  linodeCiPreflight,
  linodeCiStart,
  linodeCiStatus,
  linodeCiTeardown,
} from "./ci-executor.js";

type Lister = (api: LinodeApi, accountId: string) => Promise<ResourceInstance[]>;

const LISTERS: Record<string, Lister> = {
  linode: listers.listLinodes,
  volume: listers.listVolumes,
  nodebalancer: listers.listNodeBalancers,
  "lke-cluster": listers.listLkeClusters,
  "lke-node-pool": listers.listLkePools,
  bucket: listers.listBuckets,
  database: listers.listDatabases,
  firewall: listers.listFirewalls,
  vpc: listers.listVpcs,
  "reserved-ip": listers.listReservedIps,
  domain: listers.listDomains,
  "domain-record": listers.listDomainRecords,
  image: listers.listImages,
  stackscript: listers.listStackScripts,
  account: listers.listAccount,
  invoice: listers.listInvoices,
};

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Linode (Akamai Cloud Computing) client, one per account (one personal
 * access token). All provider logic lives in the sibling modules; this class
 * only routes the host's calls to them.
 */
export class LinodeClient implements PluginClient {
  private readonly api: LinodeApi;
  private readonly catalog: PriceCatalogCache;
  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(
    credentials: Credentials,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const token = credentials["apiToken"]?.trim();
    if (!token) throw new Error("Linode plugin: missing apiToken credential");
    this.api = createLinodeApi({
      token,
      services,
      ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
    });
    this.catalog = createPriceCatalogCache(this.api);
    this.resourceTypes = resourceTypes;
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const lister = LISTERS[typeId];
      if (!lister) throw new Error(`Linode plugin: unknown resource type "${typeId}"`);
      return lister(this.api, accountId);
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = trailingId(resourceId);
      if (typeId === "linode") {
        const [linode, firewalls] = await Promise.all([
          this.api.get(`/linode/instances/${segment(id)}`),
          this.api.getAll(`/linode/instances/${segment(id)}/firewalls`, "data").catch(() => null),
        ]);
        return listers.mapLinode(
          linode,
          accountId,
          firewalls ? firewalls.map((f) => String(f.id)) : null,
        );
      }
      if (typeId === "database") {
        const [engine, dbId] = id.split("/");
        const db = await this.api.get(`/databases/${segment(engine)}/instances/${segment(dbId)}`);
        return listers.mapDatabase({ ...db, engine: db.engine ?? engine ?? "" }, accountId);
      }
      const all = await runPluginEffect(this.listResources(typeId, accountId));
      const found = all.find((r) => r.id === resourceId || r.externalId === id);
      if (!found) throw new Error(`Linode plugin: ${typeId} ${id} not found`);
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
      const id = trailingId(resourceId);
      if (typeId === "database") return this.resolveDatabaseOutput(id, outputKey);
      if (typeId === "lke-cluster") {
        switch (outputKey) {
          case "clusterId":
            return id;
          case "kubeconfig": {
            const res = await this.api.get(`/lke/clusters/${segment(id)}/kubeconfig`);
            return res.kubeconfig ? decodeBase64(res.kubeconfig) : "";
          }
          case "apiEndpoint": {
            const res = await this.api.getAll(`/lke/clusters/${segment(id)}/api-endpoints`, "data");
            return res[0]?.endpoint ?? "";
          }
          case "nodeHourlyRates":
            return this.nodeHourlyRates(id);
        }
      }
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey];
      if (value !== undefined) return value;
      if (outputKey.endsWith("Id")) return resource.externalId ?? "";
      throw new Error(`Linode plugin: cannot resolve output "${outputKey}" for ${typeId}`);
    });
  }

  private async resolveDatabaseOutput(id: string, outputKey: string): Promise<string> {
    const [engine, dbId] = id.split("/");
    const e = segment(engine);
    const d = segment(dbId);
    if (outputKey === "caCertificate") {
      const ssl = await this.api.get(`/databases/${e}/instances/${d}/ssl`);
      return ssl.ca_certificate ? decodeBase64(ssl.ca_certificate) : "";
    }
    const db = await this.api.get(`/databases/${e}/instances/${d}`);
    const host = db.hosts?.primary ?? "";
    const port = String(db.port ?? (engine === "postgresql" ? 5432 : 3306));
    // The current platform (`rdbms-default`) creates `defaultdb`; legacy
    // clusters used the engine's own default database.
    const database =
      db.platform === "rdbms-legacy"
        ? engine === "postgresql"
          ? "postgres"
          : "mysql"
        : "defaultdb";
    if (outputKey === "host") return host;
    if (outputKey === "port") return port;
    if (outputKey === "database") return database;
    const creds = await this.api.get(`/databases/${e}/instances/${d}/credentials`);
    if (outputKey === "username") return creds.username ?? "";
    if (outputKey === "password") return creds.password ?? "";
    if (outputKey === "connectionString") {
      const user = encodeURIComponent(creds.username ?? "");
      const pass = encodeURIComponent(creds.password ?? "");
      return engine === "postgresql"
        ? `postgresql://${user}:${pass}@${host}:${port}/${database}?sslmode=require`
        : `mysql://${user}:${pass}@${host}:${port}/${database}`;
    }
    throw new Error(`Linode plugin: unknown database output "${outputKey}"`);
  }

  private async nodeHourlyRates(clusterId: string): Promise<string> {
    try {
      const [cluster, pools, catalog] = await Promise.all([
        this.api.get(`/lke/clusters/${segment(clusterId)}`),
        this.api.getAll(`/lke/clusters/${segment(clusterId)}/pools`, "data"),
        this.catalog.get(),
      ]);
      return buildLkeNodeRates(cluster, pools, catalog);
    } catch {
      return "";
    }
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return enrichDetail(this.api, this.catalog, resource);
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
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const id = trailingId(resourceId);
      if (typeId === "linode") return fetchLinodeMetrics(this.api, id, timeRange);
      if (typeId === "nodebalancer") return fetchNodeBalancerMetrics(this.api, id, timeRange);
      if (typeId === "database")
        return fetchDatabaseMetrics(this.api, id.split("/")[1] ?? id, timeRange);
      return [];
    });
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return getCreateConfig({ api: this.api, catalog: this.catalog }, typeId, parentResourceId);
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return createResource(
        { api: this.api, catalog: this.catalog },
        typeId,
        accountId,
        fields,
        parentResourceId,
      );
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

  getCreateSizePricing(
    typeId: string,
    request: CreateSizePricingRequest,
  ): PluginEffect<Record<string, number>> {
    return attempt(async () => {
      if (!["linode", "lke-cluster", "lke-node-pool"].includes(typeId)) return {};
      return sizePricing(
        await this.catalog.get(),
        request.regionId,
        request.sizes.map((s) => s.id),
      );
    });
  }

  estimateCost(typeId: string, fields: Record<string, string>): PluginEffect<CostEstimate | null> {
    return attempt(async () => {
      try {
        return estimateFromCatalog(await this.catalog.get(), typeId, fields);
      } catch {
        return null;
      }
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchLinodeCostData({ api: this.api, catalog: () => this.catalog.get() }, range);
    });
  }

  fetchCreditBalance(): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      return fetchCredits(this.api);
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return verifyLinodeCredentials(this.api);
    });
  }

  exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      if (typeId !== "lke-cluster" || formatId !== "kubeconfig") {
        throw new Error(`Linode plugin: no credential format "${formatId}" for ${typeId}`);
      }
      const id = trailingId(resourceId);
      const res = await this.api.get(`/lke/clusters/${segment(id)}/kubeconfig`);
      if (!res.kubeconfig)
        throw new Error(
          "Linode has not issued a kubeconfig for this cluster yet; try again once it is ready.",
        );
      return {
        content: decodeBase64(res.kubeconfig),
        filename: `lke-${id}-kubeconfig.yaml`,
        mimeType: "application/yaml",
        warning:
          "This file grants full administrative access to the cluster. Regenerate the kubeconfig from the cluster page if it leaks.",
      };
    });
  }

  ciPreflight(kind: CiExecutorKind, region?: string): PluginEffect<CiPreflightResult> {
    return attempt(() => linodeCiPreflight(this.api, kind, region));
  }

  ciStart(spec: CiStartSpec): PluginEffect<CiHandle> {
    return attempt(() => linodeCiStart(this.api, spec));
  }

  ciStatus(handle: CiHandle): PluginEffect<CiComputeStatus> {
    return attempt(() => linodeCiStatus(this.api, handle));
  }

  ciTeardown(handle: CiHandle): PluginEffect<void> {
    return attempt(() => linodeCiTeardown(this.api, handle));
  }

  ciListTagged(tagKey: string, _regions: readonly string[]): PluginEffect<CiTaggedCompute[]> {
    return attempt(() => linodeCiListTagged(this.api, tagKey));
  }

  listStorageObjects(bucket: string, prefix: string): PluginEffect<StorageObject[]> {
    return attempt(async () => {
      return objects.listObjects(this.api, bucket, prefix);
    });
  }

  uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): PluginEffect<void> {
    return attempt(async () => {
      return objects.uploadObject(this.api, bucket, key, file, onProgress);
    });
  }

  makeStorageFolder(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      return objects.makeFolder(this.api, bucket, key);
    });
  }

  deleteStorageObject(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      return objects.deleteObject(this.api, bucket, key);
    });
  }
}
