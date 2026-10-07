import type { ResourceInstance } from "@infrawrench/plugin-base";
import { parseCloudHost } from "./api.js";
import type {
  WvAlias,
  WvBackup,
  WvClass,
  WvDbUser,
  WvMeta,
  WvNode,
  WvRole,
  WvTenant,
} from "./types.js";

export const PLUGIN_ID = "weaviate-cloud";

/** The single cluster an account points at. */
export const CLUSTER_EXTERNAL_ID = "cluster";

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

export function externalOf(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.split(":").slice(2).join(":") : resourceId;
}

/** Split `<collection>/<child>` external ids (tenants). */
export function splitScoped(resourceIdOrExternal: string): { scope: string; name: string } {
  const ext = externalOf(resourceIdOrExternal);
  const slash = ext.indexOf("/");
  if (slash <= 0) throw new Error(`Weaviate plugin: cannot parse id "${ext}"`);
  return { scope: ext.slice(0, slash), name: ext.slice(slash + 1) };
}

/** Per-collection totals summed over every node's shards (`/v1/nodes?output=verbose`). */
export function collectionStats(
  nodes: WvNode[],
): Map<string, { objects: number; shards: number; queue: number }> {
  const out = new Map<string, { objects: number; shards: number; queue: number }>();
  for (const n of nodes) {
    for (const s of n.shards ?? []) {
      if (!s.class) continue;
      const cur = out.get(s.class) ?? { objects: 0, shards: 0, queue: 0 };
      cur.objects += s.objectCount ?? 0;
      cur.shards += 1;
      cur.queue += s.vectorQueueLength ?? 0;
      out.set(s.class, cur);
    }
  }
  return out;
}

export function grpcHost(endpoint: string): string {
  try {
    const host = new URL(endpoint).hostname;
    return host.endsWith(".weaviate.cloud") || host.endsWith(".weaviate.network")
      ? `grpc-${host}`
      : host;
  } catch {
    return "";
  }
}

export function mapCluster(
  endpoint: string,
  meta: WvMeta,
  nodes: WvNode[],
  accountId: string,
): ResourceInstance {
  const cloud = parseCloudHost(endpoint);
  const healthy = nodes.filter((n) => n.status === "HEALTHY").length;
  const objects = nodes.reduce((s, n) => s + (n.stats?.objectCount ?? 0), 0);
  const shards = nodes.reduce((s, n) => s + (n.stats?.shardCount ?? n.shards?.length ?? 0), 0);
  const status = !nodes.length
    ? "UNKNOWN"
    : healthy === nodes.length
      ? "HEALTHY"
      : healthy === 0
        ? "UNAVAILABLE"
        : "DEGRADED";
  const host = (() => {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return endpoint;
    }
  })();
  const fields: Fields = {
    endpoint,
    hostname: host,
    version: meta.version ?? nodes[0]?.version ?? "",
    status,
    nodes: nodes.length,
    healthyNodes: healthy,
    objectCount: objects,
    shardCount: shards,
    modules: Object.keys(meta.modules ?? {})
      .sort()
      .join(", "),
    hosting: cloud ? "Weaviate Cloud" : "Self-hosted",
  };
  if (cloud) {
    fields["cloud"] = cloud.cloud;
    fields["region"] = cloud.region;
  }
  return makeInstance({
    accountId,
    typeId: "cluster",
    externalId: CLUSTER_EXTERNAL_ID,
    displayName: host.split(".")[0] || "Weaviate cluster",
    fields,
    outputs: { url: endpoint, grpcHost: grpcHost(endpoint) },
  });
}

export function vectorSummary(c: WvClass): {
  vectorizer: string;
  indexType: string;
  named: string;
} {
  if (c.vectorConfig && Object.keys(c.vectorConfig).length) {
    const entries = Object.entries(c.vectorConfig);
    const named = entries
      .map(
        ([name, v]) =>
          `${name} (${Object.keys(v.vectorizer ?? {})[0] ?? "none"}, ${v.vectorIndexType ?? "hnsw"})`,
      )
      .join(", ");
    const vectorizers = [
      ...new Set(entries.map(([, v]) => Object.keys(v.vectorizer ?? {})[0] ?? "none")),
    ];
    return {
      vectorizer: vectorizers.join(", "),
      indexType: entries[0]![1].vectorIndexType ?? "",
      named,
    };
  }
  return { vectorizer: c.vectorizer ?? "none", indexType: c.vectorIndexType ?? "", named: "" };
}

export function mapCollection(
  c: WvClass,
  stats: { objects: number; shards: number; queue: number } | undefined,
  accountId: string,
): ResourceInstance {
  const v = vectorSummary(c);
  const fields: Fields = {
    name: c.class,
    description: c.description ?? "",
    vectorizer: v.vectorizer,
    vectorIndexType: v.indexType,
    namedVectors: v.named,
    propertyCount: c.properties?.length ?? 0,
    properties: (c.properties ?? [])
      .map((p) => `${p.name}: ${(p.dataType ?? []).join("|")}`)
      .join(", "),
    replicationFactor: c.replicationConfig?.factor ?? 1,
    multiTenancy: c.multiTenancyConfig?.enabled === true,
    autoTenantCreation: c.multiTenancyConfig?.autoTenantCreation === true,
    autoTenantActivation: c.multiTenancyConfig?.autoTenantActivation === true,
  };
  if (stats) {
    fields["objectCount"] = stats.objects;
    fields["shardCount"] = stats.shards;
    fields["vectorQueueLength"] = stats.queue;
  }
  return makeInstance({
    accountId,
    typeId: "collection",
    externalId: c.class,
    displayName: c.class,
    fields,
    outputs: { collectionName: c.class },
  });
}

export function mapTenant(collection: string, t: WvTenant, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "tenant",
    externalId: `${collection}/${t.name}`,
    displayName: t.name,
    fields: { name: t.name, collection, activityStatus: normalizeActivity(t.activityStatus) },
    parentResourceId: `${accountId}:collection:${collection}`,
  });
}

/** Deprecated tenant status names to their current equivalents. */
export function normalizeActivity(s: string | undefined): string {
  switch ((s ?? "").toUpperCase()) {
    case "HOT":
      return "ACTIVE";
    case "COLD":
      return "INACTIVE";
    case "FROZEN":
      return "OFFLOADED";
    case "FREEZING":
      return "OFFLOADING";
    case "UNFREEZING":
      return "ONLOADING";
    default:
      return (s ?? "ACTIVE").toUpperCase();
  }
}

export function mapAlias(a: WvAlias, accountId: string): ResourceInstance {
  return makeInstance({
    accountId,
    typeId: "alias",
    externalId: a.alias,
    displayName: a.alias,
    fields: { alias: a.alias, collection: a.class },
  });
}

export function mapBackup(b: WvBackup, backend: string, accountId: string): ResourceInstance {
  const fields: Fields = {
    backupId: b.id,
    backend,
    status: b.status ?? "",
    collections: (b.classes ?? []).join(", "),
  };
  if (b.startedAt) fields["createdAt"] = b.startedAt;
  if (b.completedAt) fields["completedAt"] = b.completedAt;
  if (b.size !== undefined) fields["sizeGb"] = b.size;
  return makeInstance({
    accountId,
    typeId: "backup",
    externalId: `${backend}/${b.id}`,
    displayName: b.id,
    fields,
    createdAt: b.startedAt,
  });
}

export function mapUser(u: WvDbUser, accountId: string): ResourceInstance {
  const fields: Fields = {
    userId: u.userId,
    userType: u.dbUserType ?? "db_user",
    active: u.active !== false,
    roles: (u.roles ?? []).join(", "),
    keyPrefix: u.apiKeyFirstLetters ?? "",
  };
  if (u.createdAt) fields["createdAt"] = u.createdAt;
  if (u.lastUsedAt) fields["lastUsedAt"] = u.lastUsedAt;
  return makeInstance({
    accountId,
    typeId: "db-user",
    externalId: u.userId,
    displayName: u.userId,
    fields,
    createdAt: u.createdAt,
  });
}

export const BUILTIN_ROLES = new Set(["admin", "viewer", "root", "read-only"]);

export function mapRole(r: WvRole, accountId: string): ResourceInstance {
  const actions = [...new Set((r.permissions ?? []).map((p) => p.action ?? "").filter(Boolean))];
  return makeInstance({
    accountId,
    typeId: "role",
    externalId: r.name,
    displayName: r.name,
    fields: {
      name: r.name,
      builtIn: BUILTIN_ROLES.has(r.name),
      permissionCount: r.permissions?.length ?? 0,
      actions: actions.join(", "),
    },
  });
}
