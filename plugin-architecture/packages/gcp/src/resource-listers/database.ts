import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type ListerContext } from "./shared.js";
import { engineInfoFromVersion } from "../cloudsql-engine.js";

export async function listCloudSqlInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://sqladmin.googleapis.com/v1/projects/${p}/instances`,
    "items",
  );
  return items.map((db) => {
    const ip = (db["ipAddresses"] as Array<Record<string, unknown>> | undefined)?.find(
      (a) => a["type"] === "PRIMARY",
    );
    const databaseVersion = String(db["databaseVersion"] ?? "");
    const engine = engineInfoFromVersion(databaseVersion);
    return {
      id: ctx.id(accountId, "cloudsql-instance", String(db["name"])),
      pluginId: "gcp",
      resourceTypeId: "cloudsql-instance",
      accountId,
      displayName: String(db["name"]),
      fields: {
        name: String(db["name"]),
        databaseVersion,
        region: String(db["region"] ?? ""),
        tier: String((db["settings"] as Record<string, unknown> | undefined)?.["tier"] ?? ""),
        state: String(db["state"] ?? ""),
        availabilityType: String(
          (db["settings"] as Record<string, unknown> | undefined)?.["availabilityType"] ?? "",
        ),
      },
      resolvedOutputs: {
        connectionName: String(db["connectionName"] ?? ""),
        ipAddress: String(ip?.["ipAddress"] ?? ""),
        username: engine.username,
        port: engine.port,
      },
      secretStates: [],
      externalId: String(db["name"]),
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSpannerInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://spanner.googleapis.com/v1/projects/${p}/instances`,
    "instances",
  );
  return items.map((inst) => {
    const name = String(inst["name"]).split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "spanner-instance", name),
      pluginId: "gcp",
      resourceTypeId: "spanner-instance",
      accountId,
      displayName: String(inst["displayName"] ?? name),
      fields: {
        name,
        displayName: String(inst["displayName"] ?? ""),
        config:
          String(inst["config"] ?? "")
            .split("/")
            .pop() ?? "",
        nodeCount: Number(inst["nodeCount"] ?? 0),
        processingUnits: Number(inst["processingUnits"] ?? 0),
        state: String(inst["state"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

async function listSpannerInstanceIds(ctx: ListerContext, p: string): Promise<string[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://spanner.googleapis.com/v1/projects/${p}/instances`,
    "instances",
  );
  return items
    .map((inst) => String(inst["name"]).split("/").pop() ?? "")
    .filter((n): n is string => Boolean(n));
}

export async function listSpannerDatabases(
  ctx: ListerContext,
  accountId: string,
  p: string,
  instanceFilter?: string,
): Promise<ResourceInstance[]> {
  const instanceIds = instanceFilter ? [instanceFilter] : await listSpannerInstanceIds(ctx, p);
  const all: ResourceInstance[] = [];
  for (const instance of instanceIds) {
    let dbs: Array<Record<string, unknown>> = [];
    try {
      dbs = await ctx.paginate<Record<string, unknown>>(
        `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/databases`,
        "databases",
      );
    } catch {
      continue;
    }
    for (const db of dbs) {
      const name = String(db["name"]).split("/").pop() ?? "";
      const encryption = db["encryptionConfig"] as Record<string, unknown> | undefined;
      const encryptionConfig = encryption?.["kmsKeyName"] ? String(encryption["kmsKeyName"]) : "";
      all.push({
        id: ctx.id(accountId, "spanner-database", `${instance}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "spanner-database",
        accountId,
        displayName: name,
        parentResourceId: ctx.id(accountId, "spanner-instance", instance),
        fields: {
          name,
          instance,
          state: String(db["state"] ?? ""),
          dialect: String(db["databaseDialect"] ?? "GOOGLE_STANDARD_SQL"),
          versionRetentionPeriod: String(db["versionRetentionPeriod"] ?? ""),
          earliestVersionTime: String(db["earliestVersionTime"] ?? ""),
          createTime: String(db["createTime"] ?? ""),
          enableDropProtection: Boolean(db["enableDropProtection"] ?? false),
          encryptionConfig,
          defaultLeader: String(db["defaultLeader"] ?? ""),
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${instance}/${name}`,
        createdAt: String(db["createTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return all;
}

export async function listSpannerBackups(
  ctx: ListerContext,
  accountId: string,
  p: string,
  instanceFilter?: string,
): Promise<ResourceInstance[]> {
  const instanceIds = instanceFilter ? [instanceFilter] : await listSpannerInstanceIds(ctx, p);
  const all: ResourceInstance[] = [];
  for (const instance of instanceIds) {
    let backups: Array<Record<string, unknown>> = [];
    try {
      backups = await ctx.paginate<Record<string, unknown>>(
        `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/backups`,
        "backups",
      );
    } catch {
      continue;
    }
    for (const b of backups) {
      const fullName = String(b["name"] ?? "");
      const name = fullName.split("/").pop() ?? "";
      const database =
        String(b["database"] ?? "")
          .split("/")
          .pop() ?? "";
      all.push({
        id: ctx.id(accountId, "spanner-backup", `${instance}/${name}`),
        pluginId: "gcp",
        resourceTypeId: "spanner-backup",
        accountId,
        displayName: name,
        parentResourceId: ctx.id(accountId, "spanner-instance", instance),
        fields: {
          name,
          instance,
          database,
          state: String(b["state"] ?? ""),
          sizeBytes: String(b["sizeBytes"] ?? "0"),
          createTime: String(b["createTime"] ?? ""),
          expireTime: String(b["expireTime"] ?? ""),
          versionTime: String(b["versionTime"] ?? ""),
          backupSchedules: Array.isArray(b["backupSchedules"])
            ? (b["backupSchedules"] as unknown[])
                .map((s) => String(s).split("/").pop() ?? "")
                .filter(Boolean)
                .join(", ")
            : "",
        },
        resolvedOutputs: {},
        secretStates: [],
        externalId: `${instance}/${name}`,
        createdAt: String(b["createTime"] ?? ctx.now()),
        updatedAt: ctx.now(),
      });
    }
  }
  return all;
}

export async function listBigtableInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ instances?: Record<string, unknown>[] }>(
    `https://bigtableadmin.googleapis.com/v2/projects/${p}/instances`,
  );
  return (data.instances ?? []).map((inst) => {
    const name = String(inst["name"]).split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "bigtable-instance", name),
      pluginId: "gcp",
      resourceTypeId: "bigtable-instance",
      accountId,
      displayName: String(inst["displayName"] ?? name),
      fields: {
        name,
        displayName: String(inst["displayName"] ?? ""),
        type: String(inst["type"] ?? ""),
        state: String(inst["state"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listFirestoreDatabases(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ databases?: Record<string, unknown>[] }>(
    `https://firestore.googleapis.com/v1/projects/${p}/databases`,
  );
  return (data.databases ?? []).map((db) => {
    const name = String(db["name"]).split("/").pop() ?? "";
    return {
      id: ctx.id(accountId, "firestore-database", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "firestore-database",
      accountId,
      displayName: name === "(default)" ? `${p} (default)` : name,
      fields: {
        name,
        locationId: String(db["locationId"] ?? ""),
        type: String(db["type"] ?? ""),
        databaseEdition: String(db["databaseEdition"] ?? "STANDARD"),
        concurrencyMode: String(db["concurrencyMode"] ?? ""),
        state: String(db["state"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(db["createTime"] ?? ctx.now()),
      updatedAt: String(db["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listMemorystoreRedis(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://redis.googleapis.com/v1/projects/${p}/locations/-/instances`,
    "instances",
  );
  return items.map((inst) => {
    const fullName = String(inst["name"]);
    const name = fullName.split("/").pop() ?? "";
    const region = fullName.split("/")[3] ?? "";
    return {
      id: ctx.id(accountId, "memorystore-redis", fullName),
      pluginId: "gcp",
      resourceTypeId: "memorystore-redis",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        tier: String(inst["tier"] ?? ""),
        memorySizeGb: Number(inst["memorySizeGb"] ?? 0),
        redisVersion: String(inst["redisVersion"] ?? ""),
        state: String(inst["state"] ?? ""),
      },
      resolvedOutputs: {
        host: String(inst["host"] ?? ""),
        port: String(inst["port"] ?? "6379"),
      },
      secretStates: [],
      externalId: fullName,
      createdAt: String(inst["createTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAlloyDbClusters(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const clusters = await ctx.paginate<Record<string, unknown>>(
    `https://alloydb.googleapis.com/v1/projects/${p}/locations/-/clusters`,
    "clusters",
  );
  return clusters.map((c) => {
    const fullName = String(c["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/")[3] ?? "";
    return {
      id: ctx.id(accountId, "alloydb-cluster", fullName),
      pluginId: "gcp",
      resourceTypeId: "alloydb-cluster",
      accountId,
      displayName: String(c["displayName"] ?? name),
      fields: {
        name,
        location,
        databaseVersion: String(c["databaseVersion"] ?? ""),
        state: String(c["state"] ?? ""),
        clusterType: String(c["clusterType"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: String(c["createTime"] ?? ctx.now()),
      updatedAt: String(c["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listAlloyDbInstances(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  // Enumerate clusters first, then list instances under each.
  const clusters = await ctx.paginate<Record<string, unknown>>(
    `https://alloydb.googleapis.com/v1/projects/${p}/locations/-/clusters`,
    "clusters",
  );
  const perCluster = await Promise.all(
    clusters.map(async (c) => {
      const fullName = String(c["name"]);
      try {
        const instances = await ctx.paginate<Record<string, unknown>>(
          `https://alloydb.googleapis.com/v1/${fullName}/instances`,
          "instances",
        );
        return instances.map((inst) => ({ inst, parentFullName: fullName }));
      } catch {
        return [];
      }
    }),
  );
  return perCluster.flat().map(({ inst, parentFullName }) => {
    const fullName = String(inst["name"]);
    const name = fullName.split("/").pop() ?? "";
    const ipAddress = String(inst["ipAddress"] ?? "");
    const machineConfig = inst["machineConfig"] as Record<string, unknown> | undefined;
    const cpuCount = Number(machineConfig?.["cpuCount"] ?? 0);
    return {
      id: ctx.id(accountId, "alloydb-instance", fullName),
      pluginId: "gcp",
      resourceTypeId: "alloydb-instance",
      accountId,
      parentResourceId: ctx.id(accountId, "alloydb-cluster", parentFullName),
      displayName: name,
      fields: {
        name,
        instanceType: String(inst["instanceType"] ?? ""),
        state: String(inst["state"] ?? ""),
        cpuCount,
        ipAddress,
        availabilityType: String(inst["availabilityType"] ?? ""),
      },
      resolvedOutputs: { ipAddress },
      secretStates: [],
      externalId: fullName,
      createdAt: String(inst["createTime"] ?? ctx.now()),
      updatedAt: String(inst["updateTime"] ?? ctx.now()),
    };
  });
}

export async function listMemorystoreMemcached(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const items = await ctx.paginate<Record<string, unknown>>(
    `https://memcache.googleapis.com/v1/projects/${p}/locations/-/instances`,
    "instances",
  );
  return items.map((inst) => {
    const fullName = String(inst["name"]);
    const name = fullName.split("/").pop() ?? "";
    const location = fullName.split("/locations/")[1]?.split("/")[0] ?? "";
    const nodeConfig = inst["nodeConfig"] as Record<string, unknown> | undefined;
    const discoveryEndpoint = String(
      (inst["discoveryEndpoint"] as Record<string, unknown> | undefined)?.["address"] ?? "",
    );
    const discoveryPort = String(
      (inst["discoveryEndpoint"] as Record<string, unknown> | undefined)?.["port"] ?? "",
    );
    const endpoint = discoveryEndpoint ? `${discoveryEndpoint}:${discoveryPort}` : "";
    return {
      id: ctx.id(accountId, "memorystore-memcached", fullName),
      pluginId: "gcp",
      resourceTypeId: "memorystore-memcached",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        state: String(inst["state"] ?? ""),
        nodeCount: Number(inst["nodeCount"] ?? 0),
        cpuCount: Number(nodeConfig?.["cpuCount"] ?? 0),
        memorySizeMb: Number(nodeConfig?.["memorySizeMb"] ?? 0),
        memcacheVersion: String(inst["memcacheVersion"] ?? ""),
        discoveryEndpoint: endpoint,
      },
      resolvedOutputs: { discoveryEndpoint: endpoint },
      secretStates: [],
      externalId: fullName,
      createdAt: String(inst["createTime"] ?? ctx.now()),
      updatedAt: String(inst["updateTime"] ?? ctx.now()),
    };
  });
}
