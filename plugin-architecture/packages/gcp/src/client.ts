import type {
  PluginClient,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  StorageObject,
  ArtifactEntry,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
  DiskOption,
  RegionOption,
  PolicyOption,
  SqlTableMeta,
  ResourceTypeDefinition,
  DashboardStat,
  MetricSeries,
  QueryCostEstimate,
  CredentialExport,
  SecretVersion,
  SecretVersionMutation,
  SecretVersionState,
  ResourceStatus,
  LogsFetchParams,
  LogsFetchResult,
} from "@infrawrench/plugin-base";
import { dnsRecordBadgeColor, formatDnsTtl, labeledFieldItems } from "@infrawrench/plugin-base";
import type { HostServices } from "@infrawrench/plugin-base";
import {
  fetchAccessToken,
  invalidateAccessToken,
  serviceAccountKeySchema,
  type ServiceAccountKey,
} from "./auth.js";
import { formatBytes, formatGcpError, gcpStatus } from "./utils.js";
import { buildConnectionUrl, engineInfoFromVersion } from "./cloudsql-engine.js";
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
import { GCP_REGIONS, REGION_INFO, regionOption, PUBLIC_IMAGES } from "./regions.js";
import type { FirestoreContext } from "./firestore-handlers.js";
import {
  listFirestoreCollections,
  listFirestoreIndexes,
  listFirestoreIndexesForGroup,
  listFirestoreBackupSchedules,
  listFirestoreTtlConfigs,
  listFirestoreOperations,
  fetchFirestoreRules,
  listFirestoreBackups,
  fetchFirestoreDatabaseExtras,
  fetchFirestoreUsageMetrics,
  fetchFirestoreIamBindings,
  executeFirestoreCommand,
} from "./firestore-handlers.js";
import type {
  FirestoreIndexSummary,
  FirestoreBackupSchedule,
  FirestoreTtlConfig,
  FirestoreOperation,
  FirestoreRulesInfo,
  FirestoreBackupInfo,
  FirestoreDatabaseExtras,
  FirestoreUsageMetrics,
  FirestoreIamInfo,
} from "./firestore-handlers.js";
import type { BigQuerySpannerContext } from "./bigquery-spanner-handlers.js";
import {
  executeBigQueryQuery,
  parseSpannerResourceId,
  spannerRunSql,
  executeSpannerQuery,
  introspectBigQueryDataset,
  introspectSpannerDatabase,
} from "./bigquery-spanner-handlers.js";

import type { GcpCreateContext } from "./create-handlers.js";
import { gcpGetCreateConfig, gcpCreateResource } from "./create-handlers.js";
import type { GcpDetailContext } from "./detail-renderers.js";
import { gcpRenderDetail } from "./detail-renderers.js";
import type {
  CloudRunContext,
  CloudRunRevisionSummary,
  CloudRunIamInfo,
  CloudRunTriggerSummary,
  CloudRunFullServiceResult,
  CloudRunDomainMappingsResult,
} from "./cloud-run-handlers.js";
import {
  fetchCloudRunServiceFull,
  listCloudRunRevisions,
  listEventarcTriggersForService,
  fetchCloudRunIamBindings,
  listCloudRunDomainMappings,
  executeCloudRunCommand,
  serviceToYaml,
} from "./cloud-run-handlers.js";
import type { CloudArmorContext } from "./cloud-armor-handlers.js";
import {
  fetchCloudArmorPolicyFull,
  listCloudArmorTargets,
  executeCloudArmorCommand,
} from "./cloud-armor-handlers.js";

function mapSecretVersion(v: Record<string, unknown>): SecretVersion {
  const fullName = String(v["name"] ?? "");
  const id = fullName.split("/").pop() ?? "";
  const rawState = String(v["state"] ?? "ENABLED").toUpperCase();
  const state: SecretVersionState =
    rawState === "DISABLED" ? "disabled" : rawState === "DESTROYED" ? "destroyed" : "enabled";
  const result: SecretVersion = {
    id,
    state,
    createdAt: String(v["createTime"] ?? ""),
  };
  if (v["destroyTime"]) result.destroyedAt = String(v["destroyTime"]);
  return result;
}

function mapKmsKeyVersion(v: Record<string, unknown>, primaryId?: string): SecretVersion {
  const fullName = String(v["name"] ?? "");
  const id = fullName.split("/").pop() ?? "";
  const rawState = String(v["state"] ?? "ENABLED").toUpperCase();
  const state: SecretVersionState =
    rawState === "ENABLED"
      ? "enabled"
      : rawState === "DISABLED" ||
          rawState === "PENDING_GENERATION" ||
          rawState === "PENDING_IMPORT"
        ? "disabled"
        : "destroyed";
  const result: SecretVersion = {
    id,
    state,
    createdAt: String(v["createTime"] ?? ""),
  };
  if (v["destroyTime"] || v["destroyEventTime"]) {
    result.destroyedAt = String(v["destroyTime"] ?? v["destroyEventTime"] ?? "");
  }
  if (primaryId && id === primaryId) result.isLatest = true;
  return result;
}

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
    if (resource.resourceTypeId === "instance-group") {
      const managed = await this.listManagedInstances(resource).catch(() => []);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          managedInstances: JSON.stringify(managed),
        },
      };
    }
    if (resource.resourceTypeId === "cloud-run-service") {
      const [fullService, revisions, triggers, iam, domains] = await Promise.all([
        fetchCloudRunServiceFull(this.cloudRunCtx, resource).catch(
          (e) =>
            ({
              service: null,
              error: e instanceof Error ? e.message : String(e),
            }) as CloudRunFullServiceResult,
        ),
        listCloudRunRevisions(this.cloudRunCtx, resource).catch((e) => {
          console.warn("[cloud-run] listRevisions failed:", e);
          return [] as CloudRunRevisionSummary[];
        }),
        listEventarcTriggersForService(this.cloudRunCtx, resource).catch((e) => {
          console.warn("[cloud-run] listEventarcTriggers failed:", e);
          return [] as CloudRunTriggerSummary[];
        }),
        fetchCloudRunIamBindings(this.cloudRunCtx, resource).catch(
          (e) =>
            ({
              bindings: [],
              etag: "",
              error: e instanceof Error ? e.message : String(e),
            }) as CloudRunIamInfo,
        ),
        listCloudRunDomainMappings(this.cloudRunCtx, resource).catch(
          (e) =>
            ({
              mappings: [],
              error: e instanceof Error ? e.message : String(e),
            }) as CloudRunDomainMappingsResult,
        ),
      ]);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          cloudRunFullService: JSON.stringify(fullService),
          cloudRunRevisions: JSON.stringify(revisions),
          cloudRunTriggers: JSON.stringify(triggers),
          cloudRunIam: JSON.stringify(iam),
          cloudRunDomainMappings: JSON.stringify(domains),
        },
      };
    }
    if (resource.resourceTypeId === "cloud-function") {
      const cloudRunServiceName = String(resource.resolvedOutputs["cloudRunServiceName"] ?? "");
      if (!cloudRunServiceName) {
        return resource;
      }
      // Synthesise a Cloud Run-shaped resource so the existing helpers can be
      // reused. They derive the API path from `externalId`.
      const runProxy: ResourceInstance = {
        ...resource,
        resourceTypeId: "cloud-run-service",
        externalId: cloudRunServiceName,
      };
      const [fullService, revisions, triggers, iam, domains] = await Promise.all([
        fetchCloudRunServiceFull(this.cloudRunCtx, runProxy).catch(
          (e) =>
            ({
              service: null,
              error: e instanceof Error ? e.message : String(e),
            }) as CloudRunFullServiceResult,
        ),
        listCloudRunRevisions(this.cloudRunCtx, runProxy).catch((e) => {
          console.warn("[cloud-function] listRevisions failed:", e);
          return [] as CloudRunRevisionSummary[];
        }),
        listEventarcTriggersForService(this.cloudRunCtx, runProxy).catch((e) => {
          console.warn("[cloud-function] listEventarcTriggers failed:", e);
          return [] as CloudRunTriggerSummary[];
        }),
        fetchCloudRunIamBindings(this.cloudRunCtx, runProxy).catch(
          (e) =>
            ({
              bindings: [],
              etag: "",
              error: e instanceof Error ? e.message : String(e),
            }) as CloudRunIamInfo,
        ),
        listCloudRunDomainMappings(this.cloudRunCtx, runProxy).catch(
          (e) =>
            ({
              mappings: [],
              error: e instanceof Error ? e.message : String(e),
            }) as CloudRunDomainMappingsResult,
        ),
      ]);
      const svc = fullService.service ?? null;
      const template = (svc?.["template"] as Record<string, unknown> | undefined) ?? {};
      const containers =
        (template["containers"] as Array<Record<string, unknown>> | undefined) ?? [];
      const image = String(containers[0]?.["image"] ?? "");
      const lastModifier = String(svc?.["lastModifier"] ?? "");
      const latestRevision =
        String(svc?.["latestReadyRevision"] ?? "")
          .split("/")
          .pop() ?? "";
      const serviceUrl = String(svc?.["uri"] ?? "");
      return {
        ...resource,
        fields: {
          ...resource.fields,
          ...(image ? { image } : {}),
          ...(lastModifier ? { lastModifier } : {}),
          ...(latestRevision ? { latestRevision } : {}),
        },
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          ...(serviceUrl ? { serviceUrl } : {}),
          cloudRunFullService: JSON.stringify(fullService),
          cloudRunRevisions: JSON.stringify(revisions),
          cloudRunTriggers: JSON.stringify(triggers),
          cloudRunIam: JSON.stringify(iam),
          cloudRunDomainMappings: JSON.stringify(domains),
        },
      };
    }
    if (resource.resourceTypeId === "cloud-tasks-queue") {
      const tasks = await this.listCloudTasksQueueTasks(resource).catch((e) => {
        console.warn("[cloud-tasks] listTasks failed:", e);
        return { items: [], error: e instanceof Error ? e.message : String(e) };
      });
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          cloudTasksQueueTasks: JSON.stringify(tasks),
        },
      };
    }
    if (resource.resourceTypeId === "cloud-router") {
      const [full, policies] = await Promise.all([
        this.fetchCloudRouterFull(resource).catch((e) => {
          console.warn("[cloud-router] fetchFull failed:", e);
          return { error: e instanceof Error ? e.message : String(e) };
        }),
        this.listCloudRouterRoutePolicies(resource).catch((e) => {
          console.warn("[cloud-router] listRoutePolicies failed:", e);
          return { result: [], error: e instanceof Error ? e.message : String(e) };
        }),
      ]);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          cloudRouterFull: JSON.stringify(full),
          cloudRouterPolicies: JSON.stringify(policies),
        },
      };
    }
    if (resource.resourceTypeId === "cloud-nat") {
      const [router, status] = await Promise.all([
        this.fetchCloudNatRouter(resource).catch((e) => {
          console.warn("[cloud-nat] fetchRouter failed:", e);
          return { error: e instanceof Error ? e.message : String(e) };
        }),
        this.fetchCloudNatRouterStatus(resource).catch((e) => {
          console.warn("[cloud-nat] fetchRouterStatus failed:", e);
          return { error: e instanceof Error ? e.message : String(e) };
        }),
      ]);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          cloudNatRouter: JSON.stringify(router),
          cloudNatStatus: JSON.stringify(status),
        },
      };
    }
    if (resource.resourceTypeId === "firestore-database") {
      let indexesError = "";
      const [collections, indexes, schedules, ttl, ops, rules, backups, extras, metrics, iamInfo] =
        await Promise.all([
          listFirestoreCollections(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] listCollections failed:", e);
            return [] as string[];
          }),
          listFirestoreIndexes(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] listIndexes failed:", e);
            indexesError = e instanceof Error ? e.message : String(e);
            return [] as FirestoreIndexSummary[];
          }),
          listFirestoreBackupSchedules(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] listBackupSchedules failed:", e);
            return [] as FirestoreBackupSchedule[];
          }),
          listFirestoreTtlConfigs(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] listTtlConfigs failed:", e);
            return [] as FirestoreTtlConfig[];
          }),
          listFirestoreOperations(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] listOperations failed:", e);
            return [] as FirestoreOperation[];
          }),
          fetchFirestoreRules(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] fetchRules failed:", e);
            return {
              rulesetName: "",
              content: "",
              updateTime: "",
              error: e instanceof Error ? e.message : String(e),
            } as FirestoreRulesInfo;
          }),
          listFirestoreBackups(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] listBackups failed:", e);
            return [] as FirestoreBackupInfo[];
          }),
          fetchFirestoreDatabaseExtras(this.firestoreCtx, resource).catch((e) => {
            console.warn("[firestore] fetchDatabaseExtras failed:", e);
            return {
              earliestVersionTime: "",
              versionRetentionPeriod: "",
              pointInTimeRecoveryEnablement: "",
            } as FirestoreDatabaseExtras;
          }),
          fetchFirestoreUsageMetrics(this.firestoreCtx, resource).catch((e) => ({
            reads24h: 0,
            writes24h: 0,
            deletes24h: 0,
            storageBytes: 0,
            available: false,
            error: e instanceof Error ? e.message : String(e),
          })),
          fetchFirestoreIamBindings(this.firestoreCtx).catch(
            (e) =>
              ({
                bindings: [],
                etag: "",
                error: e instanceof Error ? e.message : String(e),
              }) as FirestoreIamInfo,
          ),
        ]);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          firestoreCollections: JSON.stringify(collections),
          firestoreIndexes: JSON.stringify(indexes),
          firestoreIndexesError: indexesError,
          firestoreBackupSchedules: JSON.stringify(schedules),
          firestoreTtl: JSON.stringify(ttl),
          firestoreOperations: JSON.stringify(ops),
          firestoreRules: JSON.stringify(rules),
          firestoreBackups: JSON.stringify(backups),
          firestoreDatabaseExtras: JSON.stringify(extras),
          firestoreUsageMetrics: JSON.stringify(metrics),
          firestoreIam: JSON.stringify(iamInfo),
        },
      };
    }
    if (resource.resourceTypeId === "cloud-armor-policy") {
      const [full, targets] = await Promise.all([
        fetchCloudArmorPolicyFull(this.cloudArmorCtx, resource).catch((e) => ({
          rules: [],
          fingerprint: "",
          error: e instanceof Error ? e.message : String(e),
        })),
        listCloudArmorTargets(this.cloudArmorCtx, resource).catch((e) => ({
          targets: [],
          error: e instanceof Error ? e.message : String(e),
        })),
      ]);
      return {
        ...resource,
        resolvedOutputs: {
          ...resource.resolvedOutputs,
          cloudArmorPolicyFull: JSON.stringify(full),
          cloudArmorTargets: JSON.stringify(targets),
        },
      };
    }
    return resource;
  }

  /**
   * Fetch the VMs currently managed by an instance group. Returns an empty
   * array for unmanaged groups (zone+region both empty) or on any API error.
   * Each entry has enough info to construct a GCE instance resource id and a
   * minimal dashboard card.
   */
  private async listManagedInstances(resource: ResourceInstance): Promise<
    Array<{
      name: string;
      zone: string;
      externalId: string;
      resourceId: string;
      status: string;
      currentAction: string;
    }>
  > {
    const p = this.project;
    const zone = String(resource.fields["zone"] ?? "");
    const region = String(resource.fields["region"] ?? "");
    const groupName = String(resource.fields["name"] ?? "");
    if (!groupName || (!zone && !region)) return [];
    const base = zone
      ? `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroupManagers/${groupName}`
      : `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/instanceGroupManagers/${groupName}`;
    const tok = await this.token();
    const res = await fetch(`${base}/listManagedInstances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      throw new Error(
        `GCP API ${res.status} for ${base}/listManagedInstances: ${await res.text()}`,
      );
    }
    const data = (await res.json()) as {
      managedInstances?: Array<{
        instance?: string;
        instanceStatus?: string;
        currentAction?: string;
      }>;
    };
    const results: Array<{
      name: string;
      zone: string;
      externalId: string;
      resourceId: string;
      status: string;
      currentAction: string;
    }> = [];
    for (const m of data.managedInstances ?? []) {
      const fullUrl = String(m.instance ?? "");
      // Format: https://www.googleapis.com/compute/v1/projects/{p}/zones/{zone}/instances/{name}
      const match = fullUrl.match(/\/zones\/([^/]+)\/instances\/([^/]+)$/);
      if (!match) continue;
      const [, instZone, instName] = match;
      const externalId = `${p}/${instZone}/${instName}`;
      results.push({
        name: instName!,
        zone: instZone!,
        externalId,
        resourceId: this.id(resource.accountId, "gce-instance", externalId),
        status: String(m.instanceStatus ?? ""),
        currentAction: String(m.currentAction ?? "NONE"),
      });
    }
    return results;
  }

  /**
   * Fetch the first page of tasks (up to 50) for a Cloud Tasks queue. Returned
   * tasks include scheduling, dispatch count, and HTTP target URL when present.
   * The Tasks API only exposes a "BASIC" or "FULL" view; we ask for FULL so the
   * Tasks tab can show the request URL.
   */
  private async listCloudTasksQueueTasks(resource: ResourceInstance): Promise<{
    items: Array<{
      name: string;
      shortName: string;
      scheduleTime: string;
      createTime: string;
      dispatchCount: number;
      responseCount: number;
      url: string;
      method: string;
    }>;
    error?: string;
  }> {
    const fullName = resource.externalId ?? "";
    if (!fullName) return { items: [] };
    const url = new URL(`https://cloudtasks.googleapis.com/v2/${fullName}/tasks`);
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("responseView", "FULL");
    const data = await this.get<{
      tasks?: Array<Record<string, unknown>>;
    }>(url.toString());
    const items = (data.tasks ?? []).map((t) => {
      const name = String(t["name"] ?? "");
      const shortName = name.split("/").pop() ?? name;
      const httpRequest = (t["httpRequest"] ?? t["appEngineHttpRequest"]) as
        | Record<string, unknown>
        | undefined;
      return {
        name,
        shortName,
        scheduleTime: String(t["scheduleTime"] ?? ""),
        createTime: String(t["createTime"] ?? ""),
        dispatchCount: Number(t["dispatchCount"] ?? 0),
        responseCount: Number(t["responseCount"] ?? 0),
        url: String(httpRequest?.["url"] ?? httpRequest?.["relativeUri"] ?? ""),
        method: String(httpRequest?.["httpMethod"] ?? ""),
      };
    });
    return { items };
  }

  /**
   * Fetch the full Cloud Router record so the detail view can render BGP
   * advertisements, BGP peers, and embedded NAT gateway configs. The
   * top-level lister returns a slim summary; this round-trips for the rest.
   */
  private async fetchCloudRouterFull(resource: ResourceInstance): Promise<Record<string, unknown>> {
    const p = this.project;
    const region = String(resource.fields["region"] ?? "");
    const name = String(resource.fields["name"] ?? resource.displayName);
    if (!region || !name) return {};
    return this.get<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}`,
    );
  }

  /**
   * List BGP route policies attached to a Cloud Router. The API returns 404
   * (or 400) on routers in regions where the feature isn't available; the
   * caller catches and surfaces an empty list in that case.
   */
  private async listCloudRouterRoutePolicies(resource: ResourceInstance): Promise<{
    result: Array<{ name: string; type: string; terms?: unknown[]; fingerprint?: string }>;
  }> {
    const p = this.project;
    const region = String(resource.fields["region"] ?? "");
    const name = String(resource.fields["name"] ?? resource.displayName);
    if (!region || !name) return { result: [] };
    return this.get<{
      result: Array<{ name: string; type: string; terms?: unknown[]; fingerprint?: string }>;
    }>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}/listRoutePolicies`,
    );
  }

  /**
   * Fetch the router that hosts a given Cloud NAT. The full router config
   * carries every NAT setting (timeouts, port allocation, log config), since
   * Cloud NAT is a sub-resource of the router rather than a top-level entity.
   */
  private async fetchCloudNatRouter(resource: ResourceInstance): Promise<Record<string, unknown>> {
    const p = this.project;
    const region = String(resource.fields["region"] ?? "");
    const router = String(resource.fields["router"] ?? "");
    if (!region || !router) return {};
    return this.get<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${router}`,
    );
  }

  /**
   * Fetch the router status, which includes per-NAT runtime info: allocated
   * IPs (auto + user), VM endpoint count, and minExtraNatIpsNeeded. Used to
   * render the "Allocated external IP addresses" panel.
   */
  private async fetchCloudNatRouterStatus(
    resource: ResourceInstance,
  ): Promise<Record<string, unknown>> {
    const p = this.project;
    const region = String(resource.fields["region"] ?? "");
    const router = String(resource.fields["router"] ?? "");
    if (!region || !router) return {};
    return this.get<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${router}/getRouterStatus`,
    );
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const p = this.project;

    if (typeId === "gke-cluster" && outputKey === "kubeconfig") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const cluster = await this.get<Record<string, unknown>>(
        `https://container.googleapis.com/v1/projects/${p}/locations/${String(resource.fields["location"])}/clusters/${resource.externalId}`,
      );
      // The endpoint comes from the API response, not from resolvedOutputs
      const endpoint = (cluster["endpoint"] as string) ?? "";
      const caCert =
        ((cluster["masterAuth"] as Record<string, unknown> | undefined)?.[
          "clusterCaCertificate"
        ] as string) ?? "";
      const tok = await this.token();
      const kubeconfig = [
        "apiVersion: v1",
        "kind: Config",
        `clusters:`,
        `- cluster:`,
        `    server: https://${endpoint}`,
        `    certificate-authority-data: ${caCert}`,
        `  name: ${String(cluster["name"])}`,
        `contexts:`,
        `- context:`,
        `    cluster: ${String(cluster["name"])}`,
        `    user: ${String(cluster["name"])}`,
        `  name: ${String(cluster["name"])}`,
        `current-context: ${String(cluster["name"])}`,
        `users:`,
        `- name: ${String(cluster["name"])}`,
        `  user:`,
        `    token: ${tok}`,
      ].join("\n");
      return kubeconfig;
    }

    if (typeId === "memorystore-redis") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      if (outputKey === "authString") {
        const name = resource.externalId ?? "";
        const data = await this.get<Record<string, unknown>>(
          `https://redis.googleapis.com/v1/${name}/authString`,
        );
        return (data["authString"] as string) ?? "";
      }
      if (outputKey === "host")
        return String(resource.fields["host"] ?? resource.resolvedOutputs["host"] ?? "");
      if (outputKey === "port")
        return String(resource.fields["port"] ?? resource.resolvedOutputs["port"] ?? "6379");
      if (outputKey === "redisUrl") {
        const host = String(resource.fields["host"] ?? resource.resolvedOutputs["host"] ?? "");
        const port = String(resource.fields["port"] ?? resource.resolvedOutputs["port"] ?? "6379");
        const name = resource.externalId ?? "";
        try {
          const data = await this.get<Record<string, unknown>>(
            `https://redis.googleapis.com/v1/${name}/authString`,
          );
          const auth = (data["authString"] as string) ?? "";
          return auth ? `redis://:${auth}@${host}:${port}` : `redis://${host}:${port}`;
        } catch {
          return `redis://${host}:${port}`;
        }
      }
    }

    if (typeId === "cloudsql-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const databaseVersion = String(resource.fields["databaseVersion"] ?? "");
      const engine = engineInfoFromVersion(databaseVersion);
      const ipAddress = String(resource.resolvedOutputs["ipAddress"] ?? "");
      const persistedPassword =
        (await this.hostServices?.secrets?.getPlaintext(resourceId, "rootPassword")) ?? null;
      const password = persistedPassword ?? String(resource.fields["rootPassword"] ?? ""); // legacy fallback for instances created before the secretStates migration
      if (outputKey === "connectionName")
        return String(
          resource.fields["connectionName"] ?? resource.resolvedOutputs["connectionName"] ?? "",
        );
      if (outputKey === "ipAddress") return ipAddress;
      if (outputKey === "username") return engine.username;
      if (outputKey === "port") return engine.port;
      if (outputKey === "password") return password;
      if (outputKey === "connectionUrl")
        return buildConnectionUrl(databaseVersion, ipAddress, password);
    }

    if (typeId === "alloydb-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const ipAddress = String(resource.resolvedOutputs["ipAddress"] ?? "");
      // Password lives on the parent cluster (AlloyDB's initialUser is set
      // at cluster creation). Derive the cluster's resourceId from the
      // instance's external name and look the secret up there.
      const clusterFullName = (resource.externalId ?? "").split("/instances/")[0] ?? "";
      const clusterResourceId = clusterFullName
        ? this.id(accountId, "alloydb-cluster", clusterFullName)
        : "";
      const password = clusterResourceId
        ? ((await this.hostServices?.secrets?.getPlaintext(clusterResourceId, "rootPassword")) ??
          "")
        : "";
      if (outputKey === "ipAddress") return ipAddress;
      if (outputKey === "username") return "postgres";
      if (outputKey === "port") return "5432";
      if (outputKey === "password") return password;
      if (outputKey === "connectionUrl") {
        if (!ipAddress) return "";
        const pw = encodeURIComponent(password);
        return `postgres://postgres:${pw}@${ipAddress}:5432/postgres`;
      }
    }

    if (typeId === "ssl-certificate") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fields = resource.fields;
      if (outputKey === "dnsRecords") {
        const domains = String(fields["domains"] ?? "");
        if (!domains) return "";
        const domainList = domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
        const records = domainList.map((domain) => {
          const recordName = `_acme-challenge.${domain}.`;
          const recordValue = `${resource.externalId || resource.displayName}.${p}.dscvr.cloud.goog.`;
          return `CNAME ${recordName} -> ${recordValue}`;
        });
        return records.join("\n");
      }
      if (outputKey === "domains") return String(fields["domains"] ?? "");
    }

    if (typeId === "gcs-bucket") {
      if (outputKey === "bucketName") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        return String(resource.fields["name"] ?? resource.displayName);
      }
      if (outputKey === "endpoint") {
        const resource = await this.getResource(typeId, resourceId, accountId);
        return `https://storage.googleapis.com/${String(resource.fields["name"] ?? resource.displayName)}`;
      }
      if (outputKey === "serviceAccountKey") {
        // Create a new service account key via the IAM API
        const tok = await this.token();
        const email = this.key.client_email;
        const res = await fetch(
          `https://iam.googleapis.com/v1/projects/${this.project}/serviceAccounts/${encodeURIComponent(email)}/keys`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tok}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ keyAlgorithm: "KEY_ALG_RSA_2048" }),
          },
        );
        if (!res.ok) throw new Error(`IAM API ${res.status}: ${await res.text()}`);
        const data = (await res.json()) as { privateKeyData: string };
        // privateKeyData is base64-encoded JSON — decode it
        return atob(data.privateKeyData);
      }
    }

    if (typeId === "cloud-dns-zone" && outputKey === "nameservers") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.fields["nameservers"] ?? "");
    }

    if (typeId === "secret-manager-secret" && outputKey === "latestVersion") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const secretName = resource.externalId ?? "";
      const data = await this.get<Record<string, unknown>>(
        `https://secretmanager.googleapis.com/v1/${secretName}/versions/latest:access`,
      );
      const payload = data["payload"] as Record<string, unknown> | undefined;
      const b64 = (payload?.["data"] as string) ?? "";
      return atob(b64);
    }

    if (typeId === "static-ip" && outputKey === "address") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.fields["address"] ?? resource.resolvedOutputs["address"] ?? "");
    }

    if (typeId === "forwarding-rule" && outputKey === "IPAddress") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.fields["IPAddress"] ?? resource.resolvedOutputs["IPAddress"] ?? "");
    }

    if (typeId === "filestore-instance" && outputKey === "ipAddress") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.fields["ipAddress"] ?? resource.resolvedOutputs["ipAddress"] ?? "");
    }

    if (typeId === "memorystore-memcached" && outputKey === "discoveryEndpoint") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(
        resource.fields["discoveryEndpoint"] ?? resource.resolvedOutputs["discoveryEndpoint"] ?? "",
      );
    }

    if (typeId === "composer-environment" && outputKey === "airflowUri") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.fields["airflowUri"] ?? resource.resolvedOutputs["airflowUri"] ?? "");
    }

    if (typeId === "app-engine-service" && outputKey === "url") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.resolvedOutputs["url"] ?? "");
    }

    if (typeId === "cloud-function" && outputKey === "url") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.resolvedOutputs["url"] ?? "");
    }

    if (typeId === "vpc-network") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.resolvedOutputs[outputKey] ?? "");
    }

    if (typeId === "cloud-router") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.resolvedOutputs[outputKey] ?? "");
    }

    if (typeId === "instance-template") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.resolvedOutputs[outputKey] ?? "");
    }

    if (typeId === "gcp-service-account" && outputKey === "key") {
      const exp = await this.exportCredential(typeId, resourceId, accountId, "json-key");
      return exp.content;
    }

    if (typeId === "firewall-rule" && outputKey === "name") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return resource.externalId ?? String(resource.fields["name"] ?? "");
    }

    if (typeId === "pubsub-topic" && (outputKey === "topicName" || outputKey === "name")) {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // Full resource name (projects/X/topics/Y) — what Eventarc and most APIs expect.
      return resource.externalId ?? String(resource.fields["name"] ?? "");
    }

    if (typeId === "gcp-service-account" && outputKey === "email") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      return String(resource.fields["email"] ?? "");
    }

    throw new Error(`GCP plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
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
    if (typeId === "gcp-service-account") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const email = String(resource.externalId ?? resource.fields["email"] ?? "");
      if (!email) throw new Error("Cannot determine service account email");
      const privateKeyType =
        formatId === "p12-key" ? "TYPE_PKCS12_FILE" : "TYPE_GOOGLE_CREDENTIALS_FILE";
      const tok = await this.token();
      const res = await fetch(
        `https://iam.googleapis.com/v1/projects/${this.project}/serviceAccounts/${encodeURIComponent(email)}/keys`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            keyAlgorithm: "KEY_ALG_RSA_2048",
            privateKeyType,
          }),
        },
      );
      if (!res.ok) throw new Error(await formatGcpError("Create service account key", res));
      const data = (await res.json()) as {
        name?: string;
        privateKeyData?: string;
        validAfterTime?: string;
        validBeforeTime?: string;
      };
      const privateKeyData = data.privateKeyData ?? "";
      if (!privateKeyData) throw new Error("GCP returned an empty key");
      // The `name` field looks like "projects/p/serviceAccounts/email/keys/<keyId>".
      const keyId = (data.name ?? "").split("/").pop() ?? "";
      const baseName = email.split("@")[0] ?? "service-account";
      if (formatId === "p12-key") {
        return {
          content: privateKeyData,
          filename: `${baseName}.p12`,
          mimeType: "application/x-pkcs12",
          fields: [
            { label: "Key ID", value: keyId },
            { label: "Password", value: "notasecret", hint: "Fixed by GCP" },
          ],
          warning:
            "Save this now. The PKCS#12 bundle cannot be re-downloaded from GCP once this dialog closes.",
        };
      }
      // JSON key: privateKeyData is base64 of the JSON file.
      const jsonContent = atob(privateKeyData);
      return {
        content: jsonContent,
        filename: `${baseName}.json`,
        mimeType: "application/json",
        fields: [{ label: "Key ID", value: keyId }],
        warning:
          "Save this now. GCP keeps the public key but the private key portion cannot be re-downloaded.",
      };
    }
    throw new Error(
      `GCP plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
    );
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
    const p = this.project;
    const tok = await this.token();

    if (typeId === "gce-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const zone = String(resource.fields["zone"] ?? "");
      const name = String(
        resource.fields["name"] ??
          (resource.externalId ?? resource.displayName).split("/").pop() ??
          "",
      );
      if (!zone || !name) throw new Error("Cannot determine zone or instance name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instances/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "gke-cluster") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const location = String(resource.fields["location"] ?? "");
      const name = resource.externalId ?? resource.displayName;
      if (!location || !name)
        throw new Error("Cannot determine location or cluster name for deletion");
      const res = await fetch(
        `https://container.googleapis.com/v1/projects/${p}/locations/${location}/clusters/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GKE API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "gce-disk") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const zone = String(resource.fields["zone"] ?? "");
      const name = String(resource.fields["name"] ?? "");
      if (!zone || !name) throw new Error("Cannot determine zone or disk name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/disks/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloudsql-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? resource.externalId ?? "");
      const res = await fetch(
        `https://sqladmin.googleapis.com/v1/projects/${p}/instances/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`Cloud SQL API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-run-service") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://run.googleapis.com/v2/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Cloud Run API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-function") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://cloudfunctions.googleapis.com/v2/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Cloud Functions API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "pubsub-topic") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "pubsub-subscription") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "secret-manager-secret") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://secretmanager.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "firewall-rule") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? resource.externalId ?? "");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "static-ip") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? "");
      const region = String(resource.fields["region"] ?? "");
      if (!name || !region) throw new Error("Cannot determine name or region for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/addresses/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-scheduler-job") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://cloudscheduler.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Cloud Scheduler API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-tasks-queue") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://cloudtasks.googleapis.com/v2/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Cloud Tasks API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "artifact-registry-repo") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://artifactregistry.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Artifact Registry API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "workflow") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://workflows.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Workflows API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "filestore-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      const res = await fetch(`https://file.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Filestore API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "gcs-bucket") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? resource.externalId ?? "");
      if (!name) throw new Error("Cannot determine bucket name for deletion");
      const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${name}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`GCS API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "spanner-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.externalId ?? resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine Spanner instance name for deletion");
      const res = await fetch(`https://spanner.googleapis.com/v1/projects/${p}/instances/${name}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "spanner-database") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const extId = String(resource.externalId ?? "");
      const [instance, name] = extId.split("/");
      if (!instance || !name)
        throw new Error("Cannot determine Spanner database identity for deletion");
      const res = await fetch(
        `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/databases/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "spanner-backup") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const extId = String(resource.externalId ?? "");
      const [instance, name] = extId.split("/");
      if (!instance || !name)
        throw new Error("Cannot determine Spanner backup identity for deletion");
      const res = await fetch(
        `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/backups/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "bigtable-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.externalId ?? resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine Bigtable instance name for deletion");
      const res = await fetch(
        `https://bigtableadmin.googleapis.com/v2/projects/${p}/instances/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`Bigtable API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "firestore-database") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.externalId ?? resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine Firestore database name for deletion");
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${p}/databases/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`Firestore API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "memorystore-redis") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      if (!fullName) throw new Error("Cannot determine Redis instance name for deletion");
      const res = await fetch(`https://redis.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Memorystore Redis API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "alloydb-cluster") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      if (!fullName) throw new Error("Cannot determine AlloyDB cluster name for deletion");
      const res = await fetch(`https://alloydb.googleapis.com/v1/${fullName}?force=true`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "alloydb-instance") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      if (!fullName) throw new Error("Cannot determine AlloyDB instance name for deletion");
      const res = await fetch(`https://alloydb.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "memorystore-memcached") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      if (!fullName) throw new Error("Cannot determine Memcached instance name for deletion");
      const res = await fetch(`https://memcache.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Memorystore Memcached API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "vpc-network") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine VPC network name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "subnet") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? "");
      const region = String(resource.fields["region"] ?? "");
      if (!name || !region) throw new Error("Cannot determine name or region for subnet deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/subnetworks/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-router") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? "");
      const region = String(resource.fields["region"] ?? "");
      if (!name || !region) throw new Error("Cannot determine name or region for router deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-nat") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const region = String(resource.fields["region"] ?? "");
      const routerName = String(resource.fields["router"] ?? "");
      const natName = String(resource.fields["name"] ?? "");
      if (!region || !routerName || !natName)
        throw new Error("Cannot determine region, router, or NAT name for deletion");
      // Cloud NAT is a sub-resource of the router — fetch the router, remove this NAT, then patch
      const routerUrl = `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`;
      const routerRes = await fetch(routerUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!routerRes.ok)
        throw new Error(`GCP Compute API ${routerRes.status}: ${await routerRes.text()}`);
      const routerData = (await routerRes.json()) as Record<string, unknown>;
      const nats = routerData["nats"] as Array<Record<string, unknown>> | undefined;
      routerData["nats"] = (nats ?? []).filter((n) => String(n["name"]) !== natName);
      const patchRes = await fetch(routerUrl, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(routerData),
      });
      if (!patchRes.ok)
        throw new Error(`GCP Compute API ${patchRes.status}: ${await patchRes.text()}`);
      return;
    }

    if (typeId === "cloud-armor-policy") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine Cloud Armor policy name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "backend-service") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? resource.externalId ?? "");
      if (!name) throw new Error("Cannot determine backend service name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/backendServices/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "forwarding-rule") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? "");
      const region = String(resource.fields["region"] ?? "");
      if (!name) throw new Error("Cannot determine forwarding rule name for deletion");
      const url =
        region && region !== "global"
          ? `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/forwardingRules/${name}`
          : `https://compute.googleapis.com/compute/v1/projects/${p}/global/forwardingRules/${name}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "health-check") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? resource.externalId ?? "");
      if (!name) throw new Error("Cannot determine health check name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/healthChecks/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "ssl-certificate") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? resource.externalId ?? "");
      if (!name) throw new Error("Cannot determine SSL certificate name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/sslCertificates/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-dns-zone") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.externalId ?? resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine DNS zone name for deletion");
      const res = await fetch(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-dns-record-set") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // externalId is "{zoneName}/{type}:{recordName}"
      const extId = resource.externalId ?? "";
      const slashIdx = extId.indexOf("/");
      const zoneName = extId.slice(0, slashIdx);
      const rest = extId.slice(slashIdx + 1);
      const colonIdx = rest.indexOf(":");
      const rrType = rest.slice(0, colonIdx);
      const rrName = rest.slice(colonIdx + 1);
      if (!zoneName || !rrType || !rrName)
        throw new Error("Cannot determine zone, type, or name for DNS record set deletion");
      // Cloud DNS requires the trailing dot on the record name
      const fqdn = rrName.endsWith(".") ? rrName : `${rrName}.`;
      const res = await fetch(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${zoneName}/rrsets/${fqdn}/${rrType}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "bigquery-dataset") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // externalId is "{project}:{datasetId}"
      const extId = resource.externalId ?? "";
      const datasetId = extId.split(":").pop() ?? String(resource.fields["name"] ?? "");
      if (!datasetId) throw new Error("Cannot determine dataset ID for deletion");
      const res = await fetch(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}?deleteContents=true`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "bigquery-table") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // externalId is "{project}:{datasetId}/{tableId}"
      const extId = resource.externalId ?? "";
      const [projectPart, rest] = extId.split(":", 2);
      const [datasetId, tableId] = (rest ?? "").split("/");
      const proj = projectPart || p;
      if (!datasetId || !tableId) throw new Error("Cannot determine table ID for deletion");
      const res = await fetch(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${proj}/datasets/${datasetId}/tables/${tableId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "dataflow-job") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const jobId = String(resource.externalId ?? "");
      const region = String(resource.fields["region"] ?? "");
      if (!jobId) throw new Error("Cannot determine Dataflow job ID for cancellation");
      // Dataflow jobs are cancelled, not deleted
      const url = region
        ? `https://dataflow.googleapis.com/v1b3/projects/${p}/locations/${region}/jobs/${jobId}`
        : `https://dataflow.googleapis.com/v1b3/projects/${p}/jobs/${jobId}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestedState: "JOB_STATE_CANCELLED" }),
      });
      if (!res.ok) throw new Error(`Dataflow API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-build-trigger") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      // externalId is `<region>/<triggerId>` for resources produced by the
      // current lister/create handler. Pre-regional rows just stored
      // `<triggerId>` — fall back to the global endpoint for those.
      const externalId = String(resource.externalId ?? "");
      if (!externalId) throw new Error("Cannot determine Cloud Build trigger ID for deletion");
      const slashIdx = externalId.indexOf("/");
      const region = slashIdx > 0 ? externalId.slice(0, slashIdx) : "global";
      const triggerId = slashIdx > 0 ? externalId.slice(slashIdx + 1) : externalId;
      const url =
        region === "global"
          ? `https://cloudbuild.googleapis.com/v1/projects/${p}/triggers/${triggerId}`
          : `https://cloudbuild.googleapis.com/v1/projects/${p}/locations/${region}/triggers/${triggerId}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Cloud Build API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "cloud-deploy-pipeline") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      if (!fullName) throw new Error("Cannot determine Cloud Deploy pipeline name for deletion");
      const res = await fetch(`https://clouddeploy.googleapis.com/v1/${fullName}?force=true`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Cloud Deploy API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "composer-environment") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      if (!fullName) throw new Error("Cannot determine Composer environment name for deletion");
      const res = await fetch(`https://composer.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Composer API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "vertex-ai-endpoint") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      // fullName is like projects/p/locations/region/endpoints/id — extract region for regional endpoint
      const region = String(
        resource.fields["region"] ?? fullName.split("/locations/")[1]?.split("/")[0] ?? "",
      );
      if (!fullName || !region)
        throw new Error("Cannot determine Vertex AI endpoint name or region for deletion");
      const res = await fetch(`https://${region}-aiplatform.googleapis.com/v1/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Vertex AI API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "gcp-service-account") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const email = String(resource.externalId ?? resource.fields["email"] ?? "");
      if (!email) throw new Error("Cannot determine service account email for deletion");
      const res = await fetch(
        `https://iam.googleapis.com/v1/projects/${p}/serviceAccounts/${email}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`IAM API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "log-sink") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.externalId ?? resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine log sink name for deletion");
      const res = await fetch(`https://logging.googleapis.com/v2/projects/${p}/sinks/${name}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Logging API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "alert-policy") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const fullName = resource.externalId ?? "";
      if (!fullName) throw new Error("Cannot determine alert policy name for deletion");
      const res = await fetch(`https://monitoring.googleapis.com/v3/${fullName}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`Monitoring API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "instance-group") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = String(resource.fields["name"] ?? "");
      const zone = String(resource.fields["zone"] ?? "");
      const region = String(resource.fields["region"] ?? "");
      if (!name) throw new Error("Cannot determine instance group name for deletion");
      // Managed instance groups can be zonal or regional
      const url = zone
        ? `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroupManagers/${name}`
        : region
          ? `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/instanceGroupManagers/${name}`
          : (() => {
              throw new Error("Cannot determine zone or region for instance group deletion");
            })();
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    if (typeId === "kms-key") {
      // Cloud KMS doesn't delete keys — it only destroys their versions.
      // Schedule destruction of every version that isn't already destroyed.
      const resource = await this.getResource(typeId, resourceId, accountId);
      const keyName = resource.externalId ?? "";
      if (!keyName) throw new Error("Cannot determine KMS key name for deletion");
      const versions = await this.paginate<{ name?: string; state?: string }>(
        `https://cloudkms.googleapis.com/v1/${keyName}/cryptoKeyVersions`,
        "cryptoKeyVersions",
      );
      const active = versions.filter(
        (v) => v.state !== "DESTROYED" && v.state !== "DESTROY_SCHEDULED" && v.name,
      );
      if (active.length === 0) return;
      const results = await Promise.all(
        active.map((v) =>
          fetch(`https://cloudkms.googleapis.com/v1/${v.name}:destroy`, {
            method: "POST",
            headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
            body: "{}",
          }),
        ),
      );
      for (const res of results) {
        if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
      }
      return;
    }

    if (typeId === "kms-key-ring") {
      throw new Error(
        "Cloud KMS does not support deleting key rings. Key rings remain in the project indefinitely; you can only destroy the keys inside them.",
      );
    }

    if (typeId === "instance-template") {
      const resource = await this.getResource(typeId, resourceId, accountId);
      const name = resource.externalId ?? String(resource.fields["name"] ?? "");
      if (!name) throw new Error("Cannot determine instance template name for deletion");
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/global/instanceTemplates/${name}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }

    throw new Error(`GCP plugin: deleteResource not supported for type "${typeId}"`);
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
      const p = this.project;
      const zone = String(resource.fields["zone"] ?? "");
      const region = String(resource.fields["region"] ?? "");
      const groupName = String(resource.fields["name"] ?? "");
      if (!groupName || (!zone && !region)) {
        throw new Error("Cannot determine zone/region for instance group");
      }
      const managed = await this.listManagedInstances(resource);
      if (managed.length === 0) {
        throw new Error("No VMs in this instance group to restart/replace.");
      }
      const base = zone
        ? `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroupManagers/${groupName}`
        : `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/instanceGroupManagers/${groupName}`;
      const tok = await this.token();
      const res = await fetch(`${base}/applyUpdatesToInstances`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: managed.map((m) => `zones/${m.zone}/instances/${m.name}`),
          minimalAction: "RESTART",
          mostDisruptiveAllowedAction: "REPLACE",
        }),
      });
      if (!res.ok) {
        throw new Error(await formatGcpError("Restart/replace VMs", res));
      }
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
    // Existing attachment path: disk to VM (handled by current code path)
    if (sourceTypeId === "gce-disk" && targetTypeId === "gce-instance") {
      const p = this.project;
      const tok = await this.token();
      const [disk, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const diskZone = String(disk.fields["zone"] ?? "");
      const instanceZone = String(instance.fields["zone"] ?? "");
      if (!diskZone || !instanceZone) {
        throw new Error("Cannot determine zone for disk or instance");
      }
      if (diskZone !== instanceZone) {
        throw new Error(
          `Disk zone ${diskZone} does not match instance zone ${instanceZone} — persistent disks must be in the same zone as the instance.`,
        );
      }
      const diskName = String(disk.fields["name"] ?? "");
      const instanceName = String(instance.fields["name"] ?? "");
      if (!diskName || !instanceName) {
        throw new Error("Cannot determine disk or instance name");
      }
      const diskSelfLink = `https://www.googleapis.com/compute/v1/projects/${p}/zones/${diskZone}/disks/${diskName}`;
      const res = await fetch(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}/attachDisk`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ source: diskSelfLink, deviceName: diskName }),
        },
      );
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }
    if (sourceTypeId === "static-ip" && targetTypeId === "gce-instance") {
      const p = this.project;
      const tok = await this.token();
      const [ipResource, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const ipAddress = String(
        ipResource.fields["address"] ?? ipResource.resolvedOutputs["address"] ?? "",
      );
      const ipVal = ipAddress?.toString?.() ?? "";
      const instanceZone = String(instance.fields["zone"] ?? "");
      const instanceName = String(instance.fields["name"] ?? "");
      if (!ipVal || !instanceZone || !instanceName) {
        throw new Error("Cannot determine IP address or VM for attachment");
      }
      // Attach static IP to the VM's NIC using addAccessConfig (nic0)
      const url = `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}/addAccessConfig`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          networkInterface: "nic0",
          type: "ONE_TO_ONE_NAT",
          natIP: ipVal,
          // name can be optional; provide a stable name if needed
          // name: "External NAT",
        }),
      });
      if (!res.ok) {
        throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      }
      return;
    }
    if (sourceTypeId === "firewall-rule" && targetTypeId === "gce-instance") {
      const [firewall, instance] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      await this.applyFirewallToInstance(firewall, instance);
      return;
    }
    if (sourceTypeId === "cloud-nat" && targetTypeId === "subnet") {
      const p = this.project;
      const tok = await this.token();
      const [nat, subnet] = await Promise.all([
        this.getResource(sourceTypeId, sourceResourceId, accountId),
        this.getResource(targetTypeId, targetResourceId, accountId),
      ]);
      const region = String(nat.fields["region"] ?? "");
      const routerName = String(nat.fields["router"] ?? "");
      const natName = String(nat.fields["name"] ?? "");
      const subnetRegion = String(subnet.fields["region"] ?? "");
      const subnetName = String(subnet.fields["name"] ?? "");
      if (!region || !routerName || !natName || !subnetName) {
        throw new Error("Cannot determine NAT or subnet identifiers");
      }
      if (region !== subnetRegion) {
        throw new Error(
          `NAT region ${region} does not match subnet region ${subnetRegion} — Cloud NAT only applies to subnets in its own region.`,
        );
      }
      const subnetSelfLink = `https://www.googleapis.com/compute/v1/projects/${p}/regions/${subnetRegion}/subnetworks/${subnetName}`;

      const routerUrl = `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`;
      const router = await this.get<Record<string, unknown>>(routerUrl);
      const nats = (router["nats"] as Array<Record<string, unknown>> | undefined) ?? [];
      const idx = nats.findIndex((n) => String(n["name"]) === natName);
      if (idx < 0) throw new Error(`Cloud NAT "${natName}" not found on router "${routerName}"`);
      const target = nats[idx]!;
      const existing = (target["subnetworks"] as Array<Record<string, unknown>> | undefined) ?? [];
      if (existing.some((s) => String(s["name"]) === subnetSelfLink)) {
        // Already attached — nothing to do.
        return;
      }
      target["sourceSubnetworkIpRangesToNat"] = "LIST_OF_SUBNETWORKS";
      target["subnetworks"] = [
        ...existing,
        { name: subnetSelfLink, sourceIpRangesToNat: ["ALL_IP_RANGES"] },
      ];
      nats[idx] = target;

      const res = await fetch(routerUrl, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ nats }),
      });
      if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
      return;
    }
    throw new Error(
      `GCP plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
    );
  }

  /**
   * Apply a GCP firewall rule to a GCE instance. GCP firewalls use
   * `targetTags` to select VMs — there's no direct attach. We fetch the
   * firewall's target tags, add them to the instance's tag list, and call
   * the instance's `setTags` API. If the firewall has no targetTags (applies
   * to all VMs in the network), nothing to do.
   */
  private async applyFirewallToInstance(
    firewall: ResourceInstance,
    instance: ResourceInstance,
  ): Promise<void> {
    const p = this.project;
    const tok = await this.token();
    const firewallName = firewall.externalId ?? String(firewall.fields["name"] ?? "");
    const instanceZone = String(instance.fields["zone"] ?? "");
    const instanceName = String(instance.fields["name"] ?? instance.displayName);
    if (!firewallName) throw new Error("Cannot determine firewall name");
    if (!instanceZone || !instanceName) {
      throw new Error("Cannot determine instance zone or name");
    }
    // Fetch the firewall to read its targetTags.
    const fw = await this.get<{ targetTags?: string[] }>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls/${firewallName}`,
    );
    const targetTags = fw.targetTags ?? [];
    if (targetTags.length === 0) {
      throw new Error(
        `Firewall "${firewallName}" has no target tags — it already applies to all VMs in its network. No changes needed.`,
      );
    }
    // Fetch the instance to read its current tags (with fingerprint) and tag list.
    const inst = await this.get<{ tags?: { fingerprint?: string; items?: string[] } }>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}`,
    );
    const currentTags = inst.tags?.items ?? [];
    const merged = Array.from(new Set([...currentTags, ...targetTags]));
    if (merged.length === currentTags.length) return; // all tags already present
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${instanceZone}/instances/${instanceName}/setTags`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fingerprint: inst.tags?.fingerprint ?? "",
          items: merged,
        }),
      },
    );
    if (!res.ok) throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
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

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;
    const ro = resource.resolvedOutputs ?? {};

    switch (resourceTypeId) {
      case "gce-instance": {
        const status = String(f.status ?? "unknown");
        const stats: DashboardStat[] = [
          {
            label: "Status",
            value: status,
            variant:
              status === "RUNNING"
                ? "status-healthy"
                : status === "TERMINATED"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Machine Type", value: String(f.machineType ?? "") },
          { label: "Zone", value: String(f.zone ?? "") },
        ];
        if (ro.publicIp) stats.push({ label: "Public IP", value: String(ro.publicIp) });
        return stats;
      }
      case "cloud-sql-instance": {
        const state = String(f.state ?? "unknown");
        return [
          {
            label: "State",
            value: state,
            variant:
              state === "RUNNABLE"
                ? "status-healthy"
                : state === "STOPPED"
                  ? "status-error"
                  : "status-degraded",
          },
          { label: "Engine", value: String(f.databaseVersion ?? "") },
          { label: "Tier", value: String(f.tier ?? "") },
          { label: "Region", value: String(f.region ?? "") },
        ];
      }
      case "cloud-run-service": {
        const stats: DashboardStat[] = [{ label: "Region", value: String(f.region ?? "") }];
        if (f.url) stats.push({ label: "URL", value: String(f.url) });
        return stats;
      }
      case "gke-cluster": {
        const status = String(f.status ?? "unknown");
        return [
          {
            label: "Status",
            value: status,
            variant: status === "RUNNING" ? "status-healthy" : "status-degraded",
          },
          { label: "Location", value: String(f.location ?? "") },
          { label: "Nodes", value: String(f.nodeCount ?? 0) },
        ];
      }
      default: {
        // Generic fallback — show key fields from the resource
        const stats: DashboardStat[] = [];
        const statusVal = f.status ?? f.state ?? f.phase;
        if (statusVal != null) {
          const s = String(statusVal).toLowerCase();
          stats.push({
            label: "Status",
            value: String(statusVal),
            variant: [
              "running",
              "active",
              "available",
              "ready",
              "enabled",
              "healthy",
              "succeeded",
              "runnable",
            ].some((v) => s.includes(v))
              ? "status-healthy"
              : ["error", "failed", "terminated", "deleted", "unhealthy"].some((v) => s.includes(v))
                ? "status-error"
                : ["pending", "creating", "updating", "stopping", "degraded", "warning"].some((v) =>
                      s.includes(v),
                    )
                  ? "status-degraded"
                  : "default",
          });
        }
        const typeVal =
          f.type ??
          f.kind ??
          f.engine ??
          f.instanceType ??
          f.tier ??
          f.machineType ??
          f.size ??
          f.databaseVersion;
        if (typeVal != null) stats.push({ label: "Type", value: String(typeVal) });
        const regionVal = f.region ?? f.location ?? f.zone;
        if (regionVal != null) stats.push({ label: "Region", value: String(regionVal) });
        return stats;
      }
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const now = Date.now();
    const startTime = new Date(timeRange?.startMs ?? now - 3_600_000).toISOString();
    const endTime = new Date(timeRange?.endMs ?? now).toISOString();

    interface GcpTimeSeriesPoint {
      interval: { startTime: string; endTime: string };
      value: { doubleValue?: number; int64Value?: string };
    }
    interface GcpTimeSeries {
      points: GcpTimeSeriesPoint[];
    }
    interface GcpTimeSeriesResponse {
      timeSeries?: GcpTimeSeries[];
    }

    const fetchSeries = async (
      metricType: string,
      resourceLabel: string,
      resourceValue: string,
      label: string,
      unit: string,
    ): Promise<MetricSeries | null> => {
      try {
        const baseUrl = `https://monitoring.googleapis.com/v3/projects/${this.project}/timeSeries`;
        const url = new URL(baseUrl);
        url.searchParams.set(
          "filter",
          `metric.type="${metricType}" AND resource.labels.${resourceLabel}="${resourceValue}"`,
        );
        url.searchParams.set("interval.startTime", startTime);
        url.searchParams.set("interval.endTime", endTime);
        url.searchParams.set("aggregation.alignmentPeriod", "60s");
        url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_MEAN");

        const resp = await this.get<GcpTimeSeriesResponse>(url.toString());
        const points = resp.timeSeries?.[0]?.points ?? [];
        if (points.length === 0) return null;
        return {
          label,
          unit,
          points: points.map((p) => ({
            timestamp: new Date(p.interval.endTime).getTime(),
            value: p.value.doubleValue ?? Number(p.value.int64Value ?? 0),
          })),
        };
      } catch {
        return null;
      }
    };

    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const results: MetricSeries[] = [];

    switch (resourceTypeId) {
      case "gce-instance": {
        // GCE monitoring uses the numeric instance_id resource label
        const numericId = String(resource.fields["numericId"] ?? "");
        if (!numericId) break;
        const series = await Promise.all([
          fetchSeries(
            "compute.googleapis.com/instance/cpu/utilization",
            "instance_id",
            numericId,
            "CPU Utilization",
            "%",
          ),
          fetchSeries(
            "compute.googleapis.com/instance/network/received_bytes_count",
            "instance_id",
            numericId,
            "Network Received",
            "bytes",
          ),
        ]);
        for (const s of series) {
          if (s) results.push(s);
        }
        break;
      }
      case "cloud-run-service":
      case "cloud-function": {
        // Cloud Function gen2 is a Cloud Run service under the hood — same
        // metric types, same `service_name` resource label.
        const serviceName = String(resource.fields["name"] ?? "");
        if (!serviceName) break;
        const series = await Promise.all([
          fetchSeries(
            "run.googleapis.com/request_count",
            "service_name",
            serviceName,
            "Request Count",
            "requests",
          ),
          fetchSeries(
            "run.googleapis.com/request_latencies",
            "service_name",
            serviceName,
            "Request Latency (p95)",
            "ms",
          ),
          fetchSeries(
            "run.googleapis.com/container/instance_count",
            "service_name",
            serviceName,
            "Container Instances",
            "instances",
          ),
          fetchSeries(
            "run.googleapis.com/container/billable_instance_time",
            "service_name",
            serviceName,
            "Billable Instance Time",
            "instance-seconds",
          ),
        ]);
        for (const s of series) {
          if (s) results.push(s);
        }
        break;
      }
      case "cloud-tasks-queue": {
        const queueName = String(resource.fields["name"] ?? "");
        if (!queueName) break;
        const series = await Promise.all([
          fetchSeries(
            "cloudtasks.googleapis.com/queue/dispatch_count",
            "queue_id",
            queueName,
            "Dispatch Count",
            "tasks",
          ),
          fetchSeries(
            "cloudtasks.googleapis.com/queue/depth",
            "queue_id",
            queueName,
            "Queue Depth",
            "tasks",
          ),
          fetchSeries(
            "cloudtasks.googleapis.com/queue/task_attempt_count",
            "queue_id",
            queueName,
            "Task Attempts",
            "attempts",
          ),
        ]);
        for (const s of series) {
          if (s) results.push(s);
        }
        break;
      }
      case "cloud-nat": {
        // NAT metrics live on the nat_gateway monitored resource type, keyed
        // by gateway_name (the NAT's name). Allocation level is the headline
        // metric — the rest contextualise traffic and drops.
        const natName = String(resource.fields["name"] ?? "");
        if (!natName) break;
        const series = await Promise.all([
          fetchSeries(
            "router.googleapis.com/nat/port_usage",
            "gateway_name",
            natName,
            "Allocation level",
            "ports",
          ),
          fetchSeries(
            "router.googleapis.com/nat/sent_packets_count",
            "gateway_name",
            natName,
            "Sent packets",
            "packets",
          ),
          fetchSeries(
            "router.googleapis.com/nat/dropped_sent_packets_count",
            "gateway_name",
            natName,
            "Dropped sent packets",
            "packets",
          ),
          fetchSeries(
            "router.googleapis.com/nat/new_connections_count",
            "gateway_name",
            natName,
            "New connections",
            "connections",
          ),
        ]);
        for (const s of series) {
          if (s) results.push(s);
        }
        break;
      }
    }

    return results;
  }

  /**
   * Fetch recent log entries for resources that declare a `logs` capability.
   * Currently supports Cloud Tasks queues — queries Cloud Logging with a filter
   * scoped to the queue's resource type. Logs are returned newest-last (so
   * append-style follow rendering puts new lines at the bottom).
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (
      typeId !== "cloud-tasks-queue" &&
      typeId !== "cloud-run-service" &&
      typeId !== "cloud-function" &&
      typeId !== "cloud-armor-policy"
    ) {
      throw new Error(`GCP plugin: getLogs is not supported for ${typeId}`);
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const name = String(resource.fields["name"] ?? "");
    const region = String(resource.fields["region"] ?? "");
    if (!name) throw new Error(`${typeId} is missing a name`);

    // Cloud Function gen2 logs are written by the underlying Cloud Run service
    // under resource.type="cloud_run_revision" with the same service name.
    // Cloud Armor logs land on the load balancer that the policy is attached
    // to — request logs whose enforcedSecurityPolicy.name matches.
    const filter =
      typeId === "cloud-run-service" || typeId === "cloud-function"
        ? [
            `resource.type="cloud_run_revision"`,
            `resource.labels.service_name="${name}"`,
            ...(region ? [`resource.labels.location="${region}"`] : []),
          ].join(" AND ")
        : typeId === "cloud-armor-policy"
          ? [
              `(resource.type="http_load_balancer" OR resource.type="tcp_ssl_proxy_rule" OR resource.type="l4_proxy_rule")`,
              `jsonPayload.enforcedSecurityPolicy.name="${name}"`,
            ].join(" AND ")
          : [
              `resource.type="cloud_tasks_queue"`,
              `resource.labels.queue_id="${name}"`,
              ...(region
                ? [`resource.labels.target_type=*`, `resource.labels.location="${region}"`]
                : []),
            ].join(" AND ");

    const tok = await this.token();
    const tail = Math.max(1, Math.min(params.tailLines ?? 200, 1000));
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceNames: [`projects/${this.project}`],
        filter,
        orderBy: "timestamp desc",
        pageSize: tail,
      }),
    });
    if (!res.ok) {
      throw new Error(`Cloud Logging API ${res.status}: ${await res.text()}`);
    }
    interface LogEntry {
      timestamp?: string;
      severity?: string;
      textPayload?: string;
      jsonPayload?: Record<string, unknown>;
      protoPayload?: Record<string, unknown>;
    }
    const data = (await res.json()) as { entries?: LogEntry[] };
    const entries = data.entries ?? [];
    const lines = entries
      .reverse()
      .map((e) => {
        const ts = e.timestamp ?? "";
        const sev = e.severity ?? "DEFAULT";
        const payload =
          e.textPayload ??
          (e.jsonPayload ? JSON.stringify(e.jsonPayload) : "") ??
          (e.protoPayload ? JSON.stringify(e.protoPayload) : "") ??
          "";
        return `${ts} [${sev}] ${payload}`;
      })
      .join("\n");
    const containerLabel =
      typeId === "cloud-run-service" || typeId === "cloud-function"
        ? "service"
        : typeId === "cloud-armor-policy"
          ? "policy"
          : "queue";
    return {
      text: lines || "No log entries in the selected window.",
      containers: [containerLabel],
      activeContainer: containerLabel,
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return gcpRenderDetail(this.detailCtx, resource);
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
    const externalId = resourceId.split(":").slice(2).join(":");
    const colonIdx = externalId.indexOf(":");
    const project = externalId.slice(0, colonIdx);
    const datasetId = externalId.slice(colonIdx + 1);
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
    const tok = await this.token();
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (onProgress) {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        });
      }
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
      });
      xhr.addEventListener("error", () => reject(new Error("Upload network error")));
      xhr.send(file);
    });
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    const tok = await this.token();

    if (key.endsWith("/")) {
      // Folder — list all objects with this prefix (flat, no delimiter) and delete each
      const allKeys: string[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        );
        url.searchParams.set("prefix", key);
        url.searchParams.set("maxResults", "1000");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await this.get<{ items?: Array<{ name: string }>; nextPageToken?: string }>(
          url.toString(),
        );
        for (const item of page.items ?? []) allKeys.push(item.name);
        pageToken = page.nextPageToken;
      } while (pageToken);

      await Promise.all(
        allKeys.map((k) =>
          fetch(
            `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(k)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
          ),
        ),
      );
      return;
    }

    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Delete failed: ${res.status}`);
    }
  }

  async makeStorageFolder(bucket: string, key: string): Promise<void> {
    const tok = await this.token();
    const folderKey = key.endsWith("/") ? key : `${key}/`;
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(folderKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tok}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!res.ok) throw new Error(`Make folder failed: ${res.status}`);
  }

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const url = new URL(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
    );
    url.searchParams.set("delimiter", "/");
    url.searchParams.set("maxResults", "1000");
    if (prefix) url.searchParams.set("prefix", prefix);

    const results: StorageObject[] = [];
    let pageToken: string | undefined;

    do {
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.get<{
        items?: Array<{ name: string; size: string; updated: string; contentType?: string }>;
        prefixes?: string[];
        nextPageToken?: string;
      }>(url.toString());

      // Directories (common prefixes)
      for (const p of page.prefixes ?? []) {
        const name = p.slice(prefix.length).replace(/\/$/, "");
        results.push({ key: p, name, size: 0, lastModified: "", isDirectory: true });
      }

      // Objects
      for (const obj of page.items ?? []) {
        if (obj.name === prefix) continue; // skip the "folder" placeholder object
        const name = obj.name.slice(prefix.length);
        results.push({
          key: obj.name,
          name,
          size: Number(obj.size ?? 0),
          lastModified: obj.updated ?? "",
          isDirectory: false,
          ...(obj.contentType ? { contentType: obj.contentType } : {}),
        });
      }

      pageToken = page.nextPageToken;
    } while (pageToken);

    return results;
  }

  async listArtifacts(
    typeId: string,
    resourceId: string,
    accountId: string,
    params?: { pageToken?: string; prefix?: string },
  ): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
    if (typeId !== "artifact-registry-repo") {
      throw new Error(`listArtifacts not supported for type ${typeId}`);
    }
    // Parse resourceId ("accountId:typeId:projects/.../repositories/...") directly —
    // we can't go through getResource() because the repository lister uses the
    // `locations/-` wildcard which Artifact Registry rejects.
    const marker = `${accountId}:${typeId}:`;
    const parent = resourceId.startsWith(marker) ? resourceId.slice(marker.length) : resourceId;
    if (!parent.startsWith("projects/")) {
      throw new Error(`Invalid artifact-registry-repo resource id: ${resourceId}`);
    }
    const repoInfo = await this.get<{ format?: string }>(
      `https://artifactregistry.googleapis.com/v1/${parent}`,
    );
    const format = String(repoInfo.format ?? "").toUpperCase();

    if (format === "DOCKER") {
      const url = new URL(`https://artifactregistry.googleapis.com/v1/${parent}/dockerImages`);
      url.searchParams.set("pageSize", "50");
      if (params?.pageToken) url.searchParams.set("pageToken", params.pageToken);
      const page = await this.get<{
        dockerImages?: Array<{
          name: string;
          tags?: string[];
          uri?: string;
          imageSizeBytes?: string;
          uploadTime?: string;
          mediaType?: string;
          buildTime?: string;
          updateTime?: string;
        }>;
        nextPageToken?: string;
      }>(url.toString());
      const items: ArtifactEntry[] = (page.dockerImages ?? []).map((img) => {
        // name looks like projects/p/locations/l/repositories/r/dockerImages/name@sha256:digest
        const resourceName = img.name;
        const atIdx = resourceName.lastIndexOf("@");
        const baseName = atIdx >= 0 ? resourceName.slice(0, atIdx) : resourceName;
        const shortName = baseName.split("/dockerImages/").pop() ?? baseName;
        const digest = atIdx >= 0 ? resourceName.slice(atIdx + 1) : undefined;
        const entry: ArtifactEntry = {
          name: decodeURIComponent(shortName),
        };
        if (img.tags && img.tags.length > 0 && img.tags[0]) {
          entry.tags = img.tags;
          entry.version = img.tags[0];
        }
        if (digest) entry.digest = digest;
        if (img.imageSizeBytes) entry.sizeBytes = Number(img.imageSizeBytes);
        const ts = img.updateTime ?? img.uploadTime ?? img.buildTime;
        if (ts) entry.updatedAt = ts;
        if (img.mediaType) entry.mediaType = img.mediaType;
        return entry;
      });
      const prefix = params?.prefix?.trim();
      const filtered = prefix ? items.filter((i) => i.name.includes(prefix)) : items;
      const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items: filtered };
      if (page.nextPageToken) result.nextPageToken = page.nextPageToken;
      return result;
    }

    // Non-Docker formats: list packages, show latest version per package.
    const url = new URL(`https://artifactregistry.googleapis.com/v1/${parent}/packages`);
    url.searchParams.set("pageSize", "50");
    if (params?.pageToken) url.searchParams.set("pageToken", params.pageToken);
    const page = await this.get<{
      packages?: Array<{ name: string; displayName?: string; updateTime?: string }>;
      nextPageToken?: string;
    }>(url.toString());
    const items: ArtifactEntry[] = (page.packages ?? []).map((pkg) => {
      const shortName = pkg.name.split("/packages/").pop() ?? pkg.name;
      const entry: ArtifactEntry = {
        name: decodeURIComponent(pkg.displayName ?? shortName),
      };
      if (pkg.updateTime) entry.updatedAt = pkg.updateTime;
      return entry;
    });
    const prefix = params?.prefix?.trim();
    const filtered = prefix ? items.filter((i) => i.name.includes(prefix)) : items;
    const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items: filtered };
    if (page.nextPageToken) result.nextPageToken = page.nextPageToken;
    return result;
  }

  async listSecretVersions(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<SecretVersion[]> {
    if (typeId === "kms-key") {
      const resource = await this.getResource("kms-key", resourceId, accountId);
      const keyName = resource.externalId ?? "";
      const [versions, key] = await Promise.all([
        this.paginate<Record<string, unknown>>(
          `https://cloudkms.googleapis.com/v1/${keyName}/cryptoKeyVersions`,
          "cryptoKeyVersions",
        ),
        this.get<Record<string, unknown>>(`https://cloudkms.googleapis.com/v1/${keyName}`),
      ]);
      const primary = key["primary"] as Record<string, unknown> | undefined;
      const primaryId = String(primary?.["name"] ?? "")
        .split("/")
        .pop();
      return versions.map((v) => mapKmsKeyVersion(v, primaryId));
    }
    const resource = await this.getResource("secret-manager-secret", resourceId, accountId);
    const secretName = resource.externalId ?? "";
    const items = await this.paginate<Record<string, unknown>>(
      `https://secretmanager.googleapis.com/v1/${secretName}/versions`,
      "versions",
    );
    return items.map((v) => mapSecretVersion(v));
  }

  async accessSecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
  ): Promise<string> {
    if (typeId === "kms-key") {
      // KMS symmetric key material never leaves Google. Asymmetric public keys
      // are retrievable via gcloud; we don't surface a reveal action in the UI
      // (secretVersions.supportsReveal = false), so this path is only hit by a
      // direct API caller.
      throw new Error("KMS key material cannot be revealed.");
    }
    const resource = await this.getResource("secret-manager-secret", resourceId, accountId);
    const secretName = resource.externalId ?? "";
    const data = await this.get<Record<string, unknown>>(
      `https://secretmanager.googleapis.com/v1/${secretName}/versions/${encodeURIComponent(versionId)}:access`,
    );
    const payload = data["payload"] as Record<string, unknown> | undefined;
    const b64 = (payload?.["data"] as string) ?? "";
    try {
      return decodeURIComponent(escape(atob(b64)));
    } catch {
      return atob(b64);
    }
  }

  async addSecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    value: string,
  ): Promise<SecretVersion> {
    const tok = await this.token();
    if (typeId === "kms-key") {
      // KMS generates new material server-side — the `value` argument is ignored.
      const resource = await this.getResource("kms-key", resourceId, accountId);
      const keyName = resource.externalId ?? "";
      const res = await fetch(`https://cloudkms.googleapis.com/v1/${keyName}/cryptoKeyVersions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as Record<string, unknown>;
      return mapKmsKeyVersion(data);
    }
    const resource = await this.getResource("secret-manager-secret", resourceId, accountId);
    const secretName = resource.externalId ?? "";
    const res = await fetch(`https://secretmanager.googleapis.com/v1/${secretName}:addVersion`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: { data: btoa(unescape(encodeURIComponent(value))) },
      }),
    });
    if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    return mapSecretVersion(data);
  }

  async modifySecretVersion(
    typeId: string,
    resourceId: string,
    accountId: string,
    versionId: string,
    action: SecretVersionMutation,
  ): Promise<SecretVersion> {
    const tok = await this.token();
    if (typeId === "kms-key") {
      const resource = await this.getResource("kms-key", resourceId, accountId);
      const keyName = resource.externalId ?? "";
      const versionName = `${keyName}/cryptoKeyVersions/${encodeURIComponent(versionId)}`;
      const url =
        action === "destroy"
          ? `https://cloudkms.googleapis.com/v1/${versionName}:destroy`
          : `https://cloudkms.googleapis.com/v1/${versionName}?updateMask=state`;
      const body =
        action === "destroy"
          ? "{}"
          : JSON.stringify({ state: action === "enable" ? "ENABLED" : "DISABLED" });
      const res = await fetch(url, {
        method: action === "destroy" ? "POST" : "PATCH",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as Record<string, unknown>;
      return mapKmsKeyVersion(data);
    }
    const resource = await this.getResource("secret-manager-secret", resourceId, accountId);
    const secretName = resource.externalId ?? "";
    const verb = action === "enable" ? "enable" : action === "disable" ? "disable" : "destroy";
    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/${secretName}/versions/${encodeURIComponent(versionId)}:${verb}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    return mapSecretVersion(data);
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
