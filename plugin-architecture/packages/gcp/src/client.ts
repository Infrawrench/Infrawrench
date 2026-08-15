import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  StorageObject,
  ArtifactEntry,
  CreateResourceConfig,
  SqlTableMeta,
  ResourceTypeDefinition,
  DashboardStat,
  MetricSeries,
  QueryCostEstimate,
  CredentialExport,
  SecretVersion,
  SecretVersionMutation,
  ResourceStatus,
  LogsFetchParams,
  LogsFetchResult,
  ChatMessage,
  ChatStreamEvent,
  PublishMessagePayload,
  PublishMessageResult,
  CostEstimate,
  CostEstimateLineItem,
  CommitmentRecord,
  QuotaUsage,
  CostFetchRange,
  CostRow,
} from "@infrawrench/plugin-base";
import type { HostServices, PreflightResult } from "@infrawrench/plugin-base";
import { runGcpPreflight } from "./preflight.js";
import {
  buildCostEstimate,
  streamOpenAiSseChat,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import {
  fetchAccessToken,
  invalidateAccessToken,
  serviceAccountKeySchema,
  type ServiceAccountKey,
} from "./auth.js";
import { detectMyPublicIp } from "./cloudsql-create-handlers.js";
import { gcpStatus } from "./utils.js";
import { gcpApiError } from "./api-error.js";
import {
  type PricingCacheEntry,
  type PricingRates,
  type GeoRegion,
  regionFromZone,
  geoFromRegion,
  fetchPricingRatesForGeo,
  estimateMachineTypeMonthlyPrices,
  HOURS_PER_MONTH,
} from "./pricing.js";

/**
 * A `sizeGb × per-GB-month` disk line, or null when either half is unusable.
 * Persistent disks are the one component every compute-shaped GCP type adds
 * on top of its machine price, so all three estimates build it the same way.
 */
function gceDiskLine(
  label: string,
  sizeGb: number,
  gbMonthUsd: number | null | undefined,
): CostEstimateLineItem | null {
  if (gbMonthUsd == null || !Number.isFinite(sizeGb) || sizeGb <= 0) return null;
  return {
    label,
    monthlyAmount: sizeGb * gbMonthUsd,
    detail: `${sizeGb} GB × $${Number(gbMonthUsd.toFixed(4))}/GB-month`,
    quantity: sizeGb,
    unit: "GB",
  };
}
import type { ListerContext } from "./resource-listers.js";
import * as listers from "./resource-listers.js";
import type { FirestoreContext } from "./firestore-handlers.js";
import { executeFirestoreCommand } from "./firestore-handlers.js";
import type { BigQuerySpannerContext } from "./bigquery-spanner-handlers.js";
import {
  executeBigQueryQuery,
  executeSpannerQuery,
  introspectBigQueryDataset,
  introspectSpannerDatabase,
  parseBigQueryDatasetExternalId,
} from "./bigquery-spanner-handlers.js";

import type { GcpCreateContext } from "./create-handlers.js";
import { gcpGetCreateConfig, gcpCreateResource } from "./create-handlers.js";
import type { GcpDetailContext } from "./detail-context.js";
import { gcpRenderDetail } from "./detail-renderers.js";
import type { CloudRunContext } from "./cloud-run-handlers.js";
import {
  fetchCloudRunServiceFull,
  executeCloudRunCommand,
  serviceToYaml,
} from "./cloud-run-handlers.js";
import type { CloudArmorContext } from "./cloud-armor-handlers.js";
import { executeCloudArmorCommand } from "./cloud-armor-handlers.js";
import { publishPubsubTopic, publishCloudTasksQueue } from "./publish-handlers.js";
import { fetchGcpCostData } from "./cost-data.js";
import { fetchGcpCommitments } from "./commitments.js";

import type { GcpClientContext } from "./shared.js";
import { fetchGcpQuotas, type GcpProject, type GcpRegionList } from "./quotas.js";
import { deleteResource as runDeleteResource } from "./delete-client.js";
import {
  resolveOutput as runResolveOutput,
  exportCredential as runExportCredential,
} from "./resolve-output-client.js";
import {
  fetchDashboardStats as runFetchDashboardStats,
  fetchMetricSeries as runFetchMetricSeries,
  getLogs as runGetLogs,
} from "./monitoring-client.js";
import {
  uploadStorageObject as runUploadStorageObject,
  deleteStorageObject as runDeleteStorageObject,
  makeStorageFolder as runMakeStorageFolder,
  listStorageObjects as runListStorageObjects,
  listArtifacts as runListArtifacts,
} from "./storage-client.js";
import {
  listSecretVersions as runListSecretVersions,
  accessSecretVersion as runAccessSecretVersion,
  addSecretVersion as runAddSecretVersion,
  modifySecretVersion as runModifySecretVersion,
} from "./secret-versions-client.js";
import {
  restartReplaceInstanceGroup,
  setGceInstanceMachineType,
  setGceInstancePower,
  attachResource as runAttachResource,
} from "./compute-extras-client.js";
import { enrichDetail as runEnrichDetail } from "./enrich-detail-client.js";
import { VERTEX_GEMINI_MODELS } from "./resources/vertex-gemini-model.js";

/**
 * Default Vertex AI region used for the Gemini chat playground. Vertex's
 * OpenAI-compatible chat endpoint is regionalised; us-central1 carries every
 * curated Gemini model, so we anchor to it unless we learn otherwise.
 */
const VERTEX_DEFAULT_LOCATION = "us-central1";

export class GcpClient implements PluginClient {
  private readonly key: ServiceAccountKey;
  private readonly project: string;
  /** Cloud Billing BigQuery export table (`project.dataset.table`), "" when unset. */
  private readonly billingExportTable: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private readonly hostServices: HostServices | undefined;
  private machineTypeFamilyRateCache = new Map<string, PricingCacheEntry>();
  private pricingRatesInFlightByGeo = new Map<string, Promise<PricingRates>>();
  /** Cached machine type specs (vcpus + memoryMb) keyed by machine type name, populated during getCreateConfig. */
  private machineTypeSpecCache = new Map<string, { guestCpus: number; memoryMb: number }>();

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[] = [],
    services?: HostServices,
  ) {
    this.resourceTypes = resourceTypes;
    this.hostServices = services;
    const raw = credentials["serviceAccountJson"];
    if (!raw) throw new Error("GCP plugin: missing serviceAccountJson credential");
    this.key = serviceAccountKeySchema.parse(JSON.parse(raw));
    this.project = credentials["project"]?.trim() || this.key.project_id;
    if (!this.project) throw new Error("GCP plugin: could not determine project ID");
    this.billingExportTable = credentials["billingExportTable"]?.trim() ?? "";
  }

  private token(): Promise<string> {
    return fetchAccessToken(this.key);
  }

  private async get<T>(url: string): Promise<T> {
    let tok = await this.token();
    let res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.status === 401) {
      // Cached token may have been revoked early — invalidate and retry once.
      invalidateAccessToken(this.key);
      tok = await this.token();
      res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    }
    if (!res.ok) {
      throw gcpApiError(res.status, url, await res.text(), this.project);
    }
    return res.json() as Promise<T>;
  }

  /** Follow nextPageToken until exhausted, collecting `key` array from each page. */
  private async paginate<T>(
    baseUrl: string,
    key: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(baseUrl);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<Record<string, unknown>>(url.toString());
      const items = page[key];
      if (Array.isArray(items)) results.push(...(items as T[]));
      pageToken = page["nextPageToken"] as string | undefined;
    } while (pageToken);
    return results;
  }

  /**
   * Shared context handed to every per-service handler module. Lets a
   * module call `ctx.get(url)`, `ctx.paginate(...)`, or
   * `ctx.getResource(...)` without taking a reference to the class.
   */
  private get sharedCtx(): GcpClientContext {
    return {
      project: this.project,
      serviceAccountKey: this.key,
      hostServices: this.hostServices,
      token: () => this.token(),
      get: this.get.bind(this),
      paginate: this.paginate.bind(this),
      id: this.id.bind(this),
      now: this.now.bind(this),
      getResource: this.getResource.bind(this),
    };
  }

  private get listerCtx(): ListerContext {
    return {
      get: this.get.bind(this),
      paginate: this.paginate.bind(this),
      id: this.id.bind(this),
      now: this.now.bind(this),
    };
  }

  private get firestoreCtx(): FirestoreContext {
    return {
      project: this.project,
      token: () => this.token(),
    };
  }

  private get cloudRunCtx(): CloudRunContext {
    return {
      project: this.project,
      token: () => this.token(),
    };
  }

  private get cloudArmorCtx(): CloudArmorContext {
    return {
      project: this.project,
      token: () => this.token(),
    };
  }

  private get bqSpannerCtx(): BigQuerySpannerContext {
    return {
      project: this.project,
      token: () => this.token(),
      get: this.get.bind(this),
    };
  }

  private get createCtx(): GcpCreateContext {
    return {
      get: this.get.bind(this),
      paginate: this.paginate.bind(this),
      token: () => this.token(),
      project: this.project,
      id: this.id.bind(this),
      now: this.now.bind(this),
      machineTypeSpecCache: this.machineTypeSpecCache,
    };
  }

  private get detailCtx(): GcpDetailContext {
    return {
      id: this.id.bind(this),
      project: this.project,
      resourceTypes: this.resourceTypes,
    };
  }

  async verifyCredentials(): Promise<PreflightResult> {
    return runGcpPreflight(this.key, this.project, this.billingExportTable);
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const p = this.project;
    const ctx = this.listerCtx;
    switch (typeId) {
      case "gcp-project":
        return listers.listGcpProjects(ctx, accountId, p);
      case "gce-instance":
        return listers.listGceInstances(ctx, accountId, p);
      case "gce-disk":
        return listers.listGceDisks(ctx, accountId, p);
      case "gke-cluster":
        return listers.listGkeClusters(ctx, accountId, p);
      case "cloudsql-instance":
        return listers.listCloudSqlInstances(ctx, accountId, p);
      case "spanner-instance":
        return listers.listSpannerInstances(ctx, accountId, p);
      case "spanner-database":
        return listers.listSpannerDatabases(ctx, accountId, p);
      case "spanner-backup":
        return listers.listSpannerBackups(ctx, accountId, p);
      case "bigtable-instance":
        return listers.listBigtableInstances(ctx, accountId, p);
      case "firestore-database":
        return listers.listFirestoreDatabases(ctx, accountId, p);
      case "memorystore-redis":
        return listers.listMemorystoreRedis(ctx, accountId, p);
      case "alloydb-cluster":
        return listers.listAlloyDbClusters(ctx, accountId, p);
      case "alloydb-instance":
        return listers.listAlloyDbInstances(ctx, accountId, p);
      case "gcs-bucket":
        return listers.listGcsBuckets(ctx, accountId, p);
      case "pubsub-topic":
        return listers.listPubSubTopics(ctx, accountId, p);
      case "pubsub-subscription":
        return listers.listPubSubSubscriptions(ctx, accountId, p);
      case "cloud-run-service":
        return listers.listCloudRunServices(ctx, accountId, p);
      case "cloud-function":
        return listers.listCloudFunctions(ctx, accountId, p);
      case "vpc-network":
        return listers.listVpcNetworks(ctx, accountId, p);
      case "bigquery-dataset":
        return listers.listBigQueryDatasets(ctx, accountId, p);
      case "bigquery-table":
        return listers.listBigQueryTables(ctx, accountId, p);
      case "artifact-registry-repo":
        return listers.listArtifactRegistryRepos(ctx, accountId, p);
      case "gcp-service-account":
        return listers.listServiceAccounts(ctx, accountId, p);
      case "cloud-armor-policy":
        return listers.listCloudArmorPolicies(ctx, accountId, p);
      case "secret-manager-secret":
        return listers.listSecretManagerSecrets(ctx, accountId, p);
      case "dataflow-job":
        return listers.listDataflowJobs(ctx, accountId, p);
      case "cloud-dns-zone":
        return listers.listCloudDnsZones(ctx, accountId, p);
      case "cloud-dns-record-set":
        return listers.listCloudDnsRecordSets(ctx, accountId, p);
      case "firewall-rule":
        return listers.listFirewallRules(ctx, accountId, p);
      case "subnet":
        return listers.listSubnets(ctx, accountId, p);
      case "static-ip":
        return listers.listStaticIps(ctx, accountId, p);
      case "cloud-router":
        return listers.listCloudRouters(ctx, accountId, p);
      case "cloud-nat":
        return listers.listCloudNats(ctx, accountId, p);
      case "cloud-scheduler-job":
        return listers.listCloudSchedulerJobs(ctx, accountId, p);
      case "cloud-tasks-queue":
        return listers.listCloudTasksQueues(ctx, accountId, p);
      case "cloud-build-trigger":
        return listers.listCloudBuildTriggers(ctx, accountId, p);
      case "log-sink":
        return listers.listLogSinks(ctx, accountId, p);
      case "alert-policy":
        return listers.listAlertPolicies(ctx, accountId, p);
      case "kms-key-ring":
        return listers.listKmsKeyRings(ctx, accountId, p);
      case "kms-key":
        return listers.listKmsKeys(ctx, accountId, p);
      case "filestore-instance":
        return listers.listFilestoreInstances(ctx, accountId, p);
      case "backend-service":
        return listers.listBackendServices(ctx, accountId, p);
      case "forwarding-rule":
        return listers.listForwardingRules(ctx, accountId, p);
      case "memorystore-memcached":
        return listers.listMemorystoreMemcached(ctx, accountId, p);
      case "vertex-ai-endpoint":
        return listers.listVertexAiEndpoints(ctx, accountId, p);
      case "vertex-gemini-model":
        return this.listVertexGeminiModels(accountId);
      case "composer-environment":
        return listers.listComposerEnvironments(ctx, accountId, p);
      case "workflow":
        return listers.listWorkflows(ctx, accountId, p);
      case "cloud-deploy-pipeline":
        return listers.listCloudDeployPipelines(ctx, accountId, p);
      case "app-engine-service":
        return listers.listAppEngineServices(ctx, accountId, p);
      case "health-check":
        return listers.listHealthChecks(ctx, accountId, p);
      case "ssl-certificate":
        return listers.listSslCertificates(ctx, accountId, p);
      case "instance-group":
        return listers.listInstanceGroups(ctx, accountId, p);
      case "instance-template":
        return listers.listInstanceTemplates(ctx, accountId, p);
      default:
        throw new Error(`GCP plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const all = await this.listResources(typeId, accountId);
    let found = all.find((r) => r.id === resourceId);
    if (!found && typeId === "cloud-run-service") {
      // Legacy IDs created before the externalId was canonicalised to the full
      // GCP `projects/.../locations/.../services/...` form had the shape
      // `<project>/<region>/<service>`. Translate either format to the other
      // so existing rows stay reachable without forcing the user to recreate.
      const externalId = resourceId.split(":").slice(2).join(":");
      const legacyMatch = /^([^/]+)\/([^/]+)\/([^/]+)$/.exec(externalId);
      if (legacyMatch) {
        const canonical = `projects/${legacyMatch[1]}/locations/${legacyMatch[2]}/services/${legacyMatch[3]}`;
        found = all.find((r) => r.externalId === canonical);
      } else if (externalId.startsWith("projects/")) {
        const m = /^projects\/([^/]+)\/locations\/([^/]+)\/services\/([^/]+)$/.exec(externalId);
        if (m) {
          const legacy = `${m[1]}/${m[2]}/${m[3]}`;
          found = all.find((r) => r.externalId === legacy);
        }
      }
    }
    if (!found) throw new Error(`GCP plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    return runEnrichDetail(
      this.sharedCtx,
      this.cloudRunCtx,
      this.cloudArmorCtx,
      this.firestoreCtx,
      resource,
    );
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "nodeHourlyRates") {
      // The Kubernetes peer asks every managed-cluster type what its nodes
      // cost per hour, so it can derive per-namespace and per-workload spend.
      // GCP's Cloud Billing SKUs price vCPU-hours and GiB-hours
      // separately rather than per machine type, so turning them into a
      // per-node hourly rate needs a machine-type -> (vCPU, GiB) lookup this
      // plugin does not yet have.
      // Returning "" is the honest answer and makes the peer show capacity and
      // efficiency without money rather than inventing a price. It must return
      // rather than fall through: the host resolves every credentialMapping
      // before building the peer client, so a throw here would take the whole
      // Kubernetes tab down.
      return "";
    }

    return runResolveOutput(this.sharedCtx, typeId, resourceId, outputKey, accountId);
  }

  private async getPricingRatesForGeo(geo: GeoRegion): Promise<PricingRates> {
    const cached = this.machineTypeFamilyRateCache.get(geo);
    if (cached && cached.expiresAt > Date.now())
      return {
        machineRates: cached.machineRates,
        diskGbMonthUsd: cached.diskGbMonthUsd,
      };
    const inFlight = this.pricingRatesInFlightByGeo.get(geo);
    if (inFlight) return inFlight;

    const fetchPromise = (async () => {
      const rates = await fetchPricingRatesForGeo(geo, this.get.bind(this));
      this.machineTypeFamilyRateCache.set(geo, {
        ...rates,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      });
      return rates;
    })();

    this.pricingRatesInFlightByGeo.set(geo, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.pricingRatesInFlightByGeo.delete(geo);
    }
  }

  private async estimateMachineTypeMonthlyPrices(
    machineTypes: Array<{ id: string; vcpus: number; memoryMb: number }>,
    zone: string,
  ): Promise<Record<string, number>> {
    const region = regionFromZone(zone);
    const geo = geoFromRegion(region);
    const rates = await this.getPricingRatesForGeo(geo);
    return estimateMachineTypeMonthlyPrices(machineTypes, rates);
  }

  private async getDiskMonthlyRate(zone: string, diskType: string): Promise<number | null> {
    const region = regionFromZone(zone);
    const geo = geoFromRegion(region);
    const rates = await this.getPricingRatesForGeo(geo);
    const key = diskType as keyof typeof rates.diskGbMonthUsd;
    return rates.diskGbMonthUsd[key] ?? null;
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    return runExportCredential(this.sharedCtx, typeId, resourceId, accountId, formatId);
  }

  async getManifest(resourceId: string, accountId: string): Promise<string> {
    const typeId = resourceId.split(":")[1];
    if (typeId === "cloud-run-service" || typeId === "cloud-function") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // Prefer the cached full service from enrichDetail; fall back to a fresh fetch.
      const cached = String(resource.resolvedOutputs["cloudRunFullService"] ?? "");
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { service?: Record<string, unknown> | null };
          if (parsed.service) return serviceToYaml(parsed.service);
        } catch {
          /* fall through to live fetch */
        }
      }
      // For cloud-function, the underlying Cloud Run service path is in
      // resolvedOutputs.cloudRunServiceName — synthesise a Run-shaped resource
      // for the helper which reads externalId.
      const runResource =
        typeId === "cloud-function"
          ? {
              ...resource,
              resourceTypeId: "cloud-run-service",
              externalId: String(resource.resolvedOutputs["cloudRunServiceName"] ?? ""),
            }
          : resource;
      if (typeId === "cloud-function" && !runResource.externalId) {
        throw new Error(
          "Cloud Function has no backing Cloud Run service yet — manifest unavailable.",
        );
      }
      const fresh = await fetchCloudRunServiceFull(this.cloudRunCtx, runResource);
      if (fresh.error) throw new Error(fresh.error);
      return serviceToYaml(fresh.service);
    }
    throw new Error(`GCP plugin: getManifest not supported for type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, accountId: string): Promise<void> {
    return runDeleteResource(this.sharedCtx, typeId, resourceId, accountId);
  }

  async publishMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    const externalId = resourceId.split(":").slice(2).join(":");
    if (typeId === "pubsub-topic") {
      return publishPubsubTopic(
        { token: () => this.token(), project: this.project },
        externalId,
        payload,
      );
    }
    if (typeId === "cloud-tasks-queue") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return publishCloudTasksQueue(
        { token: () => this.token(), project: this.project },
        {
          ...(resource.externalId !== undefined ? { externalId: resource.externalId } : {}),
          fields: resource.fields,
        },
        payload,
      );
    }
    throw new Error(`GCP plugin: publishMessage not supported for type "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    if (typeId === "firestore-database") {
      return executeFirestoreCommand(this.firestoreCtx, resourceId, accountId, command, args);
    }
    if (typeId === "cloud-run-service" || typeId === "cloud-function") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // Functions reach the underlying Cloud Run service via cloudRunServiceName.
      const runResource =
        typeId === "cloud-function"
          ? {
              ...resource,
              resourceTypeId: "cloud-run-service",
              externalId: String(resource.resolvedOutputs["cloudRunServiceName"] ?? ""),
            }
          : resource;
      if (typeId === "cloud-function" && !runResource.externalId) {
        throw new Error(
          "Cloud Function has no backing Cloud Run service yet — try again once deployment finishes.",
        );
      }
      return executeCloudRunCommand(this.cloudRunCtx, runResource, command, args);
    }
    if (typeId === "cloud-armor-policy") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return executeCloudArmorCommand(this.cloudArmorCtx, resource, command, args);
    }
    throw new Error(`GCP plugin: executeNoSqlCommand not supported for type "${typeId}"`);
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): Promise<void> {
    if (typeId === "instance-group" && actionId === "restart-replace") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      await restartReplaceInstanceGroup(this.sharedCtx, resource);
      return;
    }
    if (typeId === "gce-instance" && (actionId === "start" || actionId === "stop")) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      await setGceInstancePower(this.sharedCtx, resource, actionId);
      return;
    }
    throw new Error(`GCP plugin: invokeAction "${actionId}" not supported for type "${typeId}"`);
  }

  async attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): Promise<void> {
    return runAttachResource(
      this.sharedCtx,
      sourceTypeId,
      sourceResourceId,
      targetTypeId,
      targetResourceId,
      accountId,
    );
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    return gcpGetCreateConfig(this.createCtx, typeId, parentResourceId);
  }

  async getCreateSizePricing(
    typeId: string,
    request: { regionId?: string; sizes: Array<{ id: string; vcpus: number; memoryMb: number }> },
  ): Promise<Record<string, number>> {
    if (typeId !== "gce-instance" && typeId !== "gke-cluster") return {};
    const zone = request.regionId ?? "us-central1-a";
    return this.estimateMachineTypeMonthlyPrices(request.sizes, zone);
  }

  /**
   * Monthly estimate with line items, priced from the Cloud Billing catalog
   * for the resource's own zone.
   *
   * Machine specs come from `machineTypeSpecCache` (populated by
   * `getCreateConfig`) so a field change re-estimates without a network round
   * trip — which is what lets the cost badge track a storage slider as it
   * moves rather than lagging a request behind it.
   */
  async estimateCost(typeId: string, fields: Record<string, string>): Promise<CostEstimate | null> {
    if (typeId === "gce-instance") {
      const zone = fields["zone"] || "us-central1-a";
      const machineType = fields["machineType"] ?? "";
      if (!machineType) return null;

      const vmMonthly = await this.machineTypeMonthlyPrice(machineType, zone);

      // A VM created from an existing disk has no boot disk of its own to
      // price; one created from an image gets a pd-balanced disk. An existing
      // instance stores neither field, and its boot disk is a `gce-disk`
      // resource with its own estimate, so it prices as compute alone.
      const bootSource = fields["bootSource"] ?? (fields["diskGb"] ? "new-image" : "");
      let disk: CostEstimateLineItem | null = null;
      if (bootSource === "new-image") {
        const diskGb = Number(fields["diskGb"] ?? 50);
        const diskRate = await this.getDiskMonthlyRate(zone, "pd-balanced");
        disk = gceDiskLine("Boot disk (pd-balanced)", diskGb, diskRate);
      }

      return buildCostEstimate(
        [
          vmMonthly == null
            ? null
            : {
                label: `Machine type (${machineType})`,
                monthlyAmount: vmMonthly,
                detail: `${HOURS_PER_MONTH} h in ${regionFromZone(zone)}`,
              },
          disk,
        ],
        {
          partial: vmMonthly == null,
          notes: [
            "On-demand rate — sustained-use discounts apply automatically and are not deducted here.",
          ],
        },
      );
    }

    if (typeId === "gce-disk") {
      const zone = fields["zone"] || "us-central1-a";
      const sizeGb = Number(fields["sizeGb"] ?? 50);
      const diskType = fields["type"] || "pd-balanced";
      const diskRate = await this.getDiskMonthlyRate(zone, diskType);
      return buildCostEstimate([gceDiskLine(`Disk (${diskType})`, sizeGb, diskRate)]);
    }

    if (typeId === "gke-cluster") {
      const zone = fields["location"] || "us-central1-a";
      const machineType = fields["machineType"] ?? "";
      const nodeCount = Math.max(1, Math.floor(Number(fields["nodeCount"] ?? 3)) || 1);
      if (!machineType) return null;

      const perNodeVm = await this.machineTypeMonthlyPrice(machineType, zone);
      const diskGb = Number(fields["diskSizeGb"] ?? 100);
      // GKE node pools provision pd-balanced boot disks by default.
      const diskRate = await this.getDiskMonthlyRate(zone, "pd-balanced");
      const perNodeDisk = gceDiskLine("", diskGb, diskRate)?.monthlyAmount ?? 0;

      return buildCostEstimate(
        [
          perNodeVm == null
            ? null
            : {
                label: `Nodes (${nodeCount} × ${machineType})`,
                monthlyAmount: perNodeVm * nodeCount,
                detail: `${nodeCount} × $${Number(perNodeVm.toFixed(2))}/month`,
                quantity: nodeCount,
                unit: "nodes",
              },
          perNodeDisk === 0
            ? null
            : {
                label: "Node boot disks (pd-balanced)",
                monthlyAmount: perNodeDisk * nodeCount,
                detail: `${nodeCount} × ${diskGb} GB`,
                quantity: nodeCount * diskGb,
                unit: "GB",
              },
        ],
        {
          partial: true,
          notes: [
            "Worker nodes only — the GKE cluster management fee is not included.",
            "One zonal Autopilot-free cluster per billing account is exempt from that fee.",
          ],
        },
      );
    }

    return null;
  }

  /**
   * Monthly price for one machine type in a zone, using the spec cache when
   * it is warm and falling back to a single machineTypes GET when it is not.
   */
  private async machineTypeMonthlyPrice(machineType: string, zone: string): Promise<number | null> {
    let spec = this.machineTypeSpecCache.get(machineType);
    if (!spec) {
      const fetched = await this.get<{ guestCpus: number; memoryMb: number }>(
        `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${zone}/machineTypes/${machineType}`,
      ).catch(() => null);
      if (!fetched) return null;
      this.machineTypeSpecCache.set(machineType, fetched);
      spec = fetched;
    }
    const prices = await this.estimateMachineTypeMonthlyPrices(
      [{ id: machineType, vcpus: spec.guestCpus, memoryMb: spec.memoryMb }],
      zone,
    );
    return prices[machineType] ?? null;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return gcpCreateResource(this.createCtx, typeId, accountId, fields, parentResourceId);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "gce-instance") {
      // Edit = change machine type (the right-sizing apply path). GCE only
      // allows setMachineType on a TERMINATED instance; the API's error for
      // a running one is surfaced as-is.
      const machineType = fields["machineType"];
      if (!machineType) {
        throw new Error("GCP plugin: machineType is the only editable VM instance field");
      }
      const resource = await this.getResource(typeId, resourceId, accountId);
      await setGceInstanceMachineType(this.sharedCtx, resource, machineType);
      return this.getResource(typeId, resourceId, accountId);
    }

    if (typeId === "cloud-dns-record-set") {
      // Cloud DNS record sets are immutable — "update" is a change transaction
      // that deletes the existing rrset and adds the replacement. externalId
      // format: "{zoneName}/{type}:{name}".
      const externalId = resourceId.split(":").slice(2).join(":");
      const slash = externalId.indexOf("/");
      const zoneName = externalId.slice(0, slash);
      const recordKey = externalId.slice(slash + 1);
      const colon = recordKey.indexOf(":");
      const type = recordKey.slice(0, colon);
      const name = recordKey.slice(colon + 1);
      const p = this.project;
      const tok = await this.token();

      // Fetch the current rrset so the deletion matches exactly and we keep
      // the existing TTL unless the caller changed it.
      const getRes = await fetch(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${zoneName}/rrsets/${encodeURIComponent(name)}/${type}`,
        { headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!getRes.ok) throw new Error(`Cloud DNS API ${getRes.status}: ${await getRes.text()}`);
      const current = (await getRes.json()) as Record<string, unknown>;
      const ttl =
        fields["ttl"] !== undefined && fields["ttl"] !== ""
          ? Number(fields["ttl"])
          : Number(current["ttl"] ?? 300);
      const rrdatas =
        fields["rrdatas"] !== undefined
          ? fields["rrdatas"]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : ((current["rrdatas"] as string[]) ?? []);

      const changeRes = await fetch(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${zoneName}/changes`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            deletions: [
              { name, type, ttl: Number(current["ttl"] ?? ttl), rrdatas: current["rrdatas"] ?? [] },
            ],
            additions: [{ name, type, ttl, rrdatas }],
          }),
        },
      );
      if (!changeRes.ok)
        throw new Error(`Cloud DNS API ${changeRes.status}: ${await changeRes.text()}`);

      const shortName = name.replace(/\.$/, "");
      const now = new Date().toISOString();
      return {
        id: resourceId,
        pluginId: "gcp",
        resourceTypeId: "cloud-dns-record-set",
        accountId,
        displayName: `${type} ${shortName}`,
        fields: {
          type,
          name: shortName,
          rrdatas: rrdatas.join(", "),
          ttl,
          zoneName,
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId,
        createdAt: now,
        updatedAt: now,
      };
    }
    throw new Error(`GCP plugin: updateResource not supported for type "${typeId}"`);
  }

  async executeFieldAction(
    typeId: string,
    fieldKey: string,
    actionId: string,
    _accountId: string,
    fields: Record<string, string>,
  ): Promise<{ value: string; option?: { id: string; label: string } }> {
    if (
      typeId === "cloudsql-instance" &&
      fieldKey === "authorizedNetworks" &&
      actionId === "detect-my-ip"
    ) {
      const next = await detectMyPublicIp(fields[fieldKey]);
      return { value: next };
    }
    throw new Error(`GCP plugin: no field action for ${typeId}.${fieldKey} / ${actionId}`);
  }

  async applySecretReroll(
    typeId: string,
    resourceId: string,
    accountId: string,
    fieldKey: string,
    plaintext: string,
  ): Promise<void> {
    if (typeId === "cloudsql-instance" && fieldKey === "rootPassword") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const databaseVersion = String(resource.fields["databaseVersion"] ?? "");
      const name = resource.externalId ?? String(resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine Cloud SQL instance name");
      // Default admin user per engine — matches `engineInfoFromVersion` in
      // cloudsql-engine.ts. The Cloud SQL Admin API rejects updates that omit
      // both name and host, so we always pass them.
      const username = databaseVersion.startsWith("MYSQL_")
        ? "root"
        : databaseVersion.startsWith("SQLSERVER_")
          ? "sqlserver"
          : "postgres";
      // For Postgres + SQL Server the user has no host scope; MySQL users
      // are scoped to a host pattern, with `%` matching any.
      const host = databaseVersion.startsWith("MYSQL_") ? "%" : "";
      const tok = await this.token();
      const params = new URLSearchParams({ name: username });
      if (host) params.set("host", host);
      const url = `https://sqladmin.googleapis.com/v1/projects/${this.project}/instances/${name}/users?${params}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ password: plaintext }),
      });
      if (!res.ok) {
        throw new Error(`Cloud SQL user update ${res.status}: ${await res.text()}`);
      }
      return;
    }
    throw new Error(`GCP plugin: applySecretReroll not supported for ${typeId}.${fieldKey}`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    return runFetchDashboardStats(this.sharedCtx, resourceTypeId, resourceId, accountId);
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    return runFetchMetricSeries(this.sharedCtx, resourceTypeId, resourceId, accountId, timeRange);
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchGcpCostData(
      {
        project: this.project,
        token: () => this.token(),
        billingExportTable: this.billingExportTable,
      },
      range,
    );
  }

  async fetchCommitments(_accountId: string): Promise<CommitmentRecord[]> {
    return fetchGcpCommitments({ project: this.project, get: this.get.bind(this) });
  }

  /**
   * Quota readings. Two requests for the whole project: `projects.get` for the
   * global quotas and one paginated `regions.list` for every region's — the
   * list response carries each region's full `quotas[]`, so there is no
   * per-region fan-out to bound. See `quotas.ts`.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const base = `https://compute.googleapis.com/compute/v1/projects/${this.project}`;
    return fetchGcpQuotas({
      project: this.project,
      getProject: () => this.get<GcpProject>(base),
      listRegions: (pageToken) => {
        const url = new URL(`${base}/regions`);
        url.searchParams.set("maxResults", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        return this.get<GcpRegionList>(url.toString());
      },
    });
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    return runGetLogs(this.sharedCtx, typeId, resourceId, accountId, params);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    // Cloud Monitoring's default window (see `monitoring-client.ts`) is the
    // last hour. Renderers that want a different one (Cloud Run, Cloud
    // Functions: 24h) set `metricsCapability` themselves and are left alone.
    return withMetricsCapability(
      gcpRenderDetail(this.detailCtx, resource),
      this.resourceTypes,
      resource.resourceTypeId,
      3_600_000,
    );
  }

  /**
   * Curated Gemini chat models surfaced as resources. No live API call — see
   * `VERTEX_GEMINI_MODELS` for why the catalog is static. Each model gets a
   * stable healthy status so the sidebar doesn't churn.
   */
  private listVertexGeminiModels(accountId: string): ResourceInstance[] {
    const now = this.now();
    return VERTEX_GEMINI_MODELS.map((m) => ({
      id: this.id(accountId, "vertex-gemini-model", m.modelId),
      pluginId: "gcp",
      resourceTypeId: "vertex-gemini-model",
      accountId,
      displayName: m.modelId,
      fields: {
        modelId: m.modelId,
        description: m.description,
        status: "READY",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: m.modelId,
      createdAt: now,
      updatedAt: now,
    }));
  }

  /**
   * Stream a Gemini chat completion through Vertex AI's OpenAI-compatible
   * endpoint. The wire format mirrors OpenAI's SSE
   * (`data: {json}\n\n` … `data: [DONE]`, with `choices[0].delta.content`
   * deltas and a trailing `usage` block), so the parser is the same shape as
   * the DigitalOcean Gradient AI playground.
   */
  async *streamChatMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    if (typeId !== "vertex-gemini-model") {
      yield {
        kind: "error",
        message: `GCP plugin: streamChatMessage not supported for type "${typeId}".`,
      };
      return;
    }
    const modelId = resourceId.split(":").slice(2).join(":");
    if (!modelId) {
      yield { kind: "error", message: "Couldn't determine the Gemini model id." };
      return;
    }

    const location = VERTEX_DEFAULT_LOCATION;
    let token: string;
    try {
      token = await this.token();
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    const endpoint =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${this.project}` +
      `/locations/${location}/endpoints/openapi/chat/completions`;
    const body = JSON.stringify({
      model: `google/${modelId}`,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      yield {
        kind: "error",
        message: `Vertex AI returned ${res.status}: ${errText || res.statusText}`,
      };
      return;
    }

    yield* streamOpenAiSseChat(res.body);
  }

  async executeQuery(
    resourceId: string,
    accountId: string,
    sql: string,
  ): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
    const typeId = resourceId.split(":")[1];
    if (typeId === "spanner-database") {
      return executeSpannerQuery(this.bqSpannerCtx, resourceId, accountId, sql);
    }
    return executeBigQueryQuery(this.bqSpannerCtx, resourceId, sql);
  }

  async estimateQueryCost(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): Promise<QueryCostEstimate> {
    const { project, datasetId } = parseBigQueryDatasetExternalId(resourceId);
    const tok = await this.token();

    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/jobs`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          configuration: {
            dryRun: true,
            query: {
              query: sql,
              useLegacySql: false,
              defaultDataset: { projectId: project, datasetId },
            },
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`BigQuery dry run failed ${res.status}: ${await res.text()}`);
    const job = (await res.json()) as Record<string, unknown>;
    const stats = job["statistics"] as Record<string, unknown> | undefined;
    const queryStats = stats?.["query"] as Record<string, unknown> | undefined;
    const bytesProcessed = Number(queryStats?.["totalBytesProcessed"] ?? 0);
    const cacheHit = Boolean(queryStats?.["cacheHit"]);
    // BigQuery on-demand pricing: $6.25 per TiB scanned (2024+).
    const estimatedCostUsd = cacheHit ? 0 : (bytesProcessed / 1024 ** 4) * 6.25;
    return {
      bytesProcessed,
      estimatedCostUsd,
      cacheHit,
      pricingNote: "$6.25 per TiB scanned (BigQuery on-demand)",
    };
  }

  async introspectResource(resourceId: string, accountId: string): Promise<SqlTableMeta[]> {
    const typeId = resourceId.split(":")[1];
    if (typeId === "spanner-database") {
      return introspectSpannerDatabase(this.bqSpannerCtx, resourceId, accountId);
    }
    return introspectBigQueryDataset(this.bqSpannerCtx, resourceId);
  }

  async getStorageAccessToken(): Promise<string> {
    return this.token();
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return runUploadStorageObject(this.sharedCtx, bucket, key, file, onProgress);
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    return runDeleteStorageObject(this.sharedCtx, bucket, key);
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    return runMakeStorageFolder(this.sharedCtx, bucket, key);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    return runListStorageObjects(this.sharedCtx, bucket, prefix);
  }

  async listArtifacts(
    typeId: string,
    resourceId: string,
    accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    return runListArtifacts(this.sharedCtx, typeId, resourceId, accountId, params);
  }

  async listSecretVersions(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<SecretVersion[]> {
    return runListSecretVersions(this.sharedCtx, typeId, resourceId, accountId);
  }

  async accessSecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
  ): Promise<string> {
    return runAccessSecretVersion(this.sharedCtx, typeId, resourceId, accountId, versionId);
  }

  async addSecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    value: string,
  ): Promise<SecretVersion> {
    return runAddSecretVersion(this.sharedCtx, typeId, resourceId, accountId, value);
  }

  async modifySecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
    action: SecretVersionMutation,
  ): Promise<SecretVersion> {
    return runModifySecretVersion(this.sharedCtx, typeId, resourceId, accountId, versionId, action);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const statusVal = String(resource.fields["status"] ?? resource.fields["state"] ?? "");
    const status: ResourceStatus =
      resource.resourceTypeId === "log-sink" ? "info" : gcpStatus(statusVal);
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status },
    };
  }

  private id(accountId: string, typeId: string, externalId: string): string {
    return `${accountId}:${typeId}:${externalId}`;
  }

  private now(): string {
    return new Date().toISOString();
  }
}
