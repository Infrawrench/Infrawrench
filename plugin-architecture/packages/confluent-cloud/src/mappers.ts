import type { ResourceInstance } from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type {
  CcApiKey,
  CcByokKey,
  CcComputePool,
  CcConnectorExpanded,
  CcEnvironment,
  CcKafkaCluster,
  CcKsqlCluster,
  CcNetwork,
  CcNetworkConnection,
  CcPrivateLinkAttachment,
  CcSchemaRegistry,
  CcServiceAccount,
} from "./types.js";

export const PLUGIN_ID = "confluent-cloud";

type Fields = ResourceInstance["fields"];

/**
 * Resource ids carry the route a request needs (`env/cluster/name` for a
 * connector), because most Confluent endpoints are scoped by an environment
 * query parameter the provider id alone does not reveal. `externalId` stays
 * the provider's own id (`lkc-…`, `lcc-…`), which is the id the Billing
 * Costs API reports per line item, so cost rows join to these resources.
 */
export function resourceId(accountId: string, typeId: string, route: string): string {
  return `${accountId}:${typeId}:${route}`;
}

/** The `/`-separated route segments of a resource id. */
export function routeOf(id: string): string[] {
  return externalIdOf(id).split("/");
}

/** `env/id` routes: environment and provider id. */
export function envScoped(id: string): { env: string; id: string } {
  const parts = routeOf(id);
  if (parts.length < 2) return { env: "", id: parts[0] ?? "" };
  return { env: parts[0] ?? "", id: parts.slice(1).join("/") };
}

/** `env/cluster/name` routes for connectors. Connector names may contain `/`. */
export function connectorRoute(id: string): { env: string; cluster: string; name: string } {
  const parts = routeOf(id);
  return {
    env: parts[0] ?? "",
    cluster: parts[1] ?? "",
    name: parts.slice(2).join("/"),
  };
}

function put(fields: Fields, key: string, value: string | number | boolean | undefined | null) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value === "number" && !Number.isFinite(value)) return;
  fields[key] = value;
}

function instance(
  accountId: string,
  typeId: string,
  route: string,
  displayName: string,
  fields: Fields,
  opts: {
    externalId?: string;
    parentResourceId?: string;
    createdAt?: string;
    updatedAt?: string;
    resolvedOutputs?: Record<string, string>;
  } = {},
): ResourceInstance {
  const now = new Date().toISOString();
  return {
    id: resourceId(accountId, typeId, route),
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName,
    fields,
    resolvedOutputs: opts.resolvedOutputs ?? {},
    secretStates: [],
    externalId: opts.externalId ?? route,
    ...(opts.parentResourceId ? { parentResourceId: opts.parentResourceId } : {}),
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? opts.createdAt ?? now,
  };
}

const envParent = (accountId: string, env: string | undefined) =>
  env ? resourceId(accountId, "environment", env) : undefined;

export function mapEnvironment(accountId: string, e: CcEnvironment): ResourceInstance {
  const id = e.id ?? "";
  const fields: Fields = {};
  put(fields, "name", e.display_name ?? id);
  put(fields, "streamGovernance", e.stream_governance_config?.package);
  put(fields, "environmentId", id);
  put(fields, "createdAt", e.metadata?.created_at);
  return instance(accountId, "environment", id, e.display_name || id, fields, {
    ...(e.metadata?.created_at ? { createdAt: e.metadata.created_at } : {}),
    ...(e.metadata?.updated_at ? { updatedAt: e.metadata.updated_at } : {}),
    resolvedOutputs: { environmentId: id },
  });
}

/** Strip the listener prefix: `SASL_SSL://pkc-x.us-east-1.aws.confluent.cloud:9092`. */
export function bootstrapHost(endpoint: string | undefined): string {
  return (endpoint ?? "").replace(/^[A-Z_]+:\/\//, "");
}

/** `AWS/us-east-1/MULTI_ZONE`: the key CKU pricing is looked up by. */
export function placementKey(cloud?: string, region?: string, availability?: string): string {
  if (!cloud || !region) return "";
  return [cloud.toUpperCase(), region, (availability ?? "").toUpperCase()].join("/");
}

export function parsePlacement(key: string): {
  cloud: string;
  region: string;
  availability: string;
} {
  const [cloud = "", region = "", availability = ""] = key.split("/");
  return { cloud, region, availability };
}

/** Per-cluster numbers read from the Metrics API at listing time. */
export interface ClusterUsage {
  topics?: number;
  partitions?: number;
  retainedBytes?: number;
  bytesIn7d?: number;
  bytesOut7d?: number;
}

export function mapKafkaCluster(
  accountId: string,
  c: CcKafkaCluster,
  envName?: string,
  usage?: ClusterUsage,
): ResourceInstance {
  const id = c.id ?? "";
  const env = c.spec?.environment?.id ?? "";
  const spec = c.spec ?? {};
  const kind = spec.config?.kind ?? "";
  const fields: Fields = {};
  put(fields, "name", spec.display_name ?? id);
  if (kind === "Dedicated") put(fields, "cku", c.status?.cku ?? spec.config?.cku);
  else put(fields, "maxEcku", spec.config?.max_ecku);
  put(fields, "clusterType", kind);
  put(fields, "availability", spec.availability);
  put(fields, "cloud", spec.cloud);
  put(fields, "region", spec.region);
  put(fields, "placement", placementKey(spec.cloud, spec.region, spec.availability));
  put(fields, "phase", c.status?.phase);
  put(fields, "environmentId", env);
  put(fields, "environmentName", envName);
  put(fields, "networkId", spec.network?.id);
  put(fields, "bootstrapEndpoint", spec.kafka_bootstrap_endpoint);
  put(fields, "restEndpoint", spec.http_endpoint);
  if (spec.deletion_protection !== undefined) {
    fields["deletionProtection"] = spec.deletion_protection;
  }
  put(fields, "clusterId", id);
  put(fields, "createdAt", c.metadata?.created_at);
  if (c.metadata?.resource_name) fields["crn"] = c.metadata.resource_name;
  if (usage) {
    put(fields, "topics", usage.topics);
    put(fields, "partitions", usage.partitions);
    put(fields, "retainedBytes", usage.retainedBytes);
    put(fields, "bytesIn7d", usage.bytesIn7d);
    put(fields, "bytesOut7d", usage.bytesOut7d);
    if (usage.bytesIn7d !== undefined && usage.bytesOut7d !== undefined) {
      fields["idle"] = usage.bytesIn7d === 0 && usage.bytesOut7d === 0 ? "true" : "false";
    }
  }
  const bootstrap = bootstrapHost(spec.kafka_bootstrap_endpoint);
  return instance(accountId, "kafka-cluster", `${env}/${id}`, spec.display_name || id, fields, {
    externalId: id,
    ...(envParent(accountId, env) ? { parentResourceId: envParent(accountId, env)! } : {}),
    ...(c.metadata?.created_at ? { createdAt: c.metadata.created_at } : {}),
    ...(c.metadata?.updated_at ? { updatedAt: c.metadata.updated_at } : {}),
    resolvedOutputs: {
      clusterId: id,
      ...(bootstrap ? { bootstrapServers: bootstrap } : {}),
      ...(spec.http_endpoint ? { restEndpoint: spec.http_endpoint } : {}),
    },
  });
}

export interface ConnectorUsage {
  recordsIn7d?: number;
  recordsOut7d?: number;
}

export function mapConnector(
  accountId: string,
  env: string,
  cluster: string,
  name: string,
  c: CcConnectorExpanded,
  usage?: ConnectorUsage,
): ResourceInstance {
  const connectorId = c.id?.id ?? "";
  const tasks = c.status?.tasks ?? [];
  const fields: Fields = {};
  put(fields, "name", name);
  put(fields, "connectorClass", c.info?.config?.["connector.class"]);
  put(fields, "connectorType", c.status?.type ?? c.info?.type);
  put(fields, "state", c.status?.connector?.state);
  fields["tasks"] = tasks.length;
  fields["failedTasks"] = tasks.filter((t) => t.state === "FAILED").length;
  put(fields, "trace", c.status?.connector?.trace?.slice(0, 2000));
  put(fields, "connectorId", connectorId);
  put(fields, "clusterId", cluster);
  put(fields, "environmentId", env);
  put(fields, "tasksMax", c.info?.config?.["tasks.max"]);
  if (usage) {
    put(fields, "recordsIn7d", usage.recordsIn7d);
    put(fields, "recordsOut7d", usage.recordsOut7d);
    if (usage.recordsIn7d !== undefined && usage.recordsOut7d !== undefined) {
      fields["idle"] = usage.recordsIn7d === 0 && usage.recordsOut7d === 0 ? "true" : "false";
    }
  }
  return instance(accountId, "connector", `${env}/${cluster}/${name}`, name, fields, {
    externalId: connectorId || name,
    parentResourceId: resourceId(accountId, "kafka-cluster", `${env}/${cluster}`),
    resolvedOutputs: connectorId ? { connectorId } : {},
  });
}

export function mapComputePool(accountId: string, p: CcComputePool): ResourceInstance {
  const id = p.id ?? "";
  const env = p.spec?.environment?.id ?? "";
  const spec = p.spec ?? {};
  const fields: Fields = {};
  put(fields, "name", spec.display_name ?? id);
  put(fields, "maxCfu", spec.max_cfu !== undefined ? String(spec.max_cfu) : undefined);
  put(fields, "currentCfu", p.status?.current_cfu);
  put(fields, "cloud", spec.cloud);
  put(fields, "region", spec.region);
  put(fields, "phase", p.status?.phase);
  if (spec.default_pool !== undefined) fields["defaultPool"] = spec.default_pool;
  put(fields, "environmentId", env);
  put(fields, "poolId", id);
  put(fields, "createdAt", p.metadata?.created_at);
  return instance(
    accountId,
    "flink-compute-pool",
    `${env}/${id}`,
    spec.display_name || id,
    fields,
    {
      externalId: id,
      ...(envParent(accountId, env) ? { parentResourceId: envParent(accountId, env)! } : {}),
      ...(p.metadata?.created_at ? { createdAt: p.metadata.created_at } : {}),
      resolvedOutputs: { poolId: id },
    },
  );
}

export function mapKsqlCluster(accountId: string, k: CcKsqlCluster): ResourceInstance {
  const id = k.id ?? "";
  const env = k.spec?.environment?.id ?? "";
  const fields: Fields = {};
  put(fields, "name", k.spec?.display_name ?? id);
  put(fields, "csu", k.spec?.csu);
  put(fields, "phase", k.status?.phase);
  if (k.status?.is_paused !== undefined) fields["paused"] = k.status.is_paused;
  put(fields, "kafkaClusterId", k.spec?.kafka_cluster?.id);
  put(fields, "environmentId", env);
  put(fields, "endpoint", k.status?.http_endpoint);
  put(fields, "storageGb", k.status?.storage);
  put(fields, "topicPrefix", k.status?.topic_prefix);
  put(fields, "ksqlId", id);
  put(fields, "createdAt", k.metadata?.created_at);
  return instance(accountId, "ksqldb-cluster", `${env}/${id}`, k.spec?.display_name || id, fields, {
    externalId: id,
    ...(envParent(accountId, env) ? { parentResourceId: envParent(accountId, env)! } : {}),
    ...(k.metadata?.created_at ? { createdAt: k.metadata.created_at } : {}),
    resolvedOutputs: {
      ksqlId: id,
      ...(k.status?.http_endpoint ? { endpoint: k.status.http_endpoint } : {}),
    },
  });
}

export function mapSchemaRegistry(accountId: string, s: CcSchemaRegistry): ResourceInstance {
  const id = s.id ?? "";
  const env = s.spec?.environment?.id ?? "";
  const fields: Fields = {};
  put(fields, "name", s.spec?.display_name ?? id);
  put(fields, "package", s.spec?.package);
  put(fields, "cloud", s.spec?.cloud);
  put(fields, "region", s.spec?.region);
  put(fields, "phase", s.status?.phase);
  put(fields, "endpoint", s.spec?.http_endpoint);
  put(fields, "privateEndpoint", s.spec?.private_http_endpoint);
  put(fields, "environmentId", env);
  put(fields, "registryId", id);
  return instance(
    accountId,
    "schema-registry",
    `${env}/${id}`,
    s.spec?.display_name || id,
    fields,
    {
      externalId: id,
      ...(envParent(accountId, env) ? { parentResourceId: envParent(accountId, env)! } : {}),
      ...(s.metadata?.created_at ? { createdAt: s.metadata.created_at } : {}),
      resolvedOutputs: {
        registryId: id,
        ...(s.spec?.http_endpoint ? { endpoint: s.spec.http_endpoint } : {}),
      },
    },
  );
}

export function mapServiceAccount(accountId: string, s: CcServiceAccount): ResourceInstance {
  const id = s.id ?? "";
  const fields: Fields = {};
  put(fields, "name", s.display_name ?? id);
  put(fields, "description", s.description);
  put(fields, "serviceAccountId", id);
  put(fields, "createdAt", s.metadata?.created_at);
  return instance(accountId, "service-account", id, s.display_name || id, fields, {
    ...(s.metadata?.created_at ? { createdAt: s.metadata.created_at } : {}),
    resolvedOutputs: { serviceAccountId: id },
  });
}

/** API key scope as a human label: "Cloud" for org-level keys. */
export function apiKeyScope(k: CcApiKey): { scope: string; kind: string } {
  const r = k.spec?.resource;
  if (!r?.id || r.kind === "Cloud") return { scope: "Cloud", kind: "Cloud" };
  return { scope: r.id, kind: r.kind ?? "" };
}

export function mapApiKey(
  accountId: string,
  k: CcApiKey,
  ownerNames: Map<string, string>,
): ResourceInstance {
  const id = k.id ?? "";
  const ownerId = k.spec?.owner?.id ?? "";
  const { scope, kind } = apiKeyScope(k);
  const fields: Fields = {};
  put(fields, "name", k.spec?.display_name);
  put(fields, "description", k.spec?.description);
  put(
    fields,
    "owner",
    ownerNames.get(ownerId) ? `${ownerNames.get(ownerId)} (${ownerId})` : ownerId,
  );
  put(fields, "ownerId", ownerId);
  put(fields, "ownerKind", k.spec?.owner?.kind);
  put(fields, "scope", scope);
  put(fields, "scopeKind", kind);
  put(fields, "environmentId", k.spec?.resource?.environment);
  put(fields, "keyId", id);
  put(fields, "createdAt", k.metadata?.created_at);
  return instance(accountId, "api-key", id, k.spec?.display_name || id, fields, {
    ...(k.metadata?.created_at ? { createdAt: k.metadata.created_at } : {}),
    resolvedOutputs: { keyId: id },
  });
}

export function mapNetwork(accountId: string, n: CcNetwork): ResourceInstance {
  const id = n.id ?? "";
  const env = n.spec?.environment?.id ?? "";
  const fields: Fields = {};
  put(fields, "name", n.spec?.display_name ?? id);
  put(fields, "cloud", n.spec?.cloud);
  put(fields, "region", n.spec?.region);
  put(fields, "connectionTypes", (n.spec?.connection_types ?? []).join(", "));
  put(fields, "cidr", n.spec?.cidr);
  put(fields, "zones", (n.spec?.zones ?? []).join(", "));
  put(fields, "phase", n.status?.phase);
  put(fields, "dnsDomain", n.status?.dns_domain);
  put(fields, "idleSince", n.status?.idle_since);
  put(fields, "error", n.status?.error_message);
  put(fields, "environmentId", env);
  put(fields, "networkId", id);
  return instance(accountId, "network", `${env}/${id}`, n.spec?.display_name || id, fields, {
    externalId: id,
    ...(envParent(accountId, env) ? { parentResourceId: envParent(accountId, env)! } : {}),
    ...(n.metadata?.created_at ? { createdAt: n.metadata.created_at } : {}),
    resolvedOutputs: {
      networkId: id,
      ...(n.status?.dns_domain ? { dnsDomain: n.status.dns_domain } : {}),
    },
  });
}

export type ConnectionKind =
  "Peering" | "Transit Gateway Attachment" | "Private Link Access" | "Private Link Attachment";

/** Route segment per connection kind, so `getResource` knows which endpoint. */
export const CONNECTION_PATHS: Record<ConnectionKind, { slug: string; path: string }> = {
  Peering: { slug: "peering", path: "/networking/v1/peerings" },
  "Transit Gateway Attachment": {
    slug: "tgwa",
    path: "/networking/v1/transit-gateway-attachments",
  },
  "Private Link Access": { slug: "pla", path: "/networking/v1/private-link-accesses" },
  "Private Link Attachment": { slug: "platt", path: "/networking/v1/private-link-attachments" },
};

export function connectionKindForSlug(slug: string): ConnectionKind | undefined {
  return (Object.keys(CONNECTION_PATHS) as ConnectionKind[]).find(
    (k) => CONNECTION_PATHS[k].slug === slug,
  );
}

export function mapNetworkConnection(
  accountId: string,
  kind: ConnectionKind,
  c: CcNetworkConnection | CcPrivateLinkAttachment,
): ResourceInstance {
  const id = c.id ?? "";
  const env = c.spec?.environment?.id ?? "";
  const spec = c.spec as Record<string, unknown> | undefined;
  const cloudValue = spec?.["cloud"];
  const cloud =
    typeof cloudValue === "string"
      ? cloudValue
      : String((cloudValue as { kind?: string } | undefined)?.kind ?? "");
  const network = (spec?.["network"] as { id?: string } | undefined)?.id;
  const fields: Fields = {};
  put(fields, "name", c.spec?.display_name ?? id);
  put(fields, "connectionKind", kind);
  put(fields, "cloud", cloud);
  put(fields, "region", typeof spec?.["region"] === "string" ? (spec["region"] as string) : "");
  put(fields, "networkId", network);
  put(fields, "phase", c.status?.phase);
  put(fields, "error", c.status?.error_message);
  put(fields, "environmentId", env);
  put(fields, "connectionId", id);
  const slug = CONNECTION_PATHS[kind].slug;
  return instance(
    accountId,
    "network-connection",
    `${env}/${slug}/${id}`,
    c.spec?.display_name || id,
    fields,
    {
      externalId: id,
      ...(envParent(accountId, env) ? { parentResourceId: envParent(accountId, env)! } : {}),
      ...(c.metadata?.created_at ? { createdAt: c.metadata.created_at } : {}),
      resolvedOutputs: { connectionId: id },
    },
  );
}

export function mapEncryptionKey(accountId: string, k: CcByokKey): ResourceInstance {
  const id = k.id ?? "";
  const ref = k.key?.key_arn ?? k.key?.key_id ?? k.key?.key_name ?? "";
  const fields: Fields = {};
  put(fields, "name", k.display_name || id);
  put(fields, "provider", k.provider ?? k.key?.kind);
  put(fields, "keyReference", ref);
  put(fields, "state", k.state);
  put(fields, "validation", k.validation?.phase);
  put(fields, "validationRegion", k.validation?.region);
  put(fields, "keyId", id);
  put(fields, "createdAt", k.metadata?.created_at);
  return instance(accountId, "encryption-key", id, k.display_name || id, fields, {
    ...(k.metadata?.created_at ? { createdAt: k.metadata.created_at } : {}),
    resolvedOutputs: { keyId: id },
  });
}
