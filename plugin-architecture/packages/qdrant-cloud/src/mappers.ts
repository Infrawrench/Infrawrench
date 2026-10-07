import type { ResourceInstance } from "@infrawrench/plugin-base";
import { durationToDays, enumTail, millicents } from "./api.js";
import type {
  QcAccessRule,
  QcBackup,
  QcBackupRestore,
  QcBackupSchedule,
  QcCluster,
  QcDatabaseApiKey,
  QcHybridEnvironment,
  QcKeyValue,
  QdbCollectionInfo,
} from "./types.js";

export const PLUGIN_ID = "qdrant-cloud";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  parentResourceId?: string;
  createdAt?: string | undefined;
}): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName,
    fields: opts.fields,
    resolvedOutputs: opts.outputs ?? {},
    secretStates: [],
    externalId: opts.externalId,
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: opts.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}

export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

export function clusterResourceId(accountId: string, clusterId: string): string {
  return `${accountId}:cluster:${clusterId}`;
}

export function formatLabels(labels: QcKeyValue[] | undefined): string {
  return (labels ?? [])
    .filter((l) => l.key)
    .map((l) => `${l.key}=${l.value ?? ""}`)
    .join(", ");
}

/** `k=v, k2=v2` back to protobuf `KeyValue`s. */
export function parseLabels(raw: string): QcKeyValue[] {
  const out: QcKeyValue[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`Labels are written key=value; "${entry}" has no key.`);
    out.push({ key: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() });
  }
  return out;
}

/** Kubernetes-style quantity to a number of GiB (`"8GiB"`, `"512Mi"`) or cores (`"500m"`). */
export function parseQuantity(q: string | undefined): number | undefined {
  if (!q) return undefined;
  const m = /^([\d.]+)\s*([A-Za-z]*)$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2]!.toLowerCase();
  switch (unit) {
    case "m":
      return n / 1000;
    case "mi":
    case "mib":
      return n / 1024;
    case "ti":
    case "tib":
      return n * 1024;
    default:
      return n;
  }
}

export function clusterPhase(c: QcCluster): string {
  return enumTail(c.state?.phase, "CLUSTER_PHASE_") || "UNKNOWN";
}

export function clusterRestUrl(c: QcCluster): string {
  const url = c.state?.endpoint?.url ?? "";
  if (!url) return "";
  const base = /^https?:\/\//.test(url) ? url : `https://${url}`;
  return `${base.replace(/\/+$/, "")}:${c.state?.endpoint?.restPort || 6333}`;
}

export function mapCluster(c: QcCluster, accountId: string): ResourceInstance {
  const conf = c.configuration ?? {};
  const st = c.state ?? {};
  const db = conf.databaseConfiguration ?? {};
  const fields: Fields = {
    name: c.name,
    clusterId: c.id,
    cloudProvider: c.cloudProviderId ?? "",
    region: c.cloudProviderRegionId ?? "",
    status: clusterPhase(c),
    statusReason: st.reason ?? "",
    version: conf.version ?? st.version ?? "",
    nodes: conf.numberOfNodes ?? 1,
    nodesUp: st.nodesUp ?? 0,
    packageId: conf.packageId ?? "",
    additionalDiskGib: conf.additionalResources?.disk ?? 0,
    storageTier: enumTail(conf.clusterStorageConfiguration?.storageTierType, "STORAGE_TIER_TYPE_"),
    allowedIpSourceRanges: (conf.allowedIpSourceRanges ?? []).join(", "),
    labels: formatLabels(c.labels),
    restartPolicy: enumTail(conf.restartPolicy, "CLUSTER_CONFIGURATION_RESTART_POLICY_"),
    rebalanceStrategy: enumTail(
      conf.rebalanceStrategy,
      "CLUSTER_CONFIGURATION_REBALANCE_STRATEGY_",
    ),
    inferenceEnabled: db.inference?.enabled === true,
    auditLogging: db.auditLogging?.enabled === true,
    jwtRbac: st.jwtRbac === true,
    url: clusterRestUrl(c),
  };
  if (db.collection?.replicationFactor)
    fields["replicationFactor"] = db.collection.replicationFactor;
  if (db.collection?.writeConsistencyFactor) {
    fields["writeConsistencyFactor"] = db.collection.writeConsistencyFactor;
  }
  if (db.collection?.vectors?.onDisk !== undefined) {
    fields["vectorsOnDisk"] = db.collection.vectors.onDisk;
  }
  const res = st.resources;
  if (res?.cpu?.available !== undefined) fields["cpuPerNode"] = res.cpu.available;
  if (res?.ram?.available !== undefined) fields["ramGibPerNode"] = res.ram.available;
  if (res?.disk?.available !== undefined) fields["diskGibPerNode"] = res.disk.available;
  if (c.createdAt) fields["createdAt"] = c.createdAt;
  if (st.restartedAt) fields["restartedAt"] = st.restartedAt;
  const endpoint = st.endpoint?.url ?? "";
  const outputs: Record<string, string> = { clusterId: c.id };
  if (endpoint) {
    const base = /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;
    outputs["url"] = clusterRestUrl(c);
    outputs["grpcUrl"] = `${base.replace(/\/+$/, "")}:${st.endpoint?.grpcPort || 6334}`;
    outputs["host"] = base.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  return makeInstance({
    accountId,
    typeId: "cluster",
    externalId: c.id,
    displayName: c.name,
    fields,
    outputs,
    createdAt: c.createdAt,
  });
}

export function accessSummary(rules: QcAccessRule[] | undefined): string {
  if (!rules?.length) return "Manage (global)";
  return rules
    .map((r) => {
      if (r.globalAccess) {
        return enumTail(r.globalAccess.accessType, "GLOBAL_ACCESS_RULE_ACCESS_TYPE_") === "MANAGE"
          ? "Manage (global)"
          : "Read-only (global)";
      }
      const t = enumTail(r.collectionAccess?.accessType, "COLLECTION_ACCESS_RULE_ACCESS_TYPE_");
      return `${r.collectionAccess?.collectionName ?? "?"}: ${t === "READ_WRITE" ? "read-write" : "read-only"}`;
    })
    .join("; ");
}

export function mapDatabaseKey(
  k: QcDatabaseApiKey,
  clusterName: string,
  accountId: string,
): ResourceInstance {
  const fields: Fields = {
    name: k.name ?? "",
    keyId: k.id,
    clusterId: k.clusterId ?? "",
    clusterName,
    access: accessSummary(k.accessRules),
    postfix: k.postfix ?? "",
    createdByEmail: k.createdByEmail ?? "",
    createdBy: enumTail(k.createdByActorType, "ACTOR_TYPE_"),
    expiresAt: k.expiresAt ?? "",
  };
  if (k.createdAt) fields["createdAt"] = k.createdAt;
  return makeInstance({
    accountId,
    typeId: "database-api-key",
    externalId: k.id,
    displayName: k.name || `Key …${k.postfix ?? ""}`,
    fields,
    ...(k.clusterId ? { parentResourceId: clusterResourceId(accountId, k.clusterId) } : {}),
    createdAt: k.createdAt,
  });
}

export function mapBackup(b: QcBackup, accountId: string): ResourceInstance {
  const fields: Fields = {
    name: b.displayName || b.name || "",
    backupId: b.id,
    clusterId: b.clusterId ?? "",
    clusterName: b.clusterInfo?.name ?? "",
    status: enumTail(b.status, "BACKUP_STATUS_"),
    scheduleId: b.backupScheduleId ?? "",
    region: b.clusterInfo?.cloudProviderRegionId ?? "",
    cloudProvider: b.clusterInfo?.cloudProviderId ?? "",
    duration: b.backupDuration ?? "",
  };
  const days = durationToDays(b.retentionPeriod);
  if (days !== undefined) fields["retentionDays"] = days;
  const disk = b.clusterInfo?.resourcesSummary?.disk;
  if (disk?.amount !== undefined) {
    const unit = (disk.unit ?? "Gi").toLowerCase();
    fields["sizeGb"] = unit.startsWith("t") ? disk.amount * 1024 : disk.amount;
  }
  if (b.price?.discountedPricePerMonth) {
    fields["monthlyCost"] = Math.round(millicents(b.price.discountedPricePerMonth) * 100) / 100;
    fields["currency"] = b.price.currency ?? "USD";
  }
  if (b.createdAt) fields["createdAt"] = b.createdAt;
  return makeInstance({
    accountId,
    typeId: "backup",
    externalId: b.id,
    displayName:
      b.displayName || b.name || `Backup of ${b.clusterInfo?.name ?? b.clusterId ?? "cluster"}`,
    fields,
    createdAt: b.createdAt,
  });
}

export const SCHEDULE_PRESETS: Record<string, string> = {
  "0 2 * * *": "Daily at 02:00 UTC",
  "0 */6 * * *": "Every 6 hours",
  "0 * * * *": "Hourly",
  "0 3 * * 0": "Weekly on Sunday at 03:00 UTC",
};

export function mapBackupSchedule(
  s: QcBackupSchedule,
  clusterName: string,
  accountId: string,
): ResourceInstance {
  const fields: Fields = {
    name: s.displayName ?? "",
    scheduleId: s.id,
    clusterId: s.clusterId ?? "",
    clusterName,
    schedule: s.schedule ?? "",
    status: enumTail(s.status, "BACKUP_SCHEDULE_STATUS_"),
  };
  const days = durationToDays(s.retentionPeriod);
  if (days !== undefined) fields["retentionDays"] = days;
  if (s.createdAt) fields["createdAt"] = s.createdAt;
  const label = SCHEDULE_PRESETS[s.schedule ?? ""] ?? s.schedule ?? "";
  return makeInstance({
    accountId,
    typeId: "backup-schedule",
    externalId: s.id,
    displayName: s.displayName || `${clusterName || "Cluster"}: ${label}`,
    fields,
    ...(s.clusterId ? { parentResourceId: clusterResourceId(accountId, s.clusterId) } : {}),
    createdAt: s.createdAt,
  });
}

export function mapRestore(
  r: QcBackupRestore,
  clusterName: string,
  accountId: string,
): ResourceInstance {
  const fields: Fields = {
    restoreId: r.id,
    clusterId: r.clusterId ?? "",
    clusterName,
    backupId: r.backupId ?? "",
    status: enumTail(r.status, "BACKUP_RESTORE_STATUS_"),
  };
  if (r.createdAt) fields["createdAt"] = r.createdAt;
  return makeInstance({
    accountId,
    typeId: "backup-restore",
    externalId: r.id,
    displayName: `Restore into ${clusterName || r.clusterId || "cluster"}`,
    fields,
    createdAt: r.createdAt,
  });
}

export function mapHybridEnvironment(h: QcHybridEnvironment, accountId: string): ResourceInstance {
  const st = h.status ?? {};
  const fields: Fields = {
    name: h.name,
    environmentId: h.id,
    status: enumTail(st.phase, "HYBRID_CLOUD_ENVIRONMENT_STATUS_PHASE_") || "PENDING",
    namespace: h.configuration?.namespace ?? "",
    kubernetesVersion: st.kubernetesVersion ?? "",
    kubernetesDistribution: enumTail(st.kubernetesDistribution, "KUBERNETES_DISTRIBUTION_"),
    kubernetesNodes: st.numberOfNodes ?? 0,
    readyForClusters: enumTail(st.clusterCreationReadiness, "QDRANT_CLUSTER_CREATION_STATUS_"),
    bootstrapped: h.bootstrapCommandsGenerated === true,
    statusMessage: st.message ?? "",
    createdByEmail: h.createdByEmail ?? "",
  };
  if (h.createdAt) fields["createdAt"] = h.createdAt;
  return makeInstance({
    accountId,
    typeId: "hybrid-environment",
    externalId: h.id,
    displayName: h.name,
    fields,
    outputs: { environmentId: h.id },
    createdAt: h.createdAt,
  });
}

export function vectorSummary(info: QdbCollectionInfo): {
  size?: number;
  distance?: string;
  named: string[];
} {
  const v = info.config?.params?.vectors;
  if (!v) return { named: [] };
  if (typeof (v as { size?: unknown }).size === "number") {
    const plain = v as { size?: number; distance?: string };
    return {
      ...(plain.size !== undefined ? { size: plain.size } : {}),
      ...(plain.distance ? { distance: plain.distance } : {}),
      named: [],
    };
  }
  const named = Object.entries(v as Record<string, { size?: number; distance?: string }>);
  return { named: named.map(([n, p]) => `${n} (${p.size ?? "?"}, ${p.distance ?? "?"})`) };
}

export function mapCollection(
  clusterId: string,
  clusterName: string,
  name: string,
  info: QdbCollectionInfo | undefined,
  accountId: string,
): ResourceInstance {
  const fields: Fields = { name, clusterId, clusterName };
  if (info) {
    const p = info.config?.params ?? {};
    const vs = vectorSummary(info);
    fields["status"] = info.status ?? "";
    if (info.points_count != null) fields["pointsCount"] = info.points_count;
    if (info.indexed_vectors_count != null)
      fields["indexedVectorsCount"] = info.indexed_vectors_count;
    if (info.segments_count !== undefined) fields["segmentsCount"] = info.segments_count;
    if (vs.size !== undefined) fields["vectorSize"] = vs.size;
    if (vs.distance) fields["distance"] = vs.distance;
    if (vs.named.length) fields["namedVectors"] = vs.named.join(", ");
    if (p.shard_number !== undefined) fields["shardNumber"] = p.shard_number;
    if (p.replication_factor !== undefined) fields["replicationFactor"] = p.replication_factor;
    if (p.write_consistency_factor !== undefined) {
      fields["writeConsistencyFactor"] = p.write_consistency_factor;
    }
  }
  return makeInstance({
    accountId,
    typeId: "collection",
    externalId: `${clusterId}/${name}`,
    displayName: name,
    fields,
    parentResourceId: clusterResourceId(accountId, clusterId),
  });
}

/** Split a `<clusterId>/<collection>` external id. */
export function parseCollectionId(resourceIdOrExternal: string): {
  clusterId: string;
  name: string;
} {
  const ext = externalOf(resourceIdOrExternal);
  const slash = ext.indexOf("/");
  if (slash <= 0) throw new Error(`Qdrant Cloud plugin: cannot parse collection id "${ext}"`);
  return { clusterId: ext.slice(0, slash), name: ext.slice(slash + 1) };
}
