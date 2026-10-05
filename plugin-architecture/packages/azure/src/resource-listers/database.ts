import type { ResourceInstance } from "@infrawrench/plugin-base";
import { flexibleSkuVCores } from "../extended-support.js";
import {
  ARM,
  extractName,
  extractResourceGroup,
  extractVaultName,
  listAllPages,
  subnetRef,
  type ListerContext,
} from "./shared.js";

export async function listSQLDatabases(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // First list SQL servers, then databases within each
  const servers = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Sql/servers?api-version=2023-05-01-preview`,
  );
  const results: ResourceInstance[] = [];

  for (const server of servers.value ?? []) {
    const serverName = String(server["name"] ?? "");
    const serverRg = extractResourceGroup(String(server["id"] ?? ""));
    const serverProps = server["properties"] as Record<string, unknown> | undefined;
    const serverFqdn = String(serverProps?.["fullyQualifiedDomainName"] ?? "");

    try {
      const dbs = await ctx.get<{ value: Record<string, unknown>[] }>(
        `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${serverRg}/providers/Microsoft.Sql/servers/${serverName}/databases?api-version=2023-05-01-preview`,
      );

      for (const db of dbs.value ?? []) {
        const dbName = String(db["name"] ?? "");
        if (dbName === "master") continue; // Skip system database
        const dbProps = db["properties"] as Record<string, unknown> | undefined;
        results.push({
          id: ctx.id(accountId, "azure-sql-database", `${serverRg}/${serverName}/${dbName}`),
          pluginId: "azure",
          resourceTypeId: "azure-sql-database",
          accountId,
          displayName: `${serverName}/${dbName}`,
          fields: {
            name: dbName,
            serverName,
            resourceGroup: serverRg,
            location: String(db["location"] ?? ""),
            status: String(dbProps?.["status"] ?? ""),
            edition: String(dbProps?.["edition"] ?? dbProps?.["currentServiceObjectiveName"] ?? ""),
            serviceLevelObjective: String(
              dbProps?.["requestedServiceObjectiveName"] ??
                dbProps?.["currentServiceObjectiveName"] ??
                "",
            ),
            maxSizeBytes: Number(dbProps?.["maxSizeBytes"] ?? 0),
            collation: String(dbProps?.["collation"] ?? ""),
            zoneRedundant: (dbProps?.["zoneRedundant"] as boolean) ?? false,
          },
          resolvedOutputs: {
            serverFqdn,
            connectionString: `Server=tcp:${serverFqdn},1433;Initial Catalog=${dbName};`,
          },
          secretStates: [],
          externalId: `${serverRg}/${serverName}/${dbName}`,
          createdAt: String(dbProps?.["creationDate"] ?? ctx.now()),
          updatedAt: ctx.now(),
        });
      }
    } catch {
      // Skip servers we can't access
    }
  }
  return results;
}

export async function listCosmosDBAccounts(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.DocumentDB/databaseAccounts?api-version=2023-11-15`,
  );
  return (data.value ?? []).map((acct) => {
    const name = String(acct["name"] ?? "");
    const azureId = String(acct["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = acct["properties"] as Record<string, unknown> | undefined;
    const consistency = props?.["consistencyPolicy"] as Record<string, unknown> | undefined;
    const readLocations = props?.["readLocations"] as Array<Record<string, unknown>> | undefined;
    const writeLocations = props?.["writeLocations"] as Array<Record<string, unknown>> | undefined;

    return {
      id: ctx.id(accountId, "azure-cosmos-db", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-cosmos-db",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(acct["location"] ?? ""),
        kind: String(acct["kind"] ?? "GlobalDocumentDB"),
        databaseAccountOfferType: String(props?.["databaseAccountOfferType"] ?? "Standard"),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        consistencyLevel: String(consistency?.["defaultConsistencyLevel"] ?? ""),
        enableAutomaticFailover: (props?.["enableAutomaticFailover"] as boolean) ?? false,
        enableMultipleWriteLocations: (props?.["enableMultipleWriteLocations"] as boolean) ?? false,
        readLocations: readLocations?.map((l) => String(l["locationName"] ?? "")).join(", ") ?? "",
        writeLocations:
          writeLocations?.map((l) => String(l["locationName"] ?? "")).join(", ") ?? "",
        keyVaultName: extractVaultName(String(props?.["keyVaultKeyUri"] ?? "")),
      },
      resolvedOutputs: {
        documentEndpoint: String(props?.["documentEndpoint"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listRedisCaches(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Cache/redis?api-version=2023-08-01`,
  );
  return (data.value ?? []).map((redis) => {
    const name = String(redis["name"] ?? "");
    const azureId = String(redis["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = redis["properties"] as Record<string, unknown> | undefined;
    const sku = props?.["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-redis-cache", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-redis-cache",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(redis["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        capacity: Number(sku?.["capacity"] ?? 0),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        redisVersion: String(props?.["redisVersion"] ?? ""),
        nonSslPort: (props?.["enableNonSslPort"] as boolean) ?? false,
        shardCount: Number(props?.["shardCount"] ?? 0),
      },
      resolvedOutputs: {
        hostName: String(props?.["hostName"] ?? ""),
        port: String(props?.["sslPort"] ?? "6380"),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

/** Azure Managed Redis (`Microsoft.Cache/redisEnterprise`) api-version. */
const MANAGED_REDIS_API_VERSION = "2025-07-01";

/**
 * Azure Managed Redis clusters. Connection-level settings (port, TLS, keys,
 * modules) live on the cluster's database, not the cluster: a Managed Redis
 * cluster carries exactly one database, `default`, so the first database the
 * list returns is read and folded into the cluster's fields. That is one
 * extra request per cluster; a failure leaves the database fields blank
 * rather than dropping the cluster.
 */
export async function listManagedRedis(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const clusters = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Cache/redisEnterprise?api-version=${MANAGED_REDIS_API_VERSION}`,
  );
  return Promise.all(
    clusters.map(async (cluster) => {
      const name = String(cluster["name"] ?? "");
      const azureId = String(cluster["id"] ?? "");
      const rg = extractResourceGroup(azureId);
      const props = cluster["properties"] as Record<string, unknown> | undefined;
      const sku = cluster["sku"] as Record<string, unknown> | undefined;

      let db: Record<string, unknown> | undefined;
      try {
        const dbs = await listAllPages(
          ctx,
          `${ARM}${azureId}/databases?api-version=${MANAGED_REDIS_API_VERSION}`,
        );
        db = dbs[0]?.["properties"] as Record<string, unknown> | undefined;
      } catch {
        // See the doc comment: the cluster still lists.
      }
      const persistence = db?.["persistence"] as Record<string, unknown> | undefined;
      const modules = (db?.["modules"] as Array<Record<string, unknown>> | undefined) ?? [];
      const hostName = String(props?.["hostName"] ?? "");
      // Managed Redis databases listen on 10000 unless set otherwise at create.
      const port = db?.["port"] != null ? String(db["port"]) : "10000";

      return {
        id: ctx.id(accountId, "azure-managed-redis", `${rg}/${name}`),
        pluginId: "azure",
        resourceTypeId: "azure-managed-redis",
        accountId,
        displayName: name,
        fields: {
          name,
          resourceGroup: rg,
          location: String(cluster["location"] ?? ""),
          sku: String(sku?.["name"] ?? ""),
          provisioningState: String(props?.["provisioningState"] ?? ""),
          resourceState: String(props?.["resourceState"] ?? ""),
          redisVersion: String(db?.["redisVersion"] ?? props?.["redisVersion"] ?? ""),
          highAvailability: String(props?.["highAvailability"] ?? "Enabled"),
          redundancyMode: String(props?.["redundancyMode"] ?? ""),
          minimumTlsVersion: String(props?.["minimumTlsVersion"] ?? ""),
          publicNetworkAccess: String(props?.["publicNetworkAccess"] ?? ""),
          clientProtocol: String(db?.["clientProtocol"] ?? ""),
          clusteringPolicy: String(db?.["clusteringPolicy"] ?? ""),
          evictionPolicy: String(db?.["evictionPolicy"] ?? ""),
          modules: modules
            .map((m) => String(m["name"] ?? ""))
            .filter(Boolean)
            .join(", "),
          persistence: persistence?.["aofEnabled"]
            ? "AOF"
            : persistence?.["rdbEnabled"]
              ? "RDB"
              : db
                ? "None"
                : "",
          accessKeysAuthentication: String(db?.["accessKeysAuthentication"] ?? ""),
        },
        resolvedOutputs: { hostName, port, resourceId: azureId },
        secretStates: [],
        externalId: `${rg}/${name}`,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      };
    }),
  );
}

export async function listPostgresFlexibleServers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=2023-06-01-preview`,
  );
  return (data.value ?? []).map((srv) => {
    const name = String(srv["name"] ?? "");
    const azureId = String(srv["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = srv["properties"] as Record<string, unknown> | undefined;
    const sku = srv["sku"] as Record<string, unknown> | undefined;
    const storage = props?.["storage"] as Record<string, unknown> | undefined;
    const ha = props?.["highAvailability"] as Record<string, unknown> | undefined;
    const backup = props?.["backup"] as Record<string, unknown> | undefined;
    const network = props?.["network"] as Record<string, unknown> | undefined;
    const dataEncryption = props?.["dataEncryption"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-postgres-flexible", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-postgres-flexible",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(srv["location"] ?? ""),
        state: String(props?.["state"] ?? ""),
        version: String(props?.["version"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        tier: String(sku?.["tier"] ?? ""),
        // A high-availability standby's vCores are billed too.
        billableVCores:
          flexibleSkuVCores(String(sku?.["name"] ?? "")) *
          (String(ha?.["mode"] ?? "Disabled") !== "Disabled" ? 2 : 1),
        storageSizeGb: Number(storage?.["storageSizeGB"] ?? 0),
        haEnabled: String(ha?.["mode"] ?? "Disabled") !== "Disabled",
        backupRetentionDays: Number(backup?.["backupRetentionDays"] ?? 7),
        delegatedSubnet: subnetRef(String(network?.["delegatedSubnetResourceId"] ?? "")),
        // PostgreSQL spells it `…ArmResourceId`, MySQL `…ResourceId`.
        privateDnsZone: extractName(
          String(
            network?.["privateDnsZoneArmResourceId"] ?? network?.["privateDnsZoneResourceId"] ?? "",
          ),
        ),
        keyVaultName: extractVaultName(String(dataEncryption?.["primaryKeyURI"] ?? "")),
      },
      resolvedOutputs: {
        fqdn: String(props?.["fullyQualifiedDomainName"] ?? ""),
        administratorLogin: String(props?.["administratorLogin"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listMySQLFlexibleServers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.DBforMySQL/flexibleServers?api-version=2023-06-30`,
  );
  return (data.value ?? []).map((srv) => {
    const name = String(srv["name"] ?? "");
    const azureId = String(srv["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = srv["properties"] as Record<string, unknown> | undefined;
    const sku = srv["sku"] as Record<string, unknown> | undefined;
    const storage = props?.["storage"] as Record<string, unknown> | undefined;
    const ha = props?.["highAvailability"] as Record<string, unknown> | undefined;
    const backup = props?.["backup"] as Record<string, unknown> | undefined;
    const network = props?.["network"] as Record<string, unknown> | undefined;
    const dataEncryption = props?.["dataEncryption"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-mysql-flexible", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-mysql-flexible",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(srv["location"] ?? ""),
        state: String(props?.["state"] ?? ""),
        version: String(props?.["version"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        tier: String(sku?.["tier"] ?? ""),
        // A high-availability standby's vCores are billed too.
        billableVCores:
          flexibleSkuVCores(String(sku?.["name"] ?? "")) *
          (String(ha?.["mode"] ?? "Disabled") !== "Disabled" ? 2 : 1),
        storageSizeGb: Number(storage?.["storageSizeGB"] ?? 0),
        haEnabled: String(ha?.["mode"] ?? "Disabled") !== "Disabled",
        backupRetentionDays: Number(backup?.["backupRetentionDays"] ?? 7),
        delegatedSubnet: subnetRef(String(network?.["delegatedSubnetResourceId"] ?? "")),
        // PostgreSQL spells it `…ArmResourceId`, MySQL `…ResourceId`.
        privateDnsZone: extractName(
          String(
            network?.["privateDnsZoneArmResourceId"] ?? network?.["privateDnsZoneResourceId"] ?? "",
          ),
        ),
        keyVaultName: extractVaultName(String(dataEncryption?.["primaryKeyURI"] ?? "")),
      },
      resolvedOutputs: {
        fqdn: String(props?.["fullyQualifiedDomainName"] ?? ""),
        administratorLogin: String(props?.["administratorLogin"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
