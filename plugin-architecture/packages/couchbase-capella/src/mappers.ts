import type { ResourceInstance } from "@infrawrench/plugin-base";
import { joinId } from "./api.js";
import { T } from "./resource-types.js";
import type {
  Audit,
  CpApiKey,
  CpAppService,
  CpBackup,
  CpBucket,
  CpCidr,
  CpCluster,
  CpCredential,
  CpProject,
  CpUser,
} from "./types.js";

type Fields = Record<string, string | number | boolean>;

export function compact(
  fields: Record<string, string | number | boolean | null | undefined>,
): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Fields,
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: "couchbase-capella",
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

const auditFields = (a?: Audit) => ({ createdAt: a?.createdAt, createdBy: a?.createdBy });

/** A free-tier cluster lives under `/clusters/freeTier/{id}`; its support plan says so. */
export function isFreeTier(c: CpCluster): boolean {
  return (c.support?.plan ?? "").toLowerCase() === "free";
}

export function mapProject(accountId: string, p: CpProject): ResourceInstance {
  return instance(
    accountId,
    T.project,
    p.id,
    p.name ?? p.id,
    compact({ name: p.name, description: p.description, projectId: p.id, ...auditFields(p.audit) }),
  );
}

export function mapCluster(
  accountId: string,
  projectId: string,
  c: CpCluster,
  stats?: { freeMemoryInMb?: number; totalMemoryInMb?: number },
): ResourceInstance {
  const groups = c.serviceGroups ?? [];
  const first = groups.find((g) => g.services?.includes("data")) ?? groups[0];
  const totalNodes = groups.reduce((n, g) => n + (g.numOfNodes ?? 0), 0);
  const cpu = first?.node?.compute?.cpu;
  const ram = first?.node?.compute?.ram;
  return instance(
    accountId,
    T.cluster,
    joinId(projectId, c.id),
    c.name ?? c.id,
    compact({
      name: c.name,
      description: c.description,
      clusterId: c.id,
      projectId,
      state: c.currentState,
      cloud: c.cloudProvider?.type,
      region: c.cloudProvider?.region,
      cidr: c.cloudProvider?.cidr,
      version: c.couchbaseServer?.version,
      configurationType: c.configurationType,
      availability: c.availability?.type,
      supportPlan: c.support?.plan,
      supportTimezone: c.support?.timezone,
      freeTier: isFreeTier(c),
      nodes: first?.numOfNodes,
      compute: cpu && ram ? `${cpu}/${ram}` : undefined,
      vcpus: cpu,
      totalNodes: totalNodes || undefined,
      serviceGroups: groups
        .map(
          (g) =>
            `${g.numOfNodes ?? "?"} × ${g.node?.compute?.cpu ?? "?"} vCPU/${g.node?.compute?.ram ?? "?"} GB (${(g.services ?? []).join(", ")})`,
        )
        .join("; "),
      serviceGroupsJson: groups.length ? JSON.stringify(groups) : undefined,
      deletionProtection: c.deletionProtection,
      connectionString: c.connectionString,
      appServiceId: c.appServiceId,
      memoryTotalMb: stats?.totalMemoryInMb,
      memoryUsedMb:
        stats?.totalMemoryInMb !== undefined && stats.freeMemoryInMb !== undefined
          ? stats.totalMemoryInMb - stats.freeMemoryInMb
          : undefined,
      ...auditFields(c.audit),
    }),
    { typeId: T.project, externalId: projectId },
  );
}

export function mapAppService(
  accountId: string,
  projectId: string,
  a: CpAppService,
): ResourceInstance {
  const cpu = a.compute?.cpu;
  const ram = a.compute?.ram;
  return instance(
    accountId,
    T.appService,
    joinId(projectId, a.clusterId ?? "", a.id),
    a.name ?? a.id,
    compact({
      name: a.name,
      description: a.description,
      appServiceId: a.id,
      clusterId: a.clusterId,
      projectId,
      state: a.currentState,
      cloud: a.cloudProvider,
      version: a.version,
      plan: a.plan,
      nodes: a.nodes,
      compute: cpu && ram ? `${cpu}/${ram}` : undefined,
      vcpus: cpu,
      ...auditFields(a.audit),
    }),
    { typeId: T.cluster, externalId: joinId(projectId, a.clusterId ?? "") },
  );
}

export function mapBucket(
  accountId: string,
  projectId: string,
  clusterId: string,
  b: CpBucket,
): ResourceInstance {
  return instance(
    accountId,
    T.bucket,
    joinId(projectId, clusterId, b.id),
    b.name ?? b.id,
    compact({
      name: b.name,
      bucketId: b.id,
      clusterId,
      projectId,
      type: b.type,
      storageBackend: b.storageBackend,
      memoryAllocationInMb: b.memoryAllocationInMb,
      replicas: b.replicas !== undefined ? String(b.replicas) : undefined,
      durabilityLevel: b.durabilityLevel,
      timeToLiveInSeconds: b.timeToLiveInSeconds,
      flushEnabled: b.flushEnabled ?? b.flush,
      evictionPolicy: b.evictionPolicy,
      conflictResolution: b.bucketConflictResolution,
      itemCount: b.stats?.itemCount,
      opsPerSecond: b.stats?.opsPerSecond,
      diskUsedMib: b.stats?.diskUsedInMib,
      memoryUsedMib: b.stats?.memoryUsedInMib,
    }),
    { typeId: T.cluster, externalId: joinId(projectId, clusterId) },
  );
}

export function describeAccess(c: CpCredential): string {
  return (c.access ?? [])
    .map((a) => {
      const buckets = (a.resources?.buckets ?? [])
        .map((b) => {
          const scopes = (b.scopes ?? []).map(
            (s) => `${s.name}${s.collections?.length ? `(${s.collections.join("|")})` : ""}`,
          );
          return `${b.name}${scopes.length ? `.${scopes.join("+")}` : ""}`;
        })
        .join(", ");
      return `${(a.privileges ?? []).join("+")} on ${buckets || "all buckets"}`;
    })
    .join("; ");
}

export function mapCredential(
  accountId: string,
  projectId: string,
  clusterId: string,
  c: CpCredential,
): ResourceInstance {
  return instance(
    accountId,
    T.credential,
    joinId(projectId, clusterId, c.id),
    c.name ?? c.id,
    compact({
      name: c.name,
      credentialId: c.id,
      clusterId,
      projectId,
      access: describeAccess(c),
      userRoles: (c.userRoles ?? []).join(", "),
      ...auditFields(c.audit),
    }),
    { typeId: T.cluster, externalId: joinId(projectId, clusterId) },
  );
}

export function mapCidr(
  accountId: string,
  projectId: string,
  clusterId: string,
  c: CpCidr,
): ResourceInstance {
  return instance(
    accountId,
    T.cidr,
    joinId(projectId, clusterId, c.id),
    c.comment ? `${c.cidr} (${c.comment})` : (c.cidr ?? c.id),
    compact({
      cidr: c.cidr,
      comment: c.comment,
      clusterId,
      status: c.status,
      type: c.type,
      expiresAt: c.expiresAt,
      ...auditFields(c.audit),
    }),
    { typeId: T.cluster, externalId: joinId(projectId, clusterId) },
  );
}

export function mapBackup(
  accountId: string,
  projectId: string,
  clusterId: string,
  b: CpBackup,
): ResourceInstance {
  return instance(
    accountId,
    T.backup,
    joinId(projectId, clusterId, b.id),
    `${b.bucketName ?? "bucket"} · ${b.date ?? b.id}`,
    compact({
      backupId: b.id,
      bucketName: b.bucketName,
      clusterKey: joinId(projectId, clusterId),
      status: b.status,
      method: b.method,
      source: b.source,
      createdAt: b.date,
      restoreBefore: b.restoreBefore,
      sizeGb:
        b.stats?.sizeInMb !== undefined
          ? Math.round((b.stats.sizeInMb / 1024) * 1000) / 1000
          : undefined,
      items: b.stats?.items,
      elapsedSeconds: b.elapsedTimeInSeconds,
    }),
    { typeId: T.cluster, externalId: joinId(projectId, clusterId) },
  );
}

function projectRoles(resources: CpUser["resources"], projectNames: Map<string, string>): string {
  return (resources ?? [])
    .map((r) => `${projectNames.get(r.id ?? "") ?? r.id}: ${(r.roles ?? []).join(", ")}`)
    .join("; ");
}

export function mapUser(
  accountId: string,
  u: CpUser,
  projectNames: Map<string, string>,
): ResourceInstance {
  return instance(
    accountId,
    T.user,
    u.id,
    u.email ?? u.name ?? u.id,
    compact({
      email: u.email,
      name: u.name,
      userId: u.id,
      status: u.status,
      inactive: u.inactive,
      organizationRoles: (u.organizationRoles ?? []).join(", "),
      projectRoles: projectRoles(u.resources, projectNames),
      isOwner: (u.organizationRoles ?? []).includes("organizationOwner"),
      lastLogin: u.lastLogin,
      ...auditFields(u.audit),
    }),
  );
}

export function mapApiKey(
  accountId: string,
  k: CpApiKey,
  projectNames: Map<string, string>,
): ResourceInstance {
  const created = k.audit?.createdAt ? Date.parse(k.audit.createdAt) : NaN;
  const expiresAt =
    typeof k.expiry === "number" && k.expiry > 0 && Number.isFinite(created)
      ? new Date(created + k.expiry * 86_400_000).toISOString()
      : undefined;
  return instance(
    accountId,
    T.apiKey,
    k.id,
    k.name ?? k.id,
    compact({
      name: k.name,
      keyId: k.id,
      description: k.description,
      organizationRoles: (k.organizationRoles ?? []).join(", "),
      projectRoles: projectRoles(k.resources, projectNames),
      allowedCidrs: (k.allowedCIDRs ?? []).join(", "),
      expiresAt,
      isOwner: (k.organizationRoles ?? []).includes("organizationOwner"),
      ...auditFields(k.audit),
    }),
  );
}
