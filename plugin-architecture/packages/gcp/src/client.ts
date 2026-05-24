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
} from "@infrawrench/plugin-base";
import type { HostServices } from "@infrawrench/plugin-base";
import {
  fetchAccessToken,
  invalidateAccessToken,
  serviceAccountKeySchema,
  type ServiceAccountKey,
} from "./auth.js";
import { detectMyPublicIp } from "./cloudsql-create-handlers.js";
import { gcpStatus } from "./utils.js";
import {
  type PricingCacheEntry,
  type PricingRates,
  type GeoRegion,
  regionFromZone,
  geoFromRegion,
  fetchPricingRatesForGeo,
  estimateMachineTypeMonthlyPrices,
} from "./pricing.js";
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

import type { GcpClientContext } from "./shared.js";
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
      throw new Error(`GCP API ${res.status} for ${url}: ${await res.text()}`);
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

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const p = this.project;
    const ctx = this.listerCtx;
    switch (typeId) {
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

  async getCreateCostEstimate(
    typeId: string,
    fields: Record<string, string>,
  ): Promise<number | null> {
    if (typeId === "gce-instance") {
      const zone = fields["zone"] ?? "us-central1-a";
      const machineType = fields["machineType"] ?? "";
      if (!machineType) return null;

      // Use cached machine type specs (populated during getCreateConfig) to avoid
      // a network roundtrip on every field change — this lets the cost badge update
      // instantly when the storage slider moves.
      let machineTypeData = this.machineTypeSpecCache.get(machineType);
      if (!machineTypeData) {
        const fetched = await this.get<{ guestCpus: number; memoryMb: number }>(
          `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${zone}/machineTypes/${machineType}`,
        ).catch(() => null);
        if (!fetched) return null;
        this.machineTypeSpecCache.set(machineType, fetched);
        machineTypeData = fetched;
      }

      const vmMonthly =
        (
          await this.estimateMachineTypeMonthlyPrices(
            [
              {
                id: machineType,
                vcpus: machineTypeData.guestCpus,
                memoryMb: machineTypeData.memoryMb,
              },
            ],
            zone,
          )
        )[machineType] ?? 0;

      let storageMonthly = 0;
      const bootSource = fields["bootSource"] ?? "new-image";
      if (bootSource === "new-image") {
        const diskGb = Number(fields["diskGb"] ?? 50);
        // GCE instance create provisions a pd-balanced boot disk.
        const diskRate = await this.getDiskMonthlyRate(zone, "pd-balanced");
        if (diskRate != null && Number.isFinite(diskGb) && diskGb > 0) {
          storageMonthly = diskGb * diskRate;
        }
      }

      const total = vmMonthly + storageMonthly;
      if (!Number.isFinite(total) || total <= 0) return null;
      return Number(total.toFixed(2));
    }

    if (typeId === "gce-disk") {
      const zone = fields["zone"] ?? "us-central1-a";
      const sizeGb = Number(fields["sizeGb"] ?? 50);
      if (!Number.isFinite(sizeGb) || sizeGb <= 0) return null;
      const diskType = fields["type"] ?? "pd-balanced";
      const diskRate = await this.getDiskMonthlyRate(zone, diskType);
      if (diskRate == null) return null;
      return Number((sizeGb * diskRate).toFixed(2));
    }

    if (typeId === "gke-cluster") {
      const zone = fields["location"] ?? "us-central1-a";
      const machineType = fields["machineType"] ?? "";
      const nodeCount = Math.max(1, Number(fields["nodeCount"] ?? 3));
      if (!machineType) return null;

      let machineTypeData = this.machineTypeSpecCache.get(machineType);
      if (!machineTypeData) {
        const fetched = await this.get<{ guestCpus: number; memoryMb: number }>(
          `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${zone}/machineTypes/${machineType}`,
        ).catch(() => null);
        if (!fetched) return null;
        this.machineTypeSpecCache.set(machineType, fetched);
        machineTypeData = fetched;
      }

      const perNodeVm =
        (
          await this.estimateMachineTypeMonthlyPrices(
            [
              {
                id: machineType,
                vcpus: machineTypeData.guestCpus,
                memoryMb: machineTypeData.memoryMb,
              },
            ],
            zone,
          )
        )[machineType] ?? 0;

      const diskGb = Number(fields["diskSizeGb"] ?? 100);
      // GKE node pools provision pd-balanced boot disks by default.
      const diskRate = await this.getDiskMonthlyRate(zone, "pd-balanced");
      const perNodeDisk =
        diskRate != null && Number.isFinite(diskGb) && diskGb > 0 ? diskGb * diskRate : 0;

      const total = (perNodeVm + perNodeDisk) * nodeCount;
      if (!Number.isFinite(total) || total <= 0) return null;
      return Number(total.toFixed(2));
    }

    return null;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    return gcpCreateResource(this.createCtx, typeId, accountId, fields, parentResourceId);
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

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    return runGetLogs(this.sharedCtx, typeId, resourceId, accountId, params);
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return gcpRenderDetail(this.detailCtx, resource);
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

    // Parse the OpenAI-compatible SSE stream: `data: {json}\n\n` lines until
    // `data: [DONE]`. Accumulate `choices[0].delta.content` so the terminal
    // `done` event carries the full assistant turn.
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";
    let assembled = "";
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
              };
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              assembled += delta;
              yield { kind: "delta", text: delta };
            }
            if (parsed.usage) {
              // exactOptionalPropertyTypes is on — only assign keys we have.
              const next: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
              } = {};
              if (parsed.usage.prompt_tokens !== undefined) {
                next.inputTokens = parsed.usage.prompt_tokens;
              }
              if (parsed.usage.completion_tokens !== undefined) {
                next.outputTokens = parsed.usage.completion_tokens;
              }
              if (parsed.usage.total_tokens !== undefined) {
                next.totalTokens = parsed.usage.total_tokens;
              }
              usage = next;
            }
          } catch {
            // Malformed SSE chunk — skip rather than abort the whole stream.
          }
        }
      }
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    yield {
      kind: "done",
      message: { role: "assistant", content: assembled },
      ...(usage ? { usage } : {}),
    };
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
