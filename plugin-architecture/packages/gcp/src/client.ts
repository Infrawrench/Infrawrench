import type { Credentials } from "./plugin.js";
import { attempt, attemptStream, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
  IdleFindingRecord,
  IdleScanRequest,
  VulnerabilityFinding,
  CostFetchRange,
  CostRow,
  BusinessMetricSourceDryRun,
  BusinessMetricSourceOption,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
  JitAccessPresence,
  JitGrantResult,
  JitGrantSpec,
  JitIdentity,
  JitPrincipal,
  JitRole,
  JitScope,
} from "@infrawrench/plugin-base";
import {
  checkGcpJitAccess,
  grantGcpJitAccess,
  listGcpJitPrincipals,
  listGcpJitRoles,
  listGcpJitScopes,
  resolveGcpJitPrincipal,
  revokeGcpJitAccess,
  type GcpJitContext,
} from "./jit-access.js";
import { hostFetch, reportUnreadListPart } from "@infrawrench/plugin-base";
import type { HostServices, PreflightResult } from "@infrawrench/plugin-base";
import { runGcpPreflight } from "./preflight.js";
import type {
  CiComputeStatus,
  CiExecutorKind,
  CiHandle,
  CiPreflightResult,
  CiStartSpec,
  CiTaggedCompute,
} from "@infrawrench/plugin-base";
import {
  gcpCiListTagged,
  gcpCiPreflight,
  gcpCiStart,
  gcpCiStatus,
  gcpCiTeardown,
} from "./ci-executor.js";
import type { GcpCiCalls } from "./ci-shared.js";
import {
  buildCostEstimate,
  fetchInstanceOnDemandRates,
  streamOpenAiSseChat,
  withAiCostTags,
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
  fetchComputeSkus,
  estimateMachineTypeMonthlyPrices,
  HOURS_PER_MONTH,
} from "./pricing.js";
import type { PriceCatalogRequest, PriceCatalogResult } from "@infrawrench/plugin-base";
import { fetchGcpPriceCatalog } from "./price-catalog.js";
import {
  buildGkeNodeRates,
  poolZone,
  type GkeCluster,
  type MachineSpec,
} from "./gke-node-rates.js";

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
import { isWholeTypeRefusal, readPages, saysPartWentUnread } from "./resource-listers/shared.js";
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
import { gcpInstancePricing } from "./instance-pricing.js";
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
import {
  dryRunGcpBusinessMetricSource,
  listGcpBusinessMetricOptions,
  runGcpBusinessMetricSource,
  type BigQueryMetricContext,
} from "./business-metric-source.js";

import type { GcpClientContext } from "./shared.js";
import { fetchGcpQuotas, type GcpProject, type GcpRegionList } from "./quotas.js";
import {
  fetchGcpVulnerabilityFindings,
  OCCURRENCE_PAGE_SIZE,
  type GcpOccurrenceList,
} from "./vulnerabilities.js";
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
import {
  cancelLatestCloudRunJobExecution,
  runCloudRunJob,
  updateCloudRunJob,
  updateMemorystoreValkey,
} from "./cloud-run-job-handlers.js";
import { VERTEX_GEMINI_MODELS } from "./resources/vertex-gemini-model.js";
import { fetchGcpIdleFindings, monitoringReader } from "./idle-findings.js";

/**
 * Vertex AI location used for the Gemini chat playground. The `global`
 * endpoint serves every curated Gemini model (the 3.x previews are served
 * nowhere else) and routes to whichever region has capacity.
 */
const VERTEX_DEFAULT_LOCATION = "global";

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
  private machineTypeSpecCache = new Map<string, MachineSpec>();

  constructor(
    credentials: Credentials,
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
    return fetchAccessToken(this.key, this.hostServices?.http);
  }

  private request(url: string, init?: RequestInit): Promise<Response> {
    return hostFetch({ http: this.hostServices?.http }, url, init);
  }

  private async get<T>(url: string): Promise<T> {
    let tok = await this.token();
    let res = await this.request(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.status === 401) {
      // Cached token may have been revoked early: invalidate and retry once.
      invalidateAccessToken(this.key);
      tok = await this.token();
      res = await this.request(url, { headers: { Authorization: `Bearer ${tok}` } });
    }
    if (!res.ok) {
      throw gcpApiError(res.status, url, await res.text(), this.project);
    }
    return res.json() as Promise<T>;
  }

  private paginate<T>(
    baseUrl: string,
    key: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    return readPages<T>(this.get.bind(this), baseUrl, key, params);
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
      getResource: (...args) => runPluginEffect(this.getResource(...args)),
    };
  }

  /**
   * Google's lists across locations answer 200 with what they could reach and name the
   * rest. What they name can't be called gone, and failing the type would throw away
   * what did come back, so those rows are kept and the type isn't pruned. By the whole
   * type, because the list names locations and not every row's id does.
   */
  private listerCtx(typeId: string, accountId: string): ListerContext {
    const get = async <T>(url: string): Promise<T> => {
      const body = await this.get<T>(url);
      if (
        saysPartWentUnread(body) &&
        !reportUnreadListPart({ idPrefixes: [this.id(accountId, typeId, "")] })
      ) {
        // Nobody keeps the rows it left out (the desktop, a read outside a sync), and
        // the part that came back is not the whole list.
        throw new Error(
          `GCP answered part of this list, naming locations it could not reach: ${url}`,
        );
      }
      return body;
    };
    return {
      get,
      paginate: (baseUrl, key, params) => readPages(get, baseUrl, key, params),
      id: this.id.bind(this),
      now: this.now.bind(this),
    };
  }

  private get firestoreCtx(): FirestoreContext {
    return {
      project: this.project,
      hostServices: this.hostServices,
      token: () => this.token(),
    };
  }

  private get cloudRunCtx(): CloudRunContext {
    return {
      project: this.project,
      hostServices: this.hostServices,
      token: () => this.token(),
    };
  }

  private get cloudArmorCtx(): CloudArmorContext {
    return {
      project: this.project,
      hostServices: this.hostServices,
      token: () => this.token(),
    };
  }

  private get bqSpannerCtx(): BigQuerySpannerContext {
    return {
      project: this.project,
      hostServices: this.hostServices,
      token: () => this.token(),
      get: this.get.bind(this),
    };
  }

  private get createCtx(): GcpCreateContext {
    return {
      get: this.get.bind(this),
      paginate: this.paginate.bind(this),
      hostServices: this.hostServices,
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

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      return runGcpPreflight(
        this.key,
        this.project,
        this.billingExportTable,
        this.hostServices?.http,
      );
    });
  }

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      try {
        return await this.listType(typeId, accountId);
      } catch (err) {
        // A least-privilege key refused the whole type: keep its stored rows rather
        // than fail on every poll. Where nobody keeps them (the desktop) it still shows.
        // An API that is off is not this: it names the API to turn on.
        if (!isWholeTypeRefusal(err) || !reportUnreadListPart({ idPrefixes: [""] })) throw err;
        return [];
      }
    });
  }

  private async listType(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const p = this.project;
    const ctx = this.listerCtx(typeId, accountId);
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
      case "memorystore-valkey":
        return listers.listMemorystoreValkey(ctx, accountId, p);
      case "cloud-run-job":
        return listers.listCloudRunJobs(ctx, accountId, p);
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const all = await runPluginEffect(this.listResources(typeId, accountId));
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
    });
  }

  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return runEnrichDetail(
        this.sharedCtx,
        this.cloudRunCtx,
        this.cloudArmorCtx,
        this.firestoreCtx,
        resource,
      );
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      if (outputKey === "nodeHourlyRates") {
        // The Kubernetes peer asks every managed-cluster type what its nodes
        // cost per hour, so it can derive per-namespace and per-workload spend.
        // Priced per node pool (machine cores + RAM at family rates, plus each
        // attached GPU's own SKU): see gke-node-rates.ts. Must never throw: the
        // host resolves every credentialMapping before building the peer
        // client, so a throw here would take the whole Kubernetes tab down. ""
        // makes the peer show capacity and efficiency without money.
        if (typeId !== "gke-cluster") return "";
        return this.gkeNodeHourlyRates(resourceId).catch(() => "");
      }

      return runResolveOutput(this.sharedCtx, typeId, resourceId, outputKey, accountId);
    });
  }

  /**
   * Compute Engine machine types and their list prices for one region (the
   * price catalog). The SKU list is fetched once per call; the host caches
   * the result for the declared refresh cadence.
   */
  fetchPriceCatalog(request: PriceCatalogRequest): PluginEffect<PriceCatalogResult> {
    return attempt(async () => {
      const get = this.get.bind(this);
      let skus: Promise<Awaited<ReturnType<typeof fetchComputeSkus>>> | null = null;
      return fetchGcpPriceCatalog(
        {
          project: this.project,
          get,
          computeSkus: () => (skus ??= fetchComputeSkus(get)),
        },
        request,
      );
    });
  }

  /** A machine type's vCPUs, memory and built-in GPUs, cached per process. */
  private async machineSpec(machineType: string, zone: string): Promise<MachineSpec | null> {
    const cached = this.machineTypeSpecCache.get(machineType);
    if (cached && cached.accelerators !== undefined) return cached;
    const fetched = await this.get<MachineSpec>(
      `https://compute.googleapis.com/compute/v1/projects/${this.project}/zones/${zone}/machineTypes/${machineType}`,
    ).catch(() => null);
    if (!fetched) return cached ?? null;
    const spec: MachineSpec = {
      guestCpus: fetched.guestCpus,
      memoryMb: fetched.memoryMb,
      accelerators: fetched.accelerators ?? [],
    };
    this.machineTypeSpecCache.set(machineType, spec);
    return spec;
  }

  private async gkeNodeHourlyRates(resourceId: string): Promise<string> {
    // `{accountId}:gke-cluster:{project}/{location}/{name}`.
    const match = /gke-cluster:([^/]+)\/([^/]+)\/([^/]+)$/.exec(resourceId);
    if (!match) return "";
    const [, project, location, name] = match;
    const cluster = await this.get<GkeCluster>(
      `https://container.googleapis.com/v1/projects/${project}/locations/${location}/clusters/${name}`,
    );
    const specs = new Map<string, MachineSpec>();
    for (const pool of cluster.nodePools ?? []) {
      const machineType = pool.config?.machineType;
      const zone = poolZone(cluster, pool);
      if (!machineType || !zone || specs.has(machineType)) continue;
      const spec = await this.machineSpec(machineType, zone);
      if (spec) specs.set(machineType, spec);
    }
    const geo = geoFromRegion(regionFromZone(location!));
    const rates = await this.getPricingRatesForGeo(geo);
    return buildGkeNodeRates(cluster, specs, rates);
  }

  private async getPricingRatesForGeo(geo: GeoRegion): Promise<PricingRates> {
    const cached = this.machineTypeFamilyRateCache.get(geo);
    if (cached && cached.expiresAt > Date.now())
      return {
        machineRates: cached.machineRates,
        diskGbMonthUsd: cached.diskGbMonthUsd,
        ...(cached.gpuHourlyUsd ? { gpuHourlyUsd: cached.gpuHourlyUsd } : {}),
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
    // The warehouse needs no Cloud Billing access and has every machine type's
    // own price, GPUs included. Without it, prices are worked out from the
    // Billing Catalog's per-core and per-GiB rates.
    const warehouse = await this.warehouseMonthlyPrices(
      machineTypes.map((m) => m.id),
      region,
    );
    if (warehouse && machineTypes.every((m) => warehouse[m.id] !== undefined)) return warehouse;
    const geo = geoFromRegion(region);
    const rates = await this.getPricingRatesForGeo(geo);
    return { ...estimateMachineTypeMonthlyPrices(machineTypes, rates), ...warehouse };
  }

  private async getDiskMonthlyRate(zone: string, diskType: string): Promise<number | null> {
    const region = regionFromZone(zone);
    const geo = geoFromRegion(region);
    const rates = await this.getPricingRatesForGeo(geo);
    const key = diskType as keyof typeof rates.diskGbMonthUsd;
    return rates.diskGbMonthUsd[key] ?? null;
  }

  exportCredential(
    typeId: string,
    resourceId: string,
    accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      return runExportCredential(this.sharedCtx, typeId, resourceId, accountId, formatId);
    });
  }

  getManifest(resourceId: string, accountId: string): PluginEffect<string> {
    return attempt(async () => {
      const typeId = resourceId.split(":")[1];
      if (typeId === "cloud-run-service" || typeId === "cloud-function") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
        // resolvedOutputs.cloudRunServiceName: synthesise a Run-shaped resource
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
            "Cloud Function has no backing Cloud Run service yet, so the manifest is unavailable.",
          );
        }
        const fresh = await fetchCloudRunServiceFull(this.cloudRunCtx, runResource);
        if (fresh.error) throw new Error(fresh.error);
        return serviceToYaml(fresh.service);
      }
      throw new Error(`GCP plugin: getManifest not supported for type "${typeId}"`);
    });
  }

  deleteResource(typeId: string, resourceId: string, accountId: string): PluginEffect<void> {
    return attempt(async () => {
      return runDeleteResource(this.sharedCtx, typeId, resourceId, accountId);
    });
  }

  publishMessage(
    typeId: string,
    resourceId: string,
    accountId: string,
    payload: PublishMessagePayload,
  ): PluginEffect<PublishMessageResult> {
    return attempt(async () => {
      const externalId = resourceId.split(":").slice(2).join(":");
      if (typeId === "pubsub-topic") {
        return publishPubsubTopic(
          { hostServices: this.hostServices, token: () => this.token(), project: this.project },
          externalId,
          payload,
        );
      }
      if (typeId === "cloud-tasks-queue") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        return publishCloudTasksQueue(
          { hostServices: this.hostServices, token: () => this.token(), project: this.project },
          {
            ...(resource.externalId !== undefined ? { externalId: resource.externalId } : {}),
            fields: resource.fields,
          },
          payload,
        );
      }
      throw new Error(`GCP plugin: publishMessage not supported for type "${typeId}"`);
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      if (typeId === "firestore-database") {
        return executeFirestoreCommand(this.firestoreCtx, resourceId, accountId, command, args);
      }
      if (typeId === "cloud-run-service" || typeId === "cloud-function") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
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
            "Cloud Function has no backing Cloud Run service yet. Try again once deployment finishes.",
          );
        }
        return executeCloudRunCommand(this.cloudRunCtx, runResource, command, args);
      }
      if (typeId === "cloud-armor-policy") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        return executeCloudArmorCommand(this.cloudArmorCtx, resource, command, args);
      }
      throw new Error(`GCP plugin: executeNoSqlCommand not supported for type "${typeId}"`);
    });
  }

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "instance-group" && actionId === "restart-replace") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        await restartReplaceInstanceGroup(this.sharedCtx, resource);
        return;
      }
      if (typeId === "gce-instance" && (actionId === "start" || actionId === "stop")) {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        await setGceInstancePower(this.sharedCtx, resource, actionId);
        return;
      }
      if (typeId === "cloud-run-job" && (actionId === "execute" || actionId === "cancel-latest")) {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (actionId === "execute") await runCloudRunJob(this.sharedCtx, resource);
        else await cancelLatestCloudRunJobExecution(this.sharedCtx, resource);
        return;
      }
      throw new Error(`GCP plugin: invokeAction "${actionId}" not supported for type "${typeId}"`);
    });
  }

  attachResource(
    sourceTypeId: string,
    sourceResourceId: string,
    targetTypeId: string,
    targetResourceId: string,
    accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      return runAttachResource(
        this.sharedCtx,
        sourceTypeId,
        sourceResourceId,
        targetTypeId,
        targetResourceId,
        accountId,
      );
    });
  }

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      return gcpGetCreateConfig(this.createCtx, typeId, parentResourceId);
    });
  }

  getCreateSizePricing(
    typeId: string,
    request: { regionId?: string; sizes: Array<{ id: string; vcpus: number; memoryMb: number }> },
  ): PluginEffect<Record<string, number>> {
    return attempt(async () => {
      if (typeId !== "gce-instance" && typeId !== "gke-cluster") return {};
      const zone = request.regionId ?? "us-central1-a";
      return this.estimateMachineTypeMonthlyPrices(request.sizes, zone);
    });
  }

  /**
   * Monthly estimate with line items, priced from the Cloud Billing catalog
   * for the resource's own zone.
   *
   * Machine specs come from `machineTypeSpecCache` (populated by
   * `getCreateConfig`) so a field change re-estimates without a network round
   * trip, which is what lets the cost badge track a storage slider as it
   * moves rather than lagging a request behind it.
   */
  estimateCost(typeId: string, fields: Record<string, string>): PluginEffect<CostEstimate | null> {
    return attempt(async () => {
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
            notes: ["On-demand rate. Sustained-use discounts are not deducted."],
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
              "Worker nodes only; the GKE management fee is not included.",
              "One zonal Autopilot-free cluster per billing account is exempt from that fee.",
            ],
          },
        );
      }

      return null;
    });
  }

  /**
   * Monthly price for one machine type in a zone, using the spec cache when
   * it is warm and falling back to a single machineTypes GET when it is not.
   */
  private async warehouseMonthlyPrices(
    machineTypes: readonly string[],
    region: string,
  ): Promise<Record<string, number> | null> {
    const rates = await fetchInstanceOnDemandRates(this.hostServices?.instancePricing, {
      platform: "gcp",
      region,
      instanceTypes: machineTypes,
      selection: { "variant.provisioningModel": "Standard" },
    });
    if (!rates) return null;
    return Object.fromEntries(
      Object.entries(rates).map(([type, hourly]) => [
        type,
        Number((hourly * HOURS_PER_MONTH).toFixed(2)),
      ]),
    );
  }

  private async machineTypeMonthlyPrice(machineType: string, zone: string): Promise<number | null> {
    const known = await this.warehouseMonthlyPrices([machineType], regionFromZone(zone));
    if (known?.[machineType] !== undefined) return known[machineType];
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

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      return gcpCreateResource(this.createCtx, typeId, accountId, fields, parentResourceId);
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      if (typeId === "gce-instance") {
        // Edit = change machine type (the right-sizing apply path). GCE only
        // allows setMachineType on a TERMINATED instance; the API's error for
        // a running one is surfaced as-is.
        const machineType = fields["machineType"];
        if (!machineType) {
          throw new Error("GCP plugin: machineType is the only editable VM instance field");
        }
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        await setGceInstanceMachineType(this.sharedCtx, resource, machineType);
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      if (typeId === "cloud-run-job" || typeId === "memorystore-valkey") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        if (typeId === "cloud-run-job") await updateCloudRunJob(this.sharedCtx, resource, fields);
        else await updateMemorystoreValkey(this.sharedCtx, resource, fields);
        return runPluginEffect(this.getResource(typeId, resourceId, accountId));
      }

      if (typeId === "cloud-dns-record-set") {
        // Cloud DNS record sets are immutable: "update" is a change transaction
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
        const getRes = await this.request(
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

        const changeRes = await this.request(
          `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${zoneName}/changes`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              deletions: [
                {
                  name,
                  type,
                  ttl: Number(current["ttl"] ?? ttl),
                  rrdatas: current["rrdatas"] ?? [],
                },
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
    });
  }

  executeFieldAction(
    typeId: string,
    fieldKey: string,
    actionId: string,
    _accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<{ value: string; option?: { id: string; label: string } }> {
    return attempt(async () => {
      if (
        typeId === "cloudsql-instance" &&
        fieldKey === "authorizedNetworks" &&
        actionId === "detect-my-ip"
      ) {
        const next = await detectMyPublicIp(fields[fieldKey]);
        return { value: next };
      }
      throw new Error(`GCP plugin: no field action for ${typeId}.${fieldKey} / ${actionId}`);
    });
  }

  applySecretReroll(
    typeId: string,
    resourceId: string,
    accountId: string,
    fieldKey: string,
    plaintext: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      if (typeId === "cloudsql-instance" && fieldKey === "rootPassword") {
        const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
        const databaseVersion = String(resource.fields["databaseVersion"] ?? "");
        const name = resource.externalId ?? String(resource.fields["name"] ?? "");
        if (!name) throw new Error("Cannot determine Cloud SQL instance name");
        // Default admin user per engine: matches `engineInfoFromVersion` in
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
        const res = await this.request(url, {
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
    });
  }

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      return runFetchDashboardStats(this.sharedCtx, resourceTypeId, resourceId, accountId);
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      return runFetchMetricSeries(this.sharedCtx, resourceTypeId, resourceId, accountId, timeRange);
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const rows = await fetchGcpCostData(
        {
          project: this.project,
          hostServices: this.hostServices,
          token: () => this.token(),
          billingExportTable: this.billingExportTable,
        },
        range,
      );
      // Normalized AI dimensions on Vertex AI / Gemini API lines, so request
      // logs routed to Vertex can be reconciled against them (provider level:
      // the export's service grain does not name the model).
      return withAiCostTags(rows, (row) => classifyGcpAiService(row.service));
    });
  }

  private get businessMetricCtx(): BigQueryMetricContext {
    return { project: this.project, hostServices: this.hostServices, token: () => this.token() };
  }

  listBusinessMetricSourceOptions(
    _accountId: string,
    fieldKey: string,
    params: Record<string, string>,
  ): PluginEffect<BusinessMetricSourceOption[]> {
    return attempt(async () => {
      return listGcpBusinessMetricOptions(this.businessMetricCtx, fieldKey, params);
    });
  }

  runBusinessMetricSource(
    _accountId: string,
    params: Record<string, string>,
    range: BusinessMetricSourceRange,
  ): PluginEffect<BusinessMetricSourceResult> {
    return attempt(async () => {
      return runGcpBusinessMetricSource(this.businessMetricCtx, params, range);
    });
  }

  dryRunBusinessMetricSource(
    _accountId: string,
    params: Record<string, string>,
    range: BusinessMetricSourceRange,
  ): PluginEffect<BusinessMetricSourceDryRun> {
    return attempt(async () => {
      return dryRunGcpBusinessMetricSource(this.businessMetricCtx, params, range);
    });
  }

  fetchCommitments(_accountId: string): PluginEffect<CommitmentRecord[]> {
    return attempt(async () => {
      return fetchGcpCommitments({ project: this.project, get: this.get.bind(this) });
    });
  }

  /**
   * Quota readings. Two requests for the whole project: `projects.get` for the
   * global quotas and one paginated `regions.list` for every region's; the
   * list response carries each region's full `quotas[]`, so there is no
   * per-region fan-out to bound. See `quotas.ts`.
   */
  /** Authenticated JSON POST with the same 401 retry as `get`. */
  private async post<T>(url: string, body: unknown): Promise<T> {
    const send = async (tok: string) =>
      this.request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    let res = await send(await this.token());
    if (res.status === 401) {
      invalidateAccessToken(this.key);
      res = await send(await this.token());
    }
    if (!res.ok) throw gcpApiError(res.status, url, await res.text(), this.project);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Authenticated JSON calls for the CI executors, with the same 401 retry as `get`. */
  private get ciCalls(): GcpCiCalls {
    return {
      project: this.project,
      call: async <T>(method: "GET" | "POST" | "DELETE", url: string, body?: unknown) => {
        const send = async (tok: string) =>
          this.request(url, {
            method,
            headers: {
              Authorization: `Bearer ${tok}`,
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
        let res = await send(await this.token());
        if (res.status === 401) {
          invalidateAccessToken(this.key);
          res = await send(await this.token());
        }
        if (!res.ok) throw gcpApiError(res.status, url, await res.text(), this.project);
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      },
    };
  }

  ciPreflight(kind: CiExecutorKind, region?: string): PluginEffect<CiPreflightResult> {
    return attempt(() => gcpCiPreflight(this.ciCalls, kind, region));
  }

  ciStart(spec: CiStartSpec): PluginEffect<CiHandle> {
    return attempt(() => gcpCiStart(this.ciCalls, spec));
  }

  ciStatus(handle: CiHandle): PluginEffect<CiComputeStatus> {
    return attempt(() => gcpCiStatus(this.ciCalls, handle));
  }

  ciTeardown(handle: CiHandle): PluginEffect<void> {
    return attempt(() => gcpCiTeardown(this.ciCalls, handle));
  }

  ciListTagged(tagKey: string, regions: readonly string[]): PluginEffect<CiTaggedCompute[]> {
    return attempt(() => gcpCiListTagged(this.ciCalls, tagKey, regions));
  }

  private get jitCtx(): GcpJitContext {
    return {
      project: this.project,
      get: this.get.bind(this),
      paginate: this.paginate.bind(this),
      post: this.post.bind(this),
    };
  }

  listJitScopes(): PluginEffect<JitScope[]> {
    return attempt(async () => {
      return listGcpJitScopes(this.jitCtx);
    });
  }

  listJitRoles(scopeId: string): PluginEffect<JitRole[]> {
    return attempt(async () => {
      return listGcpJitRoles(this.jitCtx, scopeId);
    });
  }

  resolveJitPrincipal(identity: JitIdentity): PluginEffect<JitPrincipal | null> {
    return attempt(async () => {
      return resolveGcpJitPrincipal(this.jitCtx, identity);
    });
  }

  listJitPrincipals(query?: string): PluginEffect<JitPrincipal[]> {
    return attempt(async () => {
      return listGcpJitPrincipals(this.jitCtx, query);
    });
  }

  grantJitAccess(spec: JitGrantSpec): PluginEffect<JitGrantResult> {
    return attempt(async () => {
      return grantGcpJitAccess(this.jitCtx, spec);
    });
  }

  revokeJitAccess(spec: JitGrantSpec): PluginEffect<void> {
    return attempt(async () => {
      return revokeGcpJitAccess(this.jitCtx, spec);
    });
  }

  checkJitAccess(spec: JitGrantSpec): PluginEffect<JitAccessPresence> {
    return attempt(async () => {
      return checkGcpJitAccess(this.jitCtx, spec);
    });
  }

  fetchIdleFindings(
    _accountId: string,
    request: IdleScanRequest,
  ): PluginEffect<IdleFindingRecord[]> {
    return attempt(async () => {
      return fetchGcpIdleFindings(request, {
        read: monitoringReader(this.project, (url) => this.get(url)),
        estimateCost: (typeId, fields) => runPluginEffect(this.estimateCost(typeId, fields)),
      });
    });
  }

  fetchQuotas(_accountId: string): PluginEffect<QuotaUsage[]> {
    return attempt(async () => {
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
    });
  }

  /**
   * Artifact Analysis vulnerability occurrences for the account's project.
   * See `vulnerabilities.ts` for the wire shape, bounds and access errors.
   */
  listVulnerabilityFindings(_accountId: string): PluginEffect<VulnerabilityFinding[]> {
    return attempt(async () => {
      const project = encodeURIComponent(this.project);
      return fetchGcpVulnerabilityFindings({
        project: this.project,
        listOccurrences: (pageToken) => {
          const url = new URL(
            `https://containeranalysis.googleapis.com/v1/projects/${project}/occurrences`,
          );
          url.searchParams.set("filter", 'kind="VULNERABILITY"');
          url.searchParams.set("pageSize", String(OCCURRENCE_PAGE_SIZE));
          if (pageToken) url.searchParams.set("pageToken", pageToken);
          return this.get<GcpOccurrenceList>(url.toString());
        },
        getServiceState: async (service) => {
          const res = await this.get<{ state?: string }>(
            `https://serviceusage.googleapis.com/v1/projects/${project}/services/${service}`,
          );
          return res.state;
        },
      });
    });
  }

  getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      return runGetLogs(this.sharedCtx, typeId, resourceId, accountId, params);
    });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    // Cloud Monitoring's default window (see `monitoring-client.ts`) is the
    // last hour. Renderers that want a different one (Cloud Run, Cloud
    // Functions: 24h) set `metricsCapability` themselves and are left alone.
    const detail = withMetricsCapability(
      gcpRenderDetail(this.detailCtx, resource),
      this.resourceTypes,
      resource.resourceTypeId,
      3_600_000,
    );
    const instancePricing = gcpInstancePricing(resource);
    return instancePricing ? { ...detail, instancePricing } : detail;
  }

  /**
   * Curated Gemini chat models surfaced as resources. No live API call: see
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
  private async *streamChatMessageIterable(
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

    // The global location has no region prefix on its host name.
    const host =
      location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
    const endpoint =
      `https://${host}/v1/projects/${this.project}` +
      `/locations/${location}/endpoints/openapi/chat/completions`;
    const body = JSON.stringify({
      model: `google/${modelId}`,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });

    let res: Response;
    try {
      res = await hostFetch({ http: this.hostServices?.http, stream: true }, endpoint, {
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

  streamChatMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    messages: ChatMessage[],
  ) {
    return attemptStream(() =>
      this.streamChatMessageIterable(typeId, resourceId, _accountId, messages),
    );
  }

  executeQuery(
    resourceId: string,
    accountId: string,
    sql: string,
  ): PluginEffect<{ rows: Record<string, unknown>[]; durationMs: number }> {
    return attempt(async () => {
      const typeId = resourceId.split(":")[1];
      if (typeId === "spanner-database") {
        return executeSpannerQuery(this.bqSpannerCtx, resourceId, accountId, sql);
      }
      return executeBigQueryQuery(this.bqSpannerCtx, resourceId, sql);
    });
  }

  estimateQueryCost(
    resourceId: string,
    _accountId: string,
    sql: string,
  ): PluginEffect<QueryCostEstimate> {
    return attempt(async () => {
      const { project, datasetId } = parseBigQueryDatasetExternalId(resourceId);
      const tok = await this.token();

      const res = await this.request(
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
    });
  }

  introspectResource(resourceId: string, accountId: string): PluginEffect<SqlTableMeta[]> {
    return attempt(async () => {
      const typeId = resourceId.split(":")[1];
      if (typeId === "spanner-database") {
        return introspectSpannerDatabase(this.bqSpannerCtx, resourceId, accountId);
      }
      return introspectBigQueryDataset(this.bqSpannerCtx, resourceId);
    });
  }

  getStorageAccessToken(): PluginEffect<string> {
    return attempt(async () => {
      return this.token();
    });
  }

  uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): PluginEffect<void> {
    return attempt(async () => {
      return runUploadStorageObject(this.sharedCtx, bucket, key, file, onProgress);
    });
  }

  deleteStorageObject(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      return runDeleteStorageObject(this.sharedCtx, bucket, key);
    });
  }

  makeStorageFolder(bucket: string, key: string): PluginEffect<void> {
    return attempt(async () => {
      return runMakeStorageFolder(this.sharedCtx, bucket, key);
    });
  }

  listStorageObjects(bucket: string, prefix: string): PluginEffect<StorageObject[]> {
    return attempt(async () => {
      return runListStorageObjects(this.sharedCtx, bucket, prefix);
    });
  }

  listArtifacts(
    typeId: string,
    resourceId: string,
    accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): PluginEffect<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    return attempt(async () => {
      return runListArtifacts(this.sharedCtx, typeId, resourceId, accountId, params);
    });
  }

  listSecretVersions(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<SecretVersion[]> {
    return attempt(async () => {
      return runListSecretVersions(this.sharedCtx, typeId, resourceId, accountId);
    });
  }

  accessSecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      return runAccessSecretVersion(this.sharedCtx, typeId, resourceId, accountId, versionId);
    });
  }

  addSecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    value: string,
  ): PluginEffect<SecretVersion> {
    return attempt(async () => {
      return runAddSecretVersion(this.sharedCtx, typeId, resourceId, accountId, value);
    });
  }

  modifySecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
    action: SecretVersionMutation,
  ): PluginEffect<SecretVersion> {
    return attempt(async () => {
      return runModifySecretVersion(
        this.sharedCtx,
        typeId,
        resourceId,
        accountId,
        versionId,
        action,
      );
    });
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

/** Vertex AI and the Gemini API on the billing export, for the AI cost tags. */
export function classifyGcpAiService(service: string | undefined): { provider: string } | null {
  if (!service) return null;
  if (/vertex ai/i.test(service)) return { provider: "vertex" };
  if (/gemini api|generative language/i.test(service)) return { provider: "gemini" };
  return null;
}
