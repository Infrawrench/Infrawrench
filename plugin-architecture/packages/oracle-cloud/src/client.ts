import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
import type {
  CostEstimate,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  CredentialExport,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  ResourceTypeDefinition,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { externalIdOf, ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";
import type {
  CiComputeStatus,
  CiExecutorKind,
  CiHandle,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
} from "@infrawrench/plugin-base";
import { OciApi, isAuthorizationGap } from "./api.js";
import {
  oracleCiListTagged,
  oracleCiPreflight,
  oracleCiStart,
  oracleCiStatus,
  oracleCiTeardown,
} from "./ci-executor.js";
import type { OciCiContext } from "./ci-shared.js";
import { fetchCarbonReport, fetchCommitmentBalances, fetchServiceLimits } from "./billing.js";
import { fetchOciCostData, monthToDateWithForecast } from "./cost-data.js";
import { createResource, getCreateConfig, listShapes, type CreateContext } from "./create.js";
import { fetchOciPriceCatalog } from "./price-catalog.js";
import type { PriceCatalogRequest, PriceCatalogResult } from "@infrawrench/plugin-base";
import { OciInventory } from "./inventory.js";
import {
  getBucket,
  getInstance,
  listAlertRules,
  listAutonomousDatabases,
  listBlockVolumes,
  listBootVolumes,
  listBudgets,
  listBuckets,
  listCompartments,
  listInstances,
  listLoadBalancers,
  listNodePools,
  listOkeClusters,
  listReservedIps,
  listSecurityLists,
  listSubnets,
  listTenancy,
  listVcns,
  objectStorageNamespace,
  parseBucketExternalId,
  parseSizeId,
  type ListContext,
} from "./listers.js";
import { dimensionFilter, fetchSeries, metricSpecs, type MetricTarget } from "./metrics.js";
import { estimateFor, priceRates } from "./pricing.js";
import { DEFAULT_REGION } from "./regions.js";
import { renderDetail, renderSidebarItem } from "./render.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const INSTANCE_ACTIONS = new Set(["START", "STOP", "SOFTSTOP", "RESET", "SOFTRESET"]);
const ADB_ACTIONS = new Set(["start", "stop", "restart"]);
/** 100 pages of 1,000 objects. */
const FOLDER_MAX_PAGES = 100;

/** Types whose listing can be narrowed to one region when the OCID names it. */
const REGIONAL_TYPES = new Set([
  "instance",
  "boot-volume",
  "block-volume",
  "vcn",
  "subnet",
  "security-list",
  "reserved-ip",
  "load-balancer",
  "autonomous-database",
  "oke-cluster",
  "node-pool",
]);

/**
 * Oracle Cloud Infrastructure plugin client, one per account (API signing
 * key). See `api.ts` for signing and transport, `inventory.ts` for how the
 * tenancy is walked, and `listers.ts` for each type.
 */
export class OracleCloudClient implements PluginClient {
  private readonly api: OciApi;
  private readonly inventory: OciInventory;
  private readonly services: HostServices | undefined;
  private readonly resourceTypes: ResourceTypeDefinition[];

  constructor(credentials: Credentials, services?: HostServices) {
    const tenancyOcid = (credentials["tenancyOcid"] ?? "").trim();
    const userOcid = (credentials["userOcid"] ?? "").trim();
    const fingerprint = (credentials["fingerprint"] ?? "").trim();
    const privateKeyPem = credentials["privateKey"] ?? "";
    if (!tenancyOcid) throw new Error("Oracle Cloud plugin: missing tenancyOcid credential");
    if (!userOcid) throw new Error("Oracle Cloud plugin: missing userOcid credential");
    if (!fingerprint) throw new Error("Oracle Cloud plugin: missing fingerprint credential");
    if (!privateKeyPem) throw new Error("Oracle Cloud plugin: missing privateKey credential");
    const region = (credentials["region"] ?? "").trim() || DEFAULT_REGION;
    this.services = services;
    this.api = new OciApi(
      { tenancyOcid, userOcid, fingerprint, privateKeyPem },
      services?.http,
      credentials["caCert"] ?? "",
    );
    this.inventory = new OciInventory(this.api, region);
    this.resourceTypes = RESOURCE_TYPES;
  }

  private ctx(accountId: string, regionHint?: string): CreateContext {
    return {
      api: this.api,
      inventory: this.inventory,
      accountId,
      ...(regionHint ? { regionHint } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    };
  }

  private get home(): string {
    return this.inventory.homeRegion;
  }

  // -------------------------------------------------------------------------
  // Listing

  listResources(
    typeId: string,
    accountId: string,
    opts?: { regionHint?: string },
  ): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      const ctx = this.ctx(accountId, opts?.regionHint);
      switch (typeId) {
        case "tenancy":
          return listTenancy(ctx);
        case "compartment":
          return listCompartments(ctx);
        case "instance":
          return listInstances(ctx);
        case "boot-volume":
          return listBootVolumes(ctx);
        case "block-volume":
          return listBlockVolumes(ctx);
        case "vcn":
          return listVcns(ctx);
        case "subnet":
          return listSubnets(ctx);
        case "security-list":
          return listSecurityLists(ctx);
        case "reserved-ip":
          return listReservedIps(ctx);
        case "load-balancer":
          return listLoadBalancers(ctx);
        case "bucket":
          return listBuckets(ctx);
        case "autonomous-database":
          return listAutonomousDatabases(ctx);
        case "oke-cluster":
          return listOkeClusters(ctx);
        case "node-pool":
          return listNodePools(ctx);
        case "budget":
          return listBudgets(ctx);
        case "budget-alert-rule":
          return listAlertRules(ctx);
        default:
          throw new Error(`Oracle Cloud plugin: unknown resource type "${typeId}"`);
      }
    });
  }

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const externalId = externalIdOf(resourceId);
      const ctx = this.ctx(accountId);
      if (typeId === "instance") return getInstance(ctx, externalId);
      if (typeId === "bucket") {
        const { region, name } = parseBucketExternalId(externalId);
        return getBucket(ctx, region, name);
      }
      let regionHint: string | undefined;
      if (REGIONAL_TYPES.has(typeId)) {
        regionHint = await this.inventory.regionOfOcid(externalId).catch(() => undefined);
      }
      const all = await runPluginEffect(
        this.listResources(typeId, accountId, regionHint ? { regionHint } : undefined),
      );
      const found = all.find((r) => r.externalId === externalId);
      if (!found)
        throw new Error(`Oracle Cloud plugin: resource ${typeId}/${externalId} not found`);
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
      if (outputKey === "id" && typeId !== "bucket") return externalIdOf(resourceId);
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const value = resource.resolvedOutputs[outputKey];
      if (value === undefined) {
        throw new Error(
          `Oracle Cloud plugin: cannot resolve output "${outputKey}" for "${typeId}"`,
        );
      }
      return value;
    });
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (resource.resourceTypeId !== "tenancy") return resource;
      const [mtd, carbon, commitments] = await Promise.allSettled([
        monthToDateWithForecast(this.api, this.home),
        fetchCarbonReport(this.api, this.home),
        fetchCommitmentBalances(this.api, this.home),
      ]);
      const fields = { ...resource.fields };
      if (mtd.status === "fulfilled") fields["_mtd"] = JSON.stringify(mtd.value);
      if (carbon.status === "fulfilled") fields["_carbon"] = JSON.stringify(carbon.value);
      if (commitments.status === "fulfilled")
        fields["_commitments"] = JSON.stringify(commitments.value);
      return { ...resource, fields };
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderSidebarItem(resource);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete / actions

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return getCreateConfig(this.ctx(""), typeId, parentResourceId);
    });
  }

  /** VM shapes at list price (the org-level price catalog). */
  fetchPriceCatalog(request: PriceCatalogRequest): PluginEffect<PriceCatalogResult> {
    return attempt(async () => {
      const ctx = this.ctx("");
      return fetchOciPriceCatalog(
        { listShapes: () => listShapes(ctx), rates: () => priceRates(ctx.http) },
        request,
      );
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return createResource(this.ctx(accountId), typeId, fields, parentResourceId);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const region = await this.inventory.regionOfOcid(id).catch(() => this.home);
      const put = (
        service: Parameters<OciApi["request"]>[0]["service"],
        path: string,
        body: unknown,
        r = region,
      ) => this.api.request({ service, region: r, method: "PUT", path, body });
      const name = fields["name"];
      switch (typeId) {
        case "compartment":
          await put(
            "identity",
            `/20160918/compartments/${id}`,
            {
              ...(name ? { name } : {}),
              ...(fields["description"] !== undefined
                ? { description: fields["description"] }
                : {}),
            },
            this.home,
          );
          break;
        case "instance": {
          const body: Record<string, unknown> = {};
          if (name) body["displayName"] = name;
          if (fields["size"]) {
            const { shape, ocpus, memoryGb } = parseSizeId(fields["size"]);
            body["shape"] = shape;
            if (ocpus !== undefined && memoryGb !== undefined) {
              body["shapeConfig"] = { ocpus, memoryInGBs: memoryGb };
            }
          }
          await put("iaas", `/20160918/instances/${id}`, body);
          break;
        }
        case "boot-volume":
        case "block-volume": {
          const body: Record<string, unknown> = {};
          if (name) body["displayName"] = name;
          if (fields["sizeGb"]) body["sizeInGBs"] = Number(fields["sizeGb"]);
          if (fields["vpusPerGb"] !== undefined && fields["vpusPerGb"] !== "") {
            body["vpusPerGB"] = Number(fields["vpusPerGb"]);
          }
          await put(
            "iaas",
            `/20160918/${typeId === "boot-volume" ? "bootVolumes" : "volumes"}/${id}`,
            body,
          );
          break;
        }
        case "vcn":
        case "subnet":
        case "security-list":
        case "reserved-ip": {
          const collection = {
            vcn: "vcns",
            subnet: "subnets",
            "security-list": "securityLists",
            "reserved-ip": "publicIps",
          }[typeId];
          if (name) await put("iaas", `/20160918/${collection}/${id}`, { displayName: name });
          break;
        }
        case "load-balancer": {
          if (name) await put("iaas", `/20170115/loadBalancers/${id}`, { displayName: name });
          if (fields["minBandwidthMbps"] || fields["maxBandwidthMbps"]) {
            const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
            await put("iaas", `/20170115/loadBalancers/${id}/updateShape`, {
              shapeName: "flexible",
              shapeDetails: {
                minimumBandwidthInMbps: Number(
                  fields["minBandwidthMbps"] ?? current.fields["minBandwidthMbps"] ?? 10,
                ),
                maximumBandwidthInMbps: Number(
                  fields["maxBandwidthMbps"] ?? current.fields["maxBandwidthMbps"] ?? 100,
                ),
              },
            });
          }
          break;
        }
        case "bucket": {
          const { region: bucketRegion, name: bucket } = parseBucketExternalId(id);
          const ns = await objectStorageNamespace(this.api, bucketRegion);
          const body: Record<string, unknown> = {};
          for (const key of ["publicAccessType", "versioning", "autoTiering"]) {
            if (fields[key]) body[key] = fields[key];
          }
          // UpdateBucket is a POST, not a PUT.
          await this.api.request({
            service: "objectstorage",
            region: bucketRegion,
            method: "POST",
            path: `/n/${encodeURIComponent(ns)}/b/${encodeURIComponent(bucket)}`,
            body,
          });
          return getBucket(this.ctx(accountId), bucketRegion, bucket);
        }
        case "autonomous-database": {
          // OCI refuses scale changes combined with most other updates, so the
          // rename and the scale go in separate requests.
          if (name)
            await put("database", `/20160918/autonomousDatabases/${id}`, { displayName: name });
          const scale: Record<string, unknown> = {};
          if (fields["computeCount"]) scale["computeCount"] = Number(fields["computeCount"]);
          if (fields["storageTb"]) scale["dataStorageSizeInTBs"] = Number(fields["storageTb"]);
          if (fields["autoScaling"] !== undefined && fields["autoScaling"] !== "") {
            scale["isAutoScalingEnabled"] = fields["autoScaling"] === "true";
          }
          if (Object.keys(scale).length) {
            await put("database", `/20160918/autonomousDatabases/${id}`, scale);
          }
          break;
        }
        case "oke-cluster": {
          const body: Record<string, unknown> = {};
          if (name) body["name"] = name;
          if (fields["kubernetesVersion"]) body["kubernetesVersion"] = fields["kubernetesVersion"];
          if (fields["clusterType"]) body["type"] = fields["clusterType"];
          await put("containerengine", `/20180222/clusters/${id}`, body);
          break;
        }
        case "node-pool": {
          const body: Record<string, unknown> = {};
          if (name) body["name"] = name;
          if (fields["nodeCount"])
            body["nodeConfigDetails"] = { size: Number(fields["nodeCount"]) };
          await put("containerengine", `/20180222/nodePools/${id}`, body);
          break;
        }
        case "budget": {
          const body: Record<string, unknown> = {};
          if (name) body["displayName"] = name;
          if (fields["description"] !== undefined) body["description"] = fields["description"];
          if (fields["amount"]) body["amount"] = Math.round(Number(fields["amount"]));
          await put("usage", `/20190111/budgets/${id}`, body, this.home);
          break;
        }
        case "budget-alert-rule": {
          const [budgetId, ruleId] = id.split("/");
          const body: Record<string, unknown> = {};
          if (name) body["displayName"] = name;
          for (const key of ["type", "thresholdType", "message"]) {
            if (fields[key] !== undefined) body[key] = fields[key];
          }
          if (fields["threshold"]) body["threshold"] = Number(fields["threshold"]);
          if (fields["recipients"] !== undefined) {
            body["recipients"] = fields["recipients"]
              .split(/[,;\s]+/)
              .filter(Boolean)
              .join(", ");
          }
          await put("usage", `/20190111/budgets/${budgetId}/alertRules/${ruleId}`, body, this.home);
          break;
        }
        default:
          throw new Error(`Oracle Cloud plugin: "${typeId}" cannot be edited`);
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const region = await this.inventory.regionOfOcid(id).catch(() => this.home);
      const del = (
        service: Parameters<OciApi["request"]>[0]["service"],
        path: string,
        r = region,
        query?: Record<string, string | boolean>,
      ) =>
        this.api.request({
          service,
          region: r,
          method: "DELETE",
          path,
          ...(query ? { query } : {}),
        });
      switch (typeId) {
        case "compartment":
          await del("identity", `/20160918/compartments/${id}`, this.home);
          return;
        case "instance":
          await del("iaas", `/20160918/instances/${id}`, region, { preserveBootVolume: false });
          return;
        case "boot-volume":
          await del("iaas", `/20160918/bootVolumes/${id}`);
          return;
        case "block-volume":
          await del("iaas", `/20160918/volumes/${id}`);
          return;
        case "vcn":
          await del("iaas", `/20160918/vcns/${id}`);
          return;
        case "subnet":
          await del("iaas", `/20160918/subnets/${id}`);
          return;
        case "security-list":
          await del("iaas", `/20160918/securityLists/${id}`);
          return;
        case "reserved-ip":
          await del("iaas", `/20160918/publicIps/${id}`);
          return;
        case "load-balancer":
          await del("iaas", `/20170115/loadBalancers/${id}`);
          return;
        case "bucket": {
          const { region: bucketRegion, name } = parseBucketExternalId(id);
          const ns = await objectStorageNamespace(this.api, bucketRegion);
          await del(
            "objectstorage",
            `/n/${encodeURIComponent(ns)}/b/${encodeURIComponent(name)}`,
            bucketRegion,
          );
          return;
        }
        case "autonomous-database":
          await del("database", `/20160918/autonomousDatabases/${id}`);
          return;
        case "oke-cluster":
          await del("containerengine", `/20180222/clusters/${id}`);
          return;
        case "node-pool":
          await del("containerengine", `/20180222/nodePools/${id}`);
          return;
        case "budget":
          await del("usage", `/20190111/budgets/${id}`, this.home);
          return;
        case "budget-alert-rule": {
          const [budgetId, ruleId] = id.split("/");
          await del("usage", `/20190111/budgets/${budgetId}/alertRules/${ruleId}`, this.home);
          return;
        }
        default:
          throw new Error(`Oracle Cloud plugin: "${typeId}" cannot be deleted`);
      }
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const region = await this.inventory.regionOfOcid(id);
      if (typeId === "instance" && INSTANCE_ACTIONS.has(actionId)) {
        await this.api.request({
          service: "iaas",
          region,
          method: "POST",
          path: `/20160918/instances/${id}`,
          query: { action: actionId },
        });
        return;
      }
      if (typeId === "autonomous-database" && ADB_ACTIONS.has(actionId)) {
        await this.api.request({
          service: "database",
          region,
          method: "POST",
          path: `/20160918/autonomousDatabases/${id}/actions/${actionId}`,
        });
        return;
      }
      throw new Error(`Oracle Cloud plugin: action "${actionId}" is not supported for "${typeId}"`);
    });
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (sourceTypeId !== "block-volume" || targetTypeId !== "instance") {
        throw new Error(`Oracle Cloud plugin: cannot attach ${sourceTypeId} to ${targetTypeId}`);
      }
      const volumeId = externalIdOf(sourceResourceId);
      const instanceId = externalIdOf(targetResourceId);
      const region = await this.inventory.regionOfOcid(instanceId);
      await this.api.request({
        service: "iaas",
        region,
        method: "POST",
        path: "/20160918/volumeAttachments",
        body: { type: "paravirtualized", instanceId, volumeId },
      });
    });
  }

  exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      if (typeId !== "oke-cluster" || formatId !== "kubeconfig") {
        throw new Error(`Oracle Cloud plugin: no "${formatId}" credential for "${typeId}"`);
      }
      const id = externalIdOf(resourceId);
      const region = await this.inventory.regionOfOcid(id);
      const res = await this.api.request<string>({
        service: "containerengine",
        region,
        method: "POST",
        path: `/20180222/clusters/${id}/kubeconfig/content`,
        body: { tokenVersion: "2.0.0", endpoint: "PUBLIC_ENDPOINT" },
        rawResponse: true,
      });
      return {
        content: res.data,
        filename: `kubeconfig-${id.slice(-12)}.yaml`,
        mimeType: "application/yaml",
        warning:
          "This kubeconfig runs `oci ce cluster generate-token` for every request, so the machine using it needs the OCI CLI installed and configured for a user allowed to use the cluster.",
      };
    });
  }

  // -------------------------------------------------------------------------
  // Metrics, cost, credits, quotas, estimates

  private async metricTarget(typeId: string, externalId: string): Promise<MetricTarget | null> {
    const spec = metricSpecs(typeId);
    if (!spec) return null;
    if (typeId === "bucket") {
      const { region, name } = parseBucketExternalId(externalId);
      const ns = await objectStorageNamespace(this.api, region);
      const bucket = await this.api.get<{ compartmentId: string }>(
        "objectstorage",
        region,
        `/n/${encodeURIComponent(ns)}/b/${encodeURIComponent(name)}`,
      );
      return {
        region,
        compartmentId: bucket.compartmentId,
        namespace: spec.namespace,
        filter: dimensionFilter("resourceDisplayName", name),
        specs: spec.specs,
      };
    }
    const region = await this.inventory.regionOfOcid(externalId);
    const path =
      typeId === "instance"
        ? { service: "iaas" as const, path: `/20160918/instances/${externalId}` }
        : typeId === "block-volume"
          ? { service: "iaas" as const, path: `/20160918/volumes/${externalId}` }
          : typeId === "load-balancer"
            ? { service: "iaas" as const, path: `/20170115/loadBalancers/${externalId}` }
            : typeId === "autonomous-database"
              ? {
                  service: "database" as const,
                  path: `/20160918/autonomousDatabases/${externalId}`,
                }
              : { service: "containerengine" as const, path: `/20180222/clusters/${externalId}` };
    const res = await this.api.get<{ compartmentId: string }>(path.service, region, path.path);
    if (typeId === "oke-cluster") {
      return {
        region,
        compartmentId: res.compartmentId,
        namespace: spec.namespace,
        filter: dimensionFilter("clusterId", externalId),
        specs: spec.specs,
      };
    }
    return {
      region,
      compartmentId: res.compartmentId,
      namespace: spec.namespace,
      filter: dimensionFilter("resourceId", externalId),
      ...(typeId === "autonomous-database"
        ? { fallbackFilter: dimensionFilter("RESOURCEID", externalId) }
        : {}),
      specs: spec.specs,
    };
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      let target: MetricTarget | null;
      try {
        target = await this.metricTarget(resourceTypeId, externalIdOf(resourceId));
      } catch (err) {
        if (isAuthorizationGap(err)) return [];
        throw err;
      }
      if (!target) return [];
      return fetchSeries(this.api, target, timeRange);
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      return fetchOciCostData(this.api, this.home, range);
    });
  }

  fetchCreditBalance(_accountId: string): PluginEffect<CreditBalance[]> {
    return attempt(async () => {
      return fetchCommitmentBalances(this.api, this.home);
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
      return fetchServiceLimits(this.api, this.home);
    });
  }

  estimateCost(typeId: string, fields: Record<string, string>): PluginEffect<CostEstimate | null> {
    return attempt(async () => {
      const rates = await priceRates(this.services?.http);
      return estimateFor(rates, typeId, fields);
    });
  }

  // -------------------------------------------------------------------------
  // CI jobs (see ci-executor.ts)

  private get ciContext(): OciCiContext {
    return { api: this.api, inventory: this.inventory };
  }

  ciPreflight(kind: CiExecutorKind, region?: string): PluginEffect<CiPreflightResult> {
    return attempt(() => oracleCiPreflight(this.ciContext, kind, region));
  }

  ciStart(spec: CiStartSpec): PluginEffect<CiHandle> {
    return attempt(() => oracleCiStart(this.ciContext, spec));
  }

  ciStatus(handle: CiHandle): PluginEffect<CiComputeStatus> {
    return attempt(() => oracleCiStatus(this.ciContext, handle));
  }

  ciTeardown(handle: CiHandle): PluginEffect<void> {
    return attempt(() => oracleCiTeardown(this.ciContext, handle));
  }

  ciListTagged(tagKey: string, regions: readonly string[]): PluginEffect<CiTaggedCompute[]> {
    return attempt(() => oracleCiListTagged(this.ciContext, tagKey, regions));
  }

  // -------------------------------------------------------------------------
  // Object Storage browser. `bucket` is the bucket's external id
  // (`region/name`), which is what the detail view hands the host.

  private async objectPath(bucket: string, suffix = ""): Promise<{ region: string; path: string }> {
    const { region, name } = parseBucketExternalId(bucket);
    const ns = await objectStorageNamespace(this.api, region);
    return {
      region,
      path: `/n/${encodeURIComponent(ns)}/b/${encodeURIComponent(name)}/o${suffix}`,
    };
  }

  listStorageObjects(bucket: string, prefix: string): PluginEffect<StorageObject[]> {
    return attempt(async () => {
      const { region, path } = await this.objectPath(bucket);
      const out: StorageObject[] = [];
      let start: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await this.api.get<{
          objects?: Array<{
            name: string;
            size?: number;
            timeModified?: string;
            timeCreated?: string;
          }>;
          prefixes?: string[];
          nextStartWith?: string;
        }>("objectstorage", region, path, {
          prefix,
          delimiter: "/",
          fields: "name,size,timeModified,timeCreated",
          limit: 1000,
          ...(start ? { start } : {}),
        });
        for (const p of res.prefixes ?? []) {
          out.push({
            key: p,
            name: p.slice(prefix.length).replace(/\/$/, ""),
            size: 0,
            lastModified: "",
            isDirectory: true,
          });
        }
        for (const o of res.objects ?? []) {
          if (o.name === prefix) continue;
          out.push({
            key: o.name,
            name: o.name.slice(prefix.length),
            size: o.size ?? 0,
            lastModified: o.timeModified ?? o.timeCreated ?? "",
            isDirectory: false,
          });
        }
        start = res.nextStartWith;
        if (!start) break;
      }
      return out;
    });
  }

  uploadStorageObject(bucket: string, key: string, file: File): PluginEffect<void> {
    return attempt(async () => {
      const { region, path } = await this.objectPath(bucket, `/${encodeURIComponent(key)}`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      await this.api.putObject(region, path, bytes, file.type);
    });
  }

  makeStorageFolder(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      const folder = key.endsWith("/") ? key : `${key}/`;
      const { region, path } = await this.objectPath(bucket, `/${encodeURIComponent(folder)}`);
      await this.api.putObject(region, path, new Uint8Array(0), "application/octet-stream");
    });
  }

  deleteStorageObject(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      const keys = key.endsWith("/") ? (await this.listAllUnder(bucket, key)).concat(key) : [key];
      for (const k of keys) {
        const { region, path } = await this.objectPath(bucket, `/${encodeURIComponent(k)}`);
        await this.api
          .request({ service: "objectstorage", region, method: "DELETE", path })
          .catch((err: unknown) => {
            // The folder placeholder itself may not exist as an object.
            if (k === key && key.endsWith("/")) return;
            throw err;
          });
      }
    });
  }

  private async listAllUnder(bucket: string, prefix: string): Promise<string[]> {
    const { region, path } = await this.objectPath(bucket);
    const keys: string[] = [];
    let start: string | undefined;
    // A delete acts on this list, so it must not report success with objects left.
    for (let page = 0; page < FOLDER_MAX_PAGES; page++) {
      const res = await this.api.get<
        { objects?: Array<{ name: string }> | null; nextStartWith?: string } | undefined
      >("objectstorage", region, path, { prefix, limit: 1000, ...(start ? { start } : {}) });
      const objects = requireListPage(res?.objects, {
        vendor: "Oracle Cloud",
        path,
        key: "objects",
        page: res,
      });
      for (const o of objects) if (o.name !== prefix) keys.push(o.name);
      start = res?.nextStartWith;
      if (!start) return keys;
    }
    throw new ListTruncatedError({
      vendor: "Oracle Cloud",
      path,
      items: keys.length,
      maxPages: FOLDER_MAX_PAGES,
    });
  }
}

export type { ListContext };
