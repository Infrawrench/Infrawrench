import type { ResourceInstance } from "@infrawrench/plugin-base";
import { parseCloudHost } from "./api.js";
import type {
  WcCluster,
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

/**
 * Which cluster a resource lives in. Every external id below the cluster
 * starts with the cluster key (`<host>[:port]`, see `clusterKeyOf`), so
 * `<key>/Article` is a collection and `<key>/Article/acme` one of its tenants.
 */
export interface ClusterScope {
  accountId: string;
  key: string;
}

export function clusterResourceId(scope: ClusterScope): string {
  return `${scope.accountId}:cluster:${scope.key}`;
}

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
  // Children name their cluster, so flat sidebar lists across several
  // clusters stay readable.
  const slash = opts.externalId.indexOf("/");
  const fields =
    opts.typeId !== "cluster" && slash > 0
      ? { cluster: opts.externalId.slice(0, slash), ...opts.fields }
      : opts.fields;
  return {
    id: `${opts.accountId}:${opts.typeId}:${opts.externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: opts.typeId,
    accountId: opts.accountId,
    displayName: opts.displayName,
    fields,
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

export function accountOf(resourceId: string): string {
  return resourceId.split(":")[0] ?? "";
}

export function typeOf(resourceId: string): string {
  return resourceId.split(":")[1] ?? "";
}

/**
 * Split a resource id (or external id) into its cluster and the path inside
 * it: `acct:tenant:<key>/Article/acme` gives key `<key>` and parts
 * `["Article", "acme"]`. A cluster's own id has no parts.
 */
export function splitScoped(resourceId: string): { scope: ClusterScope; parts: string[] } {
  const ext = externalOf(resourceId);
  const slash = ext.indexOf("/");
  const key = slash < 0 ? ext : ext.slice(0, slash);
  if (!key) throw new Error(`Weaviate plugin: cannot parse id "${ext}"`);
  const rest = slash < 0 ? "" : ext.slice(slash + 1);
  return {
    scope: { accountId: accountOf(resourceId), key },
    parts: rest ? rest.split("/") : [],
  };
}

/** The cluster-relative parts of a child id, which must have exactly `n` of them. */
export function partsOf(resourceId: string, n: number): string[] {
  const { parts } = splitScoped(resourceId);
  if (parts.length < n) throw new Error(`Weaviate plugin: cannot parse id "${resourceId}"`);
  // A tenant or user name never holds a slash, but keep anything after the
  // last expected part together rather than dropping it.
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join("/")];
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

/** How a cluster's in-cluster key reached the plugin. */
export type ClusterConnection = "credentials" | "stored" | "none";

export interface ClusterView {
  scope: ClusterScope;
  /** Normalised REST endpoint, when known. */
  endpoint: string;
  /** From the Weaviate Cloud organization API, when the account is signed in. */
  cloud?: WcCluster | undefined;
  /** Region id to cloud provider, from `/v1/regions`. */
  regionClouds?: Map<string, string> | undefined;
  connection: ClusterConnection;
  /** In-cluster readings; absent when not connected or unreachable. */
  meta?: WvMeta | undefined;
  nodes?: WvNode[] | undefined;
  /** Why the in-cluster readings are missing. */
  error?: string | undefined;
}

export function clusterHealth(nodes: WvNode[]): string {
  const healthy = nodes.filter((n) => n.status === "HEALTHY").length;
  if (!nodes.length) return "UNKNOWN";
  if (healthy === nodes.length) return "HEALTHY";
  return healthy === 0 ? "UNAVAILABLE" : "DEGRADED";
}

const CONNECTION_LABELS: Record<ClusterConnection, string> = {
  credentials: "Account credentials",
  stored: "Connected key",
  none: "Not connected",
};

export function mapCluster(view: ClusterView): ResourceInstance {
  const { endpoint, cloud, meta, nodes } = view;
  const host = (() => {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return view.scope.key;
    }
  })();
  const parsed = endpoint ? parseCloudHost(endpoint) : null;
  const isCloud = Boolean(cloud) || Boolean(parsed);
  const fields: Fields = {
    endpoint,
    hostname: host,
    hosting: isCloud ? "Weaviate Cloud" : "Self-hosted",
    connection: CONNECTION_LABELS[view.connection],
  };
  if (cloud) {
    fields["clusterId"] = cloud.id;
    if (cloud.name) fields["name"] = cloud.name;
    if (cloud.tier) fields["tier"] = cloud.tier;
    if (cloud.status) fields["lifecycle"] = cloud.status;
    if (cloud.status_reason) fields["statusReason"] = cloud.status_reason;
    if (cloud.created_at) fields["createdAt"] = cloud.created_at;
    if (cloud.expires_at) fields["expiresAt"] = cloud.expires_at;
  }
  const region = cloud?.region || parsed?.region;
  if (region) fields["region"] = region;
  const provider = (cloud?.region && view.regionClouds?.get(cloud.region)) || parsed?.cloud;
  if (provider) fields["cloud"] = provider;

  if (nodes) {
    fields["status"] = clusterHealth(nodes);
    fields["nodes"] = nodes.length;
    fields["healthyNodes"] = nodes.filter((n) => n.status === "HEALTHY").length;
    fields["objectCount"] = nodes.reduce((s, n) => s + (n.stats?.objectCount ?? 0), 0);
    fields["shardCount"] = nodes.reduce(
      (s, n) => s + (n.stats?.shardCount ?? n.shards?.length ?? 0),
      0,
    );
  } else if (view.connection === "none") {
    fields["status"] = "NOT_CONNECTED";
  } else {
    fields["status"] = "UNREACHABLE";
  }
  if (meta || nodes) {
    fields["version"] = meta?.version ?? nodes?.[0]?.version ?? "";
  }
  if (meta?.modules) {
    fields["modules"] = Object.keys(meta.modules).sort().join(", ");
  }
  if (view.error) fields["error"] = view.error.slice(0, 300);

  const outputs: Record<string, string> = {};
  if (endpoint) {
    outputs["url"] = endpoint;
    outputs["grpcHost"] = cloud?.grpc_endpoint
      ? cloud.grpc_endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "")
      : grpcHost(endpoint);
  }
  return makeInstance({
    accountId: view.scope.accountId,
    typeId: "cluster",
    externalId: view.scope.key,
    displayName: cloud?.name || host.split(".")[0] || "Weaviate cluster",
    fields,
    outputs,
    createdAt: cloud?.created_at,
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
  scope: ClusterScope,
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
    accountId: scope.accountId,
    typeId: "collection",
    externalId: `${scope.key}/${c.class}`,
    displayName: c.class,
    fields,
    outputs: { collectionName: c.class },
    parentResourceId: clusterResourceId(scope),
  });
}

export function mapTenant(collection: string, t: WvTenant, scope: ClusterScope): ResourceInstance {
  return makeInstance({
    accountId: scope.accountId,
    typeId: "tenant",
    externalId: `${scope.key}/${collection}/${t.name}`,
    displayName: t.name,
    fields: { name: t.name, collection, activityStatus: normalizeActivity(t.activityStatus) },
    parentResourceId: `${scope.accountId}:collection:${scope.key}/${collection}`,
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

export function mapAlias(a: WvAlias, scope: ClusterScope): ResourceInstance {
  return makeInstance({
    accountId: scope.accountId,
    typeId: "alias",
    externalId: `${scope.key}/${a.alias}`,
    parentResourceId: clusterResourceId(scope),
    displayName: a.alias,
    fields: { alias: a.alias, collection: a.class },
  });
}

export function mapBackup(b: WvBackup, backend: string, scope: ClusterScope): ResourceInstance {
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
    accountId: scope.accountId,
    typeId: "backup",
    externalId: `${scope.key}/${backend}/${b.id}`,
    parentResourceId: clusterResourceId(scope),
    displayName: b.id,
    fields,
    createdAt: b.startedAt,
  });
}

export function mapUser(u: WvDbUser, scope: ClusterScope): ResourceInstance {
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
    accountId: scope.accountId,
    typeId: "db-user",
    externalId: `${scope.key}/${u.userId}`,
    parentResourceId: clusterResourceId(scope),
    displayName: u.userId,
    fields,
    createdAt: u.createdAt,
  });
}

export const BUILTIN_ROLES = new Set(["admin", "viewer", "root", "read-only"]);

export function mapRole(r: WvRole, scope: ClusterScope): ResourceInstance {
  const actions = [...new Set((r.permissions ?? []).map((p) => p.action ?? "").filter(Boolean))];
  return makeInstance({
    accountId: scope.accountId,
    typeId: "role",
    externalId: `${scope.key}/${r.name}`,
    parentResourceId: clusterResourceId(scope),
    displayName: r.name,
    fields: {
      name: r.name,
      builtIn: BUILTIN_ROLES.has(r.name),
      permissionCount: r.permissions?.length ?? 0,
      actions: actions.join(", "),
    },
  });
}
