//
// Each function lists a ClickHouse Cloud resource type via the REST API.
// They receive a context object with authenticated fetch helpers.

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
      },
      resolvedOutputs: {
        serviceId: s.id,
        host,
        port,
        nativePort,
        httpUrl: host ? `https://${host}:${port}` : "",
        connectionString: host ? `clickhouse://${host}:${nativePort}` : "",
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
