import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ListerContext {
  cloudApi<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T>;
  chQuery(sql: string): Promise<Record<string, unknown>[]>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  organizationId: string;
}

interface CloudEndpoint {
  protocol: string;
  host: string;
  port: number;
}

interface IpAccessListEntry {
  source?: string;
  description?: string;
}

interface CloudService {
  id: string;
  name: string;
  state: string;
  provider: string;
  region: string;
  clickhouseVersion?: string;
  tier?: string;
  minReplicaMemoryGb?: number;
  maxReplicaMemoryGb?: number;
  numReplicas?: number;
  idleScaling?: boolean;
  idleTimeoutMinutes?: number;
  isPrimary?: boolean;
  isReadonly?: boolean;
  autoscalingMode?: string;
  minReplicas?: number;
  maxReplicas?: number;
  releaseChannel?: string;
  dataWarehouseId?: string;
  complianceType?: string;
  profile?: string;
  ipAccessList?: IpAccessListEntry[];
  endpoints?: CloudEndpoint[];
  createdAt?: string;
  tags?: Array<{ key: string; value: string }>;
}

export async function listServices(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.cloudApi<{
    result?: CloudService[];
  }>("GET", `/v1/organizations/${ctx.organizationId}/services`);
  const services = data.result ?? [];

  return services.map((s) => {
    const httpsEndpoint = s.endpoints?.find((e) => e.protocol === "https");
    const nativeEndpoint = s.endpoints?.find(
      (e) => e.protocol === "native" || e.protocol === "nativesecure",
    );
    const host = httpsEndpoint?.host ?? "";
    const port = String(httpsEndpoint?.port ?? 8443);
    const nativePort = String(nativeEndpoint?.port ?? 9440);
    const mysqlEndpoint = s.endpoints?.find((e) => e.protocol === "mysql");
    const ipSources = (s.ipAccessList ?? [])
      .map((e) => (e.source ?? "").trim())
      .filter((v) => v.length > 0);

    return {
      id: ctx.id(accountId, "ch-service", s.id),
      pluginId: "clickhouse",
      resourceTypeId: "ch-service",
      accountId,
      displayName: s.name || s.id,
      fields: {
        serviceId: s.id,
        name: s.name,
        state: s.state,
        provider: s.provider,
        region: s.region,
        clickhouseVersion: s.clickhouseVersion ?? "",
        tier: s.tier ?? "",
        minReplicaMemoryGb: s.minReplicaMemoryGb ?? 0,
        maxReplicaMemoryGb: s.maxReplicaMemoryGb ?? 0,
        numReplicas: s.numReplicas ?? 0,
        idleScaling: s.idleScaling ?? false,
        idleTimeoutMinutes: s.idleTimeoutMinutes ?? 0,
        isPrimary: s.isPrimary ?? false,
        isReadonly: s.isReadonly ?? false,
        autoscalingMode: s.autoscalingMode ?? "",
        minReplicas: s.minReplicas ?? 0,
        maxReplicas: s.maxReplicas ?? 0,
        releaseChannel: s.releaseChannel ?? "",
        ipAccessList: ipSources.join(", "),
        openToInternet: ipSources.includes("0.0.0.0/0") || ipSources.includes("::/0"),
        dataWarehouseId: s.dataWarehouseId ?? "",
        complianceType: s.complianceType ?? "",
        profile: s.profile ?? "",
      },
      resolvedOutputs: {
        serviceId: s.id,
        host,
        port,
        nativePort,
        httpUrl: host ? `https://${host}:${port}` : "",
        connectionString: host ? `clickhouse://${host}:${nativePort}` : "",
        mysqlHost: mysqlEndpoint ? `${mysqlEndpoint.host}:${mysqlEndpoint.port}` : "",
      },
      secretStates: [],
      externalId: s.id,
      createdAt: s.createdAt ?? ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listDatabases(
  ctx: ListerContext,
  accountId: string,
  parentServiceId: string,
): Promise<ResourceInstance[]> {
  try {
    const rows = await ctx.chQuery(
      "SELECT name, engine, comment FROM system.databases ORDER BY name",
    );
    return rows.map((row) => {
      const name = String(row["name"] ?? "");
      return {
        id: ctx.id(accountId, "ch-database", `${parentServiceId}/${name}`),
        pluginId: "clickhouse",
        resourceTypeId: "ch-database",
        accountId,
        displayName: name,
        parentResourceId: ctx.id(accountId, "ch-service", parentServiceId),
        fields: {
          name,
          engine: String(row["engine"] ?? ""),
          comment: String(row["comment"] ?? ""),
        },
        resolvedOutputs: {
          databaseName: name,
        },
        secretStates: [],
        externalId: `${parentServiceId}/${name}`,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      };
    });
  } catch {
    // If we can't query the service (stopped, etc.), return empty
    return [];
  }
}

interface CloudBackup {
  id: string;
  status?: string;
  serviceId?: string;
  startedAt?: string;
  finishedAt?: string;
  sizeInBytes?: number;
  durationInSeconds?: number;
  type?: string;
  backupName?: string;
}

export async function listBackups(
  ctx: ListerContext,
  accountId: string,
  serviceId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.cloudApi<{ result?: CloudBackup[] }>(
    "GET",
    `/v1/organizations/${ctx.organizationId}/services/${serviceId}/backups`,
  );
  return (data.result ?? []).map((b) => ({
    id: ctx.id(accountId, "ch-backup", b.id),
    pluginId: "clickhouse",
    resourceTypeId: "ch-backup",
    accountId,
    displayName: b.startedAt ? `Backup ${b.startedAt.slice(0, 16).replace("T", " ")}` : b.id,
    parentResourceId: ctx.id(accountId, "ch-service", serviceId),
    fields: {
      backupId: b.id,
      serviceId: b.serviceId || serviceId,
      status: b.status ?? "",
      type: b.type ?? "",
      startedAt: b.startedAt ?? "",
      finishedAt: b.finishedAt ?? "",
      sizeInBytes: b.sizeInBytes ?? 0,
      durationInSeconds: b.durationInSeconds ?? 0,
      backupName: b.backupName ?? "",
    },
    resolvedOutputs: { backupId: b.id },
    secretStates: [],
    externalId: b.id,
    createdAt: b.startedAt ?? ctx.now(),
    updatedAt: ctx.now(),
  }));
}

export interface CloudClickPipe {
  id: string;
  serviceId?: string;
  name?: string;
  state?: string;
  scaling?: { replicas?: number; concurrency?: number };
  source?: Record<string, unknown>;
  destination?: { database?: string; table?: string };
  createdAt?: string;
  updatedAt?: string;
}

/** The source union carries one non-null key naming the source kind. */
export function clickPipeSourceType(source: Record<string, unknown> | undefined): string {
  if (!source) return "";
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && value !== undefined) return key;
  }
  return "";
}

export function clickPipeToResource(
  ctx: ListerContext,
  accountId: string,
  serviceId: string,
  p: CloudClickPipe,
): ResourceInstance {
  const sid = p.serviceId || serviceId;
  return {
    id: ctx.id(accountId, "ch-clickpipe", `${sid}/${p.id}`),
    pluginId: "clickhouse",
    resourceTypeId: "ch-clickpipe",
    accountId,
    displayName: p.name || p.id,
    parentResourceId: ctx.id(accountId, "ch-service", sid),
    fields: {
      clickPipeId: p.id,
      serviceId: sid,
      name: p.name ?? "",
      state: p.state ?? "Unknown",
      sourceType: clickPipeSourceType(p.source),
      destinationDatabase: p.destination?.database ?? "",
      destinationTable: p.destination?.table ?? "",
      replicas: p.scaling?.replicas ?? 0,
      concurrency: p.scaling?.concurrency ?? 0,
      createdAt: p.createdAt ?? "",
      updatedAt: p.updatedAt ?? "",
    },
    resolvedOutputs: { clickPipeId: p.id },
    secretStates: [],
    externalId: `${sid}/${p.id}`,
    createdAt: p.createdAt ?? ctx.now(),
    updatedAt: p.updatedAt ?? ctx.now(),
  };
}

export async function listClickPipes(
  ctx: ListerContext,
  accountId: string,
  serviceId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.cloudApi<{ result?: CloudClickPipe[] }>(
    "GET",
    `/v1/organizations/${ctx.organizationId}/services/${serviceId}/clickpipes`,
  );
  return (data.result ?? []).map((p) => clickPipeToResource(ctx, accountId, serviceId, p));
}

interface AssignedRole {
  roleId?: string;
  roleName?: string;
  roleType?: string;
}

/** Comma-joined role names, falling back to the deprecated single `role(s)`. */
function roleNames(assigned: AssignedRole[] | undefined, legacy: string[]): string[] {
  const names = (assigned ?? []).map((r) => r.roleName ?? "").filter((n) => n.length > 0);
  return names.length > 0 ? names : legacy.filter((n) => n.length > 0);
}

function hasAdminRole(names: string[]): boolean {
  return names.some((n) => /\badmin\b/i.test(n));
}

export interface CloudApiKey {
  id: string;
  name?: string;
  state?: string;
  roles?: string[];
  assignedRoles?: AssignedRole[];
  keySuffix?: string;
  createdAt?: string;
  expireAt?: string | null;
  usedAt?: string;
  ipAccessList?: IpAccessListEntry[];
}

export function apiKeyToResource(
  ctx: ListerContext,
  accountId: string,
  k: CloudApiKey,
): ResourceInstance {
  const roles = roleNames(k.assignedRoles, k.roles ?? []);
  return {
    id: ctx.id(accountId, "ch-api-key", k.id),
    pluginId: "clickhouse",
    resourceTypeId: "ch-api-key",
    accountId,
    displayName: k.name || k.id,
    fields: {
      keyId: k.id,
      name: k.name ?? "",
      state: k.state ?? "",
      keySuffix: k.keySuffix ?? "",
      roles: roles.join(", "),
      isAdmin: hasAdminRole(roles),
      createdAt: k.createdAt ?? "",
      expireAt: k.expireAt ?? "",
      lastUsedAt: k.usedAt ?? "",
      ipAccessList: (k.ipAccessList ?? [])
        .map((e) => e.source ?? "")
        .filter((v) => v.length > 0)
        .join(", "),
    },
    resolvedOutputs: { keyId: k.id },
    secretStates: [],
    externalId: k.id,
    createdAt: k.createdAt ?? ctx.now(),
    updatedAt: ctx.now(),
  };
}

export async function listApiKeys(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.cloudApi<{ result?: CloudApiKey[] }>(
    "GET",
    `/v1/organizations/${ctx.organizationId}/keys`,
  );
  return (data.result ?? []).map((k) => apiKeyToResource(ctx, accountId, k));
}

interface CloudMember {
  userId: string;
  name?: string;
  email?: string;
  role?: string;
  joinedAt?: string;
  assignedRoles?: AssignedRole[];
}

export async function listMembers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.cloudApi<{ result?: CloudMember[] }>(
    "GET",
    `/v1/organizations/${ctx.organizationId}/members`,
  );
  return (data.result ?? []).map((m) => {
    const roles = roleNames(m.assignedRoles, m.role ? [m.role] : []);
    return {
      id: ctx.id(accountId, "ch-member", m.userId),
      pluginId: "clickhouse",
      resourceTypeId: "ch-member",
      accountId,
      displayName: m.name || m.email || m.userId,
      fields: {
        userId: m.userId,
        name: m.name ?? "",
        email: m.email ?? "",
        roles: roles.join(", "),
        isAdmin: hasAdminRole(roles),
        joinedAt: m.joinedAt ?? "",
      },
      resolvedOutputs: { userId: m.userId, email: m.email ?? "" },
      secretStates: [],
      externalId: m.userId,
      createdAt: m.joinedAt ?? ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export interface CloudPostgres {
  id: string;
  name?: string;
  provider?: string;
  region?: string;
  postgresVersion?: string;
  size?: string;
  storageSize?: number;
  haType?: string;
  state?: string;
  createdAt?: string;
  isPrimary?: boolean;
  hostname?: string;
  username?: string;
  connectionString?: string;
}

export function postgresToResource(
  ctx: ListerContext,
  accountId: string,
  pg: CloudPostgres,
): ResourceInstance {
  return {
    id: ctx.id(accountId, "ch-postgres", pg.id),
    pluginId: "clickhouse",
    resourceTypeId: "ch-postgres",
    accountId,
    displayName: pg.name || pg.id,
    fields: {
      postgresId: pg.id,
      name: pg.name ?? "",
      state: pg.state ?? "",
      provider: pg.provider ?? "",
      region: pg.region ?? "",
      postgresVersion: pg.postgresVersion ?? "",
      size: pg.size ?? "",
      storageSize: pg.storageSize ?? 0,
      haType: pg.haType ?? "",
      isPrimary: pg.isPrimary ?? true,
      hostname: pg.hostname ?? "",
      username: pg.username ?? "",
      createdAt: pg.createdAt ?? "",
    },
    resolvedOutputs: {
      postgresId: pg.id,
      hostname: pg.hostname ?? "",
      username: pg.username ?? "",
      ...(pg.connectionString ? { connectionString: pg.connectionString } : {}),
    },
    secretStates: [],
    externalId: pg.id,
    createdAt: pg.createdAt ?? ctx.now(),
    updatedAt: ctx.now(),
  };
}

/**
 * The list endpoint returns the slim `PostgresServiceListItem` (no hostname
 * or storage size), so each service is read individually for those.
 */
export async function listPostgres(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const base = `/v1/organizations/${ctx.organizationId}/postgres`;
  const data = await ctx.cloudApi<{ result?: CloudPostgres[] }>("GET", base);
  const items = data.result ?? [];
  const detailed = await Promise.all(
    items.map(async (pg) => {
      try {
        const full = await ctx.cloudApi<{ result?: CloudPostgres }>("GET", `${base}/${pg.id}`);
        return { ...pg, ...(full.result ?? {}) };
      } catch {
        return pg;
      }
    }),
  );
  return detailed.map((pg) => postgresToResource(ctx, accountId, pg));
}
