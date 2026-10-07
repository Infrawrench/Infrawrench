import type { ResourceInstance } from "@infrawrench/plugin-base";
import { hostUrl } from "./api.js";
import type {
  PcApiKey,
  PcAssistant,
  PcBackup,
  PcBackupSchedule,
  PcCollection,
  PcIndex,
  PcProject,
  PcRestoreJob,
  PcSchemaField,
  PcServiceAccount,
} from "./types.js";

/** Pure mapping from Pinecone payloads to host resource instances. */

export const PLUGIN_ID = "pinecone";

type Fields = ResourceInstance["fields"];

export function makeInstance(opts: {
  accountId: string;
  typeId: string;
  externalId: string;
  displayName: string;
  fields: Fields;
  outputs?: Record<string, string>;
  parentResourceId?: string;
  createdAt?: string | null | undefined;
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

/** Bare externalId of a host resource id (`account:type:external`). */
export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

/** `k=v, k2=v2`: the editable spelling of a tag map. */
export function formatTags(tags: Record<string, string> | null | undefined): string {
  if (!tags) return "";
  return Object.entries(tags)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(", ");
}

/**
 * Parse `k=v, k2=v2` back into a tag map. Throws on a malformed entry so the
 * edit form fails with a readable message instead of a 400.
 */
export function parseTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/[,\n]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new Error(`Tags are written key=value; "${entry}" has no key.`);
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) {
      throw new Error(`Tag key "${key}" must be 1 to 80 letters, digits, underscores or hyphens.`);
    }
    if (value.length > 120) throw new Error(`Tag "${key}" is longer than 120 characters.`);
    out[key] = value;
  }
  return out;
}

/**
 * The tag patch Pinecone needs to go from `current` to `next`: changed and
 * new keys with their values, removed keys as `""` (Pinecone's spelling of
 * "delete this tag").
 */
export function tagPatch(
  current: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  const patch: Record<string, string> = { ...next };
  for (const key of Object.keys(current)) {
    if (!(key in next)) patch[key] = "";
  }
  return patch;
}

export interface IndexShape {
  /** dense, sparse, integrated (semantic_text) or documents (full-text search). */
  kind: string;
  vectorType: string;
  dimension: number | undefined;
  metric: string;
  embedModel: string;
  fullTextFields: string[];
  filterableFields: string[];
}

/**
 * Summarise a `2026-07` index schema. Classic vector indexes report their
 * vectors under the reserved `_values` / `_sparse_values` names (dense ones
 * report both), integrated-embedding indexes a `semantic_text` field, and
 * document indexes named vector and full-text-search fields.
 */
export function indexShape(fields: Record<string, PcSchemaField> | undefined): IndexShape {
  const entries = Object.entries(fields ?? {});
  let dense: PcSchemaField | undefined;
  let sparse = false;
  let semantic: PcSchemaField | undefined;
  const fullText: string[] = [];
  const filterable: string[] = [];
  let classic = false;
  for (const [name, f] of entries) {
    if (name === "_values" || name === "_sparse_values") classic = true;
    switch (f.type) {
      case "dense_vector":
        dense ??= f;
        break;
      case "sparse_vector":
        sparse = true;
        break;
      case "semantic_text":
        semantic ??= f;
        break;
      case "string":
        if (f.full_text_search) fullText.push(name);
        else if (f.filterable) filterable.push(name);
        break;
      default:
        if (f.filterable) filterable.push(name);
    }
  }
  if (semantic) {
    return {
      kind: "integrated",
      vectorType: semantic.dimension ? "dense" : "sparse",
      dimension: semantic.dimension ?? undefined,
      metric: semantic.metric ?? "",
      embedModel: semantic.model ?? "",
      fullTextFields: fullText,
      filterableFields: filterable,
    };
  }
  const kind = classic ? (dense ? "dense" : "sparse") : fullText.length ? "documents" : "dense";
  return {
    kind,
    vectorType: dense ? "dense" : sparse ? "sparse" : "",
    dimension: dense?.dimension ?? undefined,
    metric: dense?.metric ?? (sparse ? "dotproduct" : ""),
    embedModel: "",
    fullTextFields: fullText,
    filterableFields: filterable,
  };
}

export function mapIndex(i: PcIndex, accountId: string): ResourceInstance {
  const d = i.deployment ?? {};
  const rc = i.read_capacity ?? {};
  const shape = indexShape(i.schema?.fields);
  const deploymentType = d.deployment_type ?? "managed";
  const fields: Fields = {
    name: i.name,
    deploymentType,
    status: i.status?.state ?? "",
    ready: i.status?.ready === true,
    host: i.host ?? "",
    kind: shape.kind,
    vectorType: shape.vectorType,
    metric: shape.metric,
    deletionProtection: i.deletion_protection ?? "disabled",
    tags: formatTags(i.tags),
  };
  if (shape.dimension !== undefined) fields["dimension"] = shape.dimension;
  if (shape.embedModel) fields["embedModel"] = shape.embedModel;
  if (shape.fullTextFields.length) fields["fullTextFields"] = shape.fullTextFields.join(", ");
  if (d.cloud) fields["cloud"] = d.cloud;
  if (d.region) fields["region"] = d.region;
  if (d.environment) fields["environment"] = d.environment;
  // Pod indexes have no cloud region, only an environment slug, which is also
  // what the status page names their components after.
  if (!d.region && d.environment) fields["region"] = d.environment;
  if (deploymentType === "pod") {
    if (d.pod_type) fields["podType"] = d.pod_type;
    fields["replicas"] = d.replicas ?? 1;
    fields["shards"] = d.shards ?? 1;
    fields["pods"] = (d.replicas ?? 1) * (d.shards ?? 1);
  } else {
    fields["readCapacityMode"] = rc.mode ?? "OnDemand";
    if (rc.mode === "Dedicated") {
      if (rc.dedicated?.node_type) fields["nodeType"] = rc.dedicated.node_type;
      if (rc.dedicated?.manual?.replicas !== undefined) {
        fields["replicas"] = rc.dedicated.manual.replicas;
      }
      if (rc.dedicated?.manual?.shards !== undefined) {
        fields["shards"] = rc.dedicated.manual.shards;
      }
    }
    if (rc.status?.state) fields["readCapacityState"] = rc.status.state;
    if (rc.status?.error_message) fields["readCapacityError"] = rc.status.error_message;
  }
  if (i.private_host) fields["privateHost"] = i.private_host;
  if (i.source_collection) fields["sourceCollection"] = i.source_collection;
  if (i.source_backup_id) fields["sourceBackupId"] = i.source_backup_id;
  if (i.cmek_id) fields["cmekId"] = i.cmek_id;
  const outputs: Record<string, string> = {
    indexName: i.name,
    host: hostUrl(i.host ?? ""),
  };
  if (i.private_host) outputs["privateHost"] = hostUrl(i.private_host);
  return makeInstance({
    accountId,
    typeId: "index",
    externalId: i.name,
    displayName: i.name,
    fields,
    outputs,
  });
}

export function mapCollection(c: PcCollection, accountId: string): ResourceInstance {
  const fields: Fields = {
    name: c.name,
    status: c.status ?? "",
    environment: c.environment ?? "",
  };
  if (c.size !== undefined) fields["sizeBytes"] = c.size;
  if (c.dimension !== undefined) fields["dimension"] = c.dimension;
  if (c.vector_count !== undefined) fields["vectorCount"] = c.vector_count;
  return makeInstance({
    accountId,
    typeId: "collection",
    externalId: c.name,
    displayName: c.name,
    fields,
  });
}

export function mapBackup(b: PcBackup, accountId: string): ResourceInstance {
  const fields: Fields = {
    backupId: b.backup_id,
    name: b.name ?? "",
    description: b.description ?? "",
    sourceIndexName: b.source_index_name ?? "",
    sourceIndexId: b.source_index_id ?? "",
    // Always written so the orphan rule's "not empty" test is meaningful.
    sourceIndexDeletedAt: b.source_index_deleted_at ?? "",
    status: b.status ?? "",
    cloud: b.cloud ?? "",
    region: b.region ?? "",
    tags: formatTags(b.tags),
  };
  if (b.record_count !== undefined && b.record_count !== null) {
    fields["recordCount"] = b.record_count;
  }
  if (b.namespace_count !== undefined && b.namespace_count !== null) {
    fields["namespaceCount"] = b.namespace_count;
  }
  if (b.size_bytes !== undefined && b.size_bytes !== null) fields["sizeBytes"] = b.size_bytes;
  if (b.created_at) fields["createdAt"] = b.created_at;
  return makeInstance({
    accountId,
    typeId: "backup",
    externalId: b.backup_id,
    displayName: b.name || `${b.source_index_name ?? "index"} backup`,
    fields,
    createdAt: b.created_at,
  });
}

export function mapBackupSchedule(
  s: PcBackupSchedule,
  indexName: string,
  accountId: string,
): ResourceInstance {
  const fields: Fields = {
    name: s.name ?? "",
    scheduleId: s.schedule_id,
    indexName,
    indexId: s.index_id ?? "",
    frequency: s.frequency ?? "",
    retentionDays: s.retention_expire_after_days ?? 0,
    enabled: s.enabled !== false,
    nextScheduledRun: s.next_scheduled_run ?? "",
  };
  if (s.created_at) fields["createdAt"] = s.created_at;
  return makeInstance({
    accountId,
    typeId: "backup-schedule",
    externalId: s.schedule_id,
    displayName: s.name || `${indexName} ${s.frequency ?? ""} backups`.trim(),
    fields,
    parentResourceId: `${accountId}:index:${indexName}`,
    createdAt: s.created_at,
  });
}

export function mapRestoreJob(j: PcRestoreJob, accountId: string): ResourceInstance {
  const fields: Fields = {
    restoreJobId: j.restore_job_id,
    backupId: j.backup_id ?? "",
    targetIndexName: j.target_index_name ?? "",
    targetIndexId: j.target_index_id ?? "",
    status: j.status ?? "",
  };
  if (j.percent_complete !== undefined) fields["percentComplete"] = j.percent_complete;
  if (j.created_at) fields["createdAt"] = j.created_at;
  if (j.completed_at) fields["completedAt"] = j.completed_at;
  return makeInstance({
    accountId,
    typeId: "restore-job",
    externalId: j.restore_job_id,
    displayName: `Restore into ${j.target_index_name ?? j.restore_job_id}`,
    fields,
    createdAt: j.created_at,
  });
}

export function mapAssistant(a: PcAssistant, accountId: string): ResourceInstance {
  const fields: Fields = {
    name: a.name,
    status: a.status ?? "",
    region: a.region ?? "us",
    host: a.host ?? "",
    instructions: a.instructions ?? "",
    metadata: a.metadata && Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : "",
  };
  if (a.created_at) fields["createdAt"] = a.created_at;
  if (a.updated_at) fields["updatedAt"] = a.updated_at;
  return makeInstance({
    accountId,
    typeId: "assistant",
    externalId: a.name,
    displayName: a.name,
    fields,
    outputs: { assistantName: a.name, host: hostUrl(a.host ?? "") },
    createdAt: a.created_at,
  });
}

export function mapProject(p: PcProject, accountId: string): ResourceInstance {
  const fields: Fields = {
    name: p.name,
    projectId: p.id,
    maxPods: p.max_pods ?? 0,
    forceEncryptionWithCmek: p.force_encryption_with_cmek === true,
    organizationId: p.organization_id ?? "",
  };
  if (p.created_at) fields["createdAt"] = p.created_at;
  return makeInstance({
    accountId,
    typeId: "project",
    externalId: p.id,
    displayName: p.name,
    fields,
    outputs: { projectId: p.id },
    createdAt: p.created_at,
  });
}

export function mapApiKey(k: PcApiKey, projectName: string, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "api-key",
    externalId: k.id,
    displayName: k.name,
    fields: {
      name: k.name,
      keyId: k.id,
      projectId: k.project_id,
      projectName,
      roles: (k.roles ?? []).join(", "),
    },
    parentResourceId: `${accountId}:project:${k.project_id}`,
  });
}

export function mapServiceAccount(s: PcServiceAccount, accountId: string): ResourceInstance {
  const fields: Fields = {
    name: s.name,
    serviceAccountId: s.id,
    clientId: s.client_id ?? "",
  };
  if (s.created_at) fields["createdAt"] = s.created_at;
  if (s.updated_at) fields["updatedAt"] = s.updated_at;
  return makeInstance({
    accountId,
    typeId: "service-account",
    externalId: s.id,
    displayName: s.name,
    fields,
    outputs: { clientId: s.client_id ?? "" },
    createdAt: s.created_at,
  });
}
