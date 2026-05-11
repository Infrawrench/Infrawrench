import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudRunContext, CloudRunFullServiceResult } from "./cloud-run-handlers.js";
import type {
  CloudRunRevisionSummary,
  CloudRunTriggerSummary,
  CloudRunIamInfo,
  CloudRunDomainMappingsResult,
} from "./cloud-run-handlers.js";
import {
  fetchCloudRunServiceFull,
  listCloudRunRevisions,
  listEventarcTriggersForService,
  fetchCloudRunIamBindings,
  listCloudRunDomainMappings,
} from "./cloud-run-handlers.js";
import type { CloudArmorContext } from "./cloud-armor-handlers.js";
import { fetchCloudArmorPolicyFull, listCloudArmorTargets } from "./cloud-armor-handlers.js";
import type { FirestoreContext } from "./firestore-handlers.js";
import {
  listFirestoreCollections,
  listFirestoreIndexes,
  listFirestoreBackupSchedules,
  listFirestoreTtlConfigs,
  listFirestoreOperations,
  fetchFirestoreRules,
  listFirestoreBackups,
  fetchFirestoreDatabaseExtras,
  fetchFirestoreUsageMetrics,
  fetchFirestoreIamBindings,
} from "./firestore-handlers.js";
import type {
  FirestoreIndexSummary,
  FirestoreBackupSchedule,
  FirestoreTtlConfig,
  FirestoreOperation,
  FirestoreRulesInfo,
  FirestoreBackupInfo,
  FirestoreDatabaseExtras,
  FirestoreIamInfo,
} from "./firestore-handlers.js";
import {
  listManagedInstances,
  listCloudTasksQueueTasks,
  fetchCloudRouterFull,
  listCloudRouterRoutePolicies,
  fetchCloudNatRouter,
  fetchCloudNatRouterStatus,
} from "./compute-extras-client.js";
import type { GcpClientContext } from "./shared.js";

/**
 * Resource detail enrichment — augments a `ResourceInstance` with the
 * service-specific sub-data the detail view needs (Cloud Run revisions,
 * Cloud Tasks tasks, Firestore indexes/rules, etc.). Branches by
 * `resourceTypeId`; resources that need no extra data fall through.
 */
export async function enrichDetail(
  ctx: GcpClientContext,
  cloudRunCtx: CloudRunContext,
  cloudArmorCtx: CloudArmorContext,
  firestoreCtx: FirestoreContext,
  resource: ResourceInstance,
): Promise<ResourceInstance> {
  if (resource.resourceTypeId === "instance-group") {
    const managed = await listManagedInstances(ctx, resource).catch(() => []);
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
      fetchCloudRunServiceFull(cloudRunCtx, resource).catch(
        (e) =>
          ({
            service: null,
            error: e instanceof Error ? e.message : String(e),
          }) as CloudRunFullServiceResult,
      ),
      listCloudRunRevisions(cloudRunCtx, resource).catch((e) => {
        console.warn("[cloud-run] listRevisions failed:", e);
        return [] as CloudRunRevisionSummary[];
      }),
      listEventarcTriggersForService(cloudRunCtx, resource).catch((e) => {
        console.warn("[cloud-run] listEventarcTriggers failed:", e);
        return [] as CloudRunTriggerSummary[];
      }),
      fetchCloudRunIamBindings(cloudRunCtx, resource).catch(
        (e) =>
          ({
            bindings: [],
            etag: "",
            error: e instanceof Error ? e.message : String(e),
          }) as CloudRunIamInfo,
      ),
      listCloudRunDomainMappings(cloudRunCtx, resource).catch(
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
      fetchCloudRunServiceFull(cloudRunCtx, runProxy).catch(
        (e) =>
          ({
            service: null,
            error: e instanceof Error ? e.message : String(e),
          }) as CloudRunFullServiceResult,
      ),
      listCloudRunRevisions(cloudRunCtx, runProxy).catch((e) => {
        console.warn("[cloud-function] listRevisions failed:", e);
        return [] as CloudRunRevisionSummary[];
      }),
      listEventarcTriggersForService(cloudRunCtx, runProxy).catch((e) => {
        console.warn("[cloud-function] listEventarcTriggers failed:", e);
        return [] as CloudRunTriggerSummary[];
      }),
      fetchCloudRunIamBindings(cloudRunCtx, runProxy).catch(
        (e) =>
          ({
            bindings: [],
            etag: "",
            error: e instanceof Error ? e.message : String(e),
          }) as CloudRunIamInfo,
      ),
      listCloudRunDomainMappings(cloudRunCtx, runProxy).catch(
        (e) =>
          ({
            mappings: [],
            error: e instanceof Error ? e.message : String(e),
          }) as CloudRunDomainMappingsResult,
      ),
    ]);
    const svc = fullService.service ?? null;
    const template = (svc?.["template"] as Record<string, unknown> | undefined) ?? {};
    const containers = (template["containers"] as Array<Record<string, unknown>> | undefined) ?? [];
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
    const tasks = await listCloudTasksQueueTasks(ctx, resource).catch((e) => {
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
      fetchCloudRouterFull(ctx, resource).catch((e) => {
        console.warn("[cloud-router] fetchFull failed:", e);
        return { error: e instanceof Error ? e.message : String(e) };
      }),
      listCloudRouterRoutePolicies(ctx, resource).catch((e) => {
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
      fetchCloudNatRouter(ctx, resource).catch((e) => {
        console.warn("[cloud-nat] fetchRouter failed:", e);
        return { error: e instanceof Error ? e.message : String(e) };
      }),
      fetchCloudNatRouterStatus(ctx, resource).catch((e) => {
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
        listFirestoreCollections(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] listCollections failed:", e);
          return [] as string[];
        }),
        listFirestoreIndexes(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] listIndexes failed:", e);
          indexesError = e instanceof Error ? e.message : String(e);
          return [] as FirestoreIndexSummary[];
        }),
        listFirestoreBackupSchedules(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] listBackupSchedules failed:", e);
          return [] as FirestoreBackupSchedule[];
        }),
        listFirestoreTtlConfigs(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] listTtlConfigs failed:", e);
          return [] as FirestoreTtlConfig[];
        }),
        listFirestoreOperations(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] listOperations failed:", e);
          return [] as FirestoreOperation[];
        }),
        fetchFirestoreRules(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] fetchRules failed:", e);
          return {
            rulesetName: "",
            content: "",
            updateTime: "",
            error: e instanceof Error ? e.message : String(e),
          } as FirestoreRulesInfo;
        }),
        listFirestoreBackups(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] listBackups failed:", e);
          return [] as FirestoreBackupInfo[];
        }),
        fetchFirestoreDatabaseExtras(firestoreCtx, resource).catch((e) => {
          console.warn("[firestore] fetchDatabaseExtras failed:", e);
          return {
            earliestVersionTime: "",
            versionRetentionPeriod: "",
            pointInTimeRecoveryEnablement: "",
          } as FirestoreDatabaseExtras;
        }),
        fetchFirestoreUsageMetrics(firestoreCtx, resource).catch((e) => ({
          reads24h: 0,
          writes24h: 0,
          deletes24h: 0,
          storageBytes: 0,
          available: false,
          error: e instanceof Error ? e.message : String(e),
        })),
        fetchFirestoreIamBindings(firestoreCtx).catch(
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
      fetchCloudArmorPolicyFull(cloudArmorCtx, resource).catch((e) => ({
        rules: [],
        fingerprint: "",
        error: e instanceof Error ? e.message : String(e),
      })),
      listCloudArmorTargets(cloudArmorCtx, resource).catch((e) => ({
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
