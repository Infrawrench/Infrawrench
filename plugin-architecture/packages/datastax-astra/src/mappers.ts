import type { ResourceInstance } from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";
import type {
  AstraCollection,
  AstraDatabase,
  AstraDatacenter,
  AstraPcuGroup,
  AstraRole,
  AstraTenant,
  AstraUser,
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
    pluginId: "datastax-astra",
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

/** `db/rest…`: the database id and everything after the first slash. */
export function splitFirst(externalId: string): [string, string] {
  const i = externalId.indexOf("/");
  if (i <= 0 || i === externalId.length - 1) {
    throw new Error(`Astra plugin: malformed id "${externalId}"`);
  }
  return [externalId.slice(0, i), externalId.slice(i + 1)];
}

/** Every keyspace the database reports, default first, without duplicates. */
export function keyspacesOf(db: AstraDatabase): string[] {
  const out = [
    db.info?.keyspace,
    ...(db.info?.keyspaces ?? []),
    ...(db.info?.additionalKeyspaces ?? []),
  ].filter((k): k is string => !!k);
  return Array.from(new Set(out));
}

const GB = 1024 ** 3;

/** Astra reports storage in GB on serverless; a value far above any real size is bytes. */
function gb(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return value > 1_000_000 ? Math.round((value / GB) * 100) / 100 : value;
}

export function apiEndpointOf(db: AstraDatabase, dc?: AstraDatacenter): string {
  const explicit = dc?.dataEndpointUrl ?? db.dataEndpointUrl;
  if (explicit) return explicit;
  const region = dc?.region ?? db.info?.region;
  return region ? `https://${db.id}-${region}.apps.astra.datastax.com` : "";
}

export function mapDatabase(
  accountId: string,
  db: AstraDatabase,
  access?: { enabled?: boolean; entries?: number },
): ResourceInstance {
  const dcs = db.info?.datacenters ?? [];
  const keyspaces = keyspacesOf(db);
  const pcus = Array.from(new Set(dcs.map((d) => d.pcuGroupUUID).filter(Boolean)));
  return instance(
    accountId,
    T.database,
    db.id,
    db.info?.name ?? db.id,
    compact({
      name: db.info?.name ?? db.id,
      databaseId: db.id,
      status: db.status,
      dbType: (db.info?.dbType ?? db.dbType) === "vector" ? "vector" : "non-vector",
      cloud: (db.info?.cloudProvider ?? dcs[0]?.cloudProvider)?.toUpperCase(),
      region: db.info?.region ?? dcs[0]?.region,
      regions: (dcs.length ? dcs.map((d) => d.region) : [db.info?.region])
        .filter(Boolean)
        .join(", "),
      tier: db.info?.tier,
      keyspace: db.info?.keyspace ?? keyspaces[0],
      keyspaces: keyspaces.join(", "),
      nodeCount: db.storage?.nodeCount,
      replicationFactor: db.storage?.replicationFactor,
      totalStorageGb: gb(db.storage?.totalStorage),
      usedStorageGb: gb(db.storage?.usedStorage),
      accessListEnabled: access?.enabled,
      accessListEntries: access?.entries,
      pcuGroupIds: pcus.join(", "),
      dataEndpointUrl: apiEndpointOf(db),
      cqlshUrl: db.cqlshUrl,
      grafanaUrl: db.grafanaUrl,
      ownerId: db.ownerId,
      orgId: db.orgId,
      message: db.message,
      createdAt: db.creationTime,
    }),
  );
}

export function mapRegion(
  accountId: string,
  db: AstraDatabase,
  dc: AstraDatacenter,
  privateLink?: { serviceName?: string; allowedPrincipals?: string[] },
): ResourceInstance {
  const dcId = dc.id ?? `${db.id}-1`;
  return instance(
    accountId,
    T.region,
    `${db.id}/${dcId}`,
    `${db.info?.name ?? db.id} · ${dc.region ?? dcId}`,
    compact({
      region: dc.region,
      cloud: dc.cloudProvider?.toUpperCase(),
      databaseId: db.id,
      datacenterId: dcId,
      status: dc.status,
      tier: dc.tier,
      classification: dc.regionClassification,
      zone: dc.regionZone,
      pcuGroupId: dc.pcuGroupUUID,
      dataEndpointUrl: apiEndpointOf(db, dc),
      privateLinkService: privateLink?.serviceName,
      allowedPrincipals: (privateLink?.allowedPrincipals ?? []).join(", "),
    }),
    { typeId: T.database, externalId: db.id },
  );
}

export function mapKeyspace(accountId: string, db: AstraDatabase, name: string): ResourceInstance {
  return instance(
    accountId,
    T.keyspace,
    `${db.id}/${name}`,
    name,
    compact({ name, databaseId: db.id, isDefault: name === db.info?.keyspace }),
    { typeId: T.database, externalId: db.id },
  );
}

export function mapCollection(
  accountId: string,
  dbId: string,
  keyspace: string,
  c: AstraCollection,
): ResourceInstance {
  const v = c.options?.vector;
  const rerank = c.options?.rerank;
  return instance(
    accountId,
    T.collection,
    `${dbId}/${keyspace}/${c.name}`,
    c.name,
    compact({
      name: c.name,
      databaseId: dbId,
      keyspace,
      vectorDimension: v?.dimension,
      vectorMetric: v?.metric,
      vectorize: v?.service
        ? `${v.service.provider ?? ""} ${v.service.modelName ?? ""}`.trim()
        : undefined,
      lexical: c.options?.lexical?.enabled,
      rerank: rerank?.enabled
        ? `${rerank.service?.provider ?? ""} ${rerank.service?.modelName ?? ""}`.trim() || "on"
        : rerank
          ? "off"
          : undefined,
      defaultIdType: c.options?.defaultId?.type,
    }),
    { typeId: T.keyspace, externalId: `${dbId}/${keyspace}` },
  );
}

export function mapPcuGroup(
  accountId: string,
  g: AstraPcuGroup,
  datacenters: string[],
): ResourceInstance {
  return instance(
    accountId,
    T.pcuGroup,
    g.uuid,
    g.title || g.uuid,
    compact({
      title: g.title,
      pcuGroupId: g.uuid,
      status: g.status,
      cloud: g.cloudProvider?.toUpperCase(),
      region: g.region,
      instanceType: g.instanceType,
      provisionType: g.provisionType,
      reserved: g.reserved,
      min: g.min,
      max: g.max,
      description: g.description,
      datacenters: datacenters.join(", "),
      createdAt: g.createdAt,
    }),
  );
}

export function mapTenant(accountId: string, t: AstraTenant): ResourceInstance {
  const name = t.tenantName ?? "";
  const cluster = t.clusterName ?? "";
  return instance(
    accountId,
    T.tenant,
    `${cluster}/${name}`,
    name,
    compact({
      tenantName: name,
      clusterName: cluster,
      cloud: (t.cloudProvider ?? t.cloudProviderCode)?.toUpperCase(),
      region: t.cloudRegion,
      plan: t.plan,
      status: t.status,
      pulsarVersion: t.pulsarVersion,
      brokerServiceUrl: t.brokerServiceUrl,
      webServiceUrl: t.webServiceUrl,
      websocketUrl: t.websocketUrl,
      userMetricsUrl: t.userMetricsUrl,
    }),
  );
}

/** Astra's default roles, which cannot be edited or deleted. */
export function isCustomRole(r: AstraRole): boolean {
  return !BUILT_IN.has(r.name ?? "");
}

const BUILT_IN = new Set([
  "Organization Administrator",
  "Administrator Service Account",
  "Administrator User",
  "Billing Administrator",
  "Database Administrator",
  "R/W User",
  "Read Only User",
  "API Administrator Service Account",
  "API Read/Write Service Account",
  "API Read Only Service Account",
  "UI View Only",
  "User Admin API",
  "CQL Read Only",
  "CQL Read/Write",
]);

export const ADMIN_ROLE_NAMES = new Set([
  "Organization Administrator",
  "Administrator Service Account",
  "Administrator User",
  "API Administrator Service Account",
]);

export function mapRole(accountId: string, r: AstraRole): ResourceInstance {
  const id = r.id ?? r.name ?? "";
  return instance(
    accountId,
    T.role,
    id,
    r.name ?? id,
    compact({
      name: r.name,
      roleId: id,
      description: r.policy?.description,
      permissions: (r.policy?.actions ?? []).join(", "),
      resources: (r.policy?.resources ?? []).join(", "),
      custom: isCustomRole(r),
      updatedAt: r.last_update_datetime,
    }),
  );
}

export function mapUser(accountId: string, u: AstraUser): ResourceInstance {
  const roles = u.roles ?? [];
  return instance(
    accountId,
    T.user,
    u.userID,
    u.email ?? u.userID,
    compact({
      email: u.email,
      userId: u.userID,
      status: u.status,
      roles: roles.map((r) => r.name ?? r.id).join(", "),
      roleIds: roles
        .map((r) => r.id)
        .filter(Boolean)
        .join(", "),
      isAdmin: roles.some((r) => ADMIN_ROLE_NAMES.has(r.name ?? "")),
    }),
  );
}
