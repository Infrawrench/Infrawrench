import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ListerContext {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  del(url: string): Promise<void>;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  subscriptionId: string;
}

const ARM = "https://management.azure.com";

/** Helper to extract resource group name from a full Azure resource ID */
function extractResourceGroup(azureId: string): string {
  const match = azureId.match(/resourceGroups\/([^/]+)/i);
  return match?.[1] ?? "";
}

/** Helper to extract a name from a full Azure resource ID */
function extractName(azureId: string): string {
  return azureId.split("/").pop() ?? "";
}

export async function listResourceGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups?api-version=2022-09-01`,
  );
  return (data.value ?? []).map((rg) => {
    const name = String(rg["name"] ?? "");
    const props = rg["properties"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "azure-resource-group", name),
      pluginId: "azure",
      resourceTypeId: "azure-resource-group",
      accountId,
      displayName: name,
      fields: {
        name,
        location: String(rg["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
      },
      resolvedOutputs: {
        resourceId: String(rg["id"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listVMs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  // Fetch VMs with instance view (includes power state)
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-03-01&$expand=instanceView`,
  );
  const results: ResourceInstance[] = [];

  for (const vm of data.value ?? []) {
    const name = String(vm["name"] ?? "");
    const location = String(vm["location"] ?? "");
    const azureId = String(vm["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = vm["properties"] as Record<string, unknown> | undefined;
    const hardwareProfile = props?.["hardwareProfile"] as Record<string, unknown> | undefined;
    const storageProfile = props?.["storageProfile"] as Record<string, unknown> | undefined;
    const osDisk = storageProfile?.["osDisk"] as Record<string, unknown> | undefined;
    const imageRef = storageProfile?.["imageReference"] as Record<string, unknown> | undefined;

    // Extract power state from instance view statuses
    const instanceView = props?.["instanceView"] as Record<string, unknown> | undefined;
    const statuses = instanceView?.["statuses"] as Array<Record<string, unknown>> | undefined;
    const powerStatus = statuses?.find((s) => String(s["code"] ?? "").startsWith("PowerState/"));
    const powerState = powerStatus ? String(powerStatus["displayStatus"] ?? "") : "";

    const imageStr = imageRef
      ? `${imageRef["publisher"] ?? ""}/${imageRef["offer"] ?? ""}/${imageRef["sku"] ?? ""}`
      : "";

    // Resolve IP addresses from network interfaces
    let publicIp = "";
    let privateIp = "";
    let fqdn = "";
    const networkProfile = props?.["networkProfile"] as Record<string, unknown> | undefined;
    const nics = networkProfile?.["networkInterfaces"] as
      | Array<Record<string, unknown>>
      | undefined;
    if (nics && nics.length > 0) {
      const firstNic = nics[0];
      const nicId = firstNic ? String(firstNic["id"] ?? "") : "";
      if (nicId) {
        try {
          const nic = await ctx.get<Record<string, unknown>>(
            `${ARM}${nicId}?api-version=2023-09-01`,
          );
          const nicProps = nic["properties"] as Record<string, unknown> | undefined;
          const ipConfigs = nicProps?.["ipConfigurations"] as
            | Array<Record<string, unknown>>
            | undefined;
          const firstIpConfig = ipConfigs?.[0];
          if (firstIpConfig) {
            const ipConfigProps = firstIpConfig["properties"] as
              | Record<string, unknown>
              | undefined;
            privateIp = String(ipConfigProps?.["privateIPAddress"] ?? "");
            const publicIpRef = ipConfigProps?.["publicIPAddress"] as
              | Record<string, unknown>
              | undefined;
            const publicIpId = String(publicIpRef?.["id"] ?? "");
            if (publicIpId) {
              try {
                const pip = await ctx.get<Record<string, unknown>>(
                  `${ARM}${publicIpId}?api-version=2023-09-01`,
                );
                const pipProps = pip["properties"] as Record<string, unknown> | undefined;
                publicIp = String(pipProps?.["ipAddress"] ?? "");
                const dnsSettings = pipProps?.["dnsSettings"] as
                  | Record<string, unknown>
                  | undefined;
                fqdn = String(dnsSettings?.["fqdn"] ?? "");
              } catch {
                // Public IP might not be accessible
              }
            }
          }
        } catch {
          // NIC might not be accessible
        }
      }
    }

    results.push({
      id: ctx.id(accountId, "azure-vm", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location,
        vmSize: String(hardwareProfile?.["vmSize"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        powerState,
        osType: String(osDisk?.["osType"] ?? ""),
        imageReference: imageStr,
        osDiskSizeGb: Number(osDisk?.["diskSizeGB"] ?? 0),
        sshUsername: String(
          (props?.["osProfile"] as Record<string, unknown> | undefined)?.["adminUsername"] ?? "",
        ),
      },
      resolvedOutputs: { publicIp, privateIp, fqdn },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["timeCreated"] ?? ctx.now()),
      updatedAt: ctx.now(),
    });
  }

  return results;
}

export async function listDisks(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Compute/disks?api-version=2023-10-02`,
  );
  return (data.value ?? []).map((disk) => {
    const name = String(disk["name"] ?? "");
    const azureId = String(disk["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = disk["properties"] as Record<string, unknown> | undefined;
    const sku = disk["sku"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "azure-disk", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-disk",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(disk["location"] ?? ""),
        diskSizeGb: Number(props?.["diskSizeGB"] ?? 0),
        diskState: String(props?.["diskState"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        osType: String(props?.["osType"] ?? ""),
        managedBy: extractName(String(props?.["managedBy"] ?? "")),
        encryption: String(
          (props?.["encryption"] as Record<string, unknown> | undefined)?.["type"] ?? "None",
        ),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["timeCreated"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listVNets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((vnet) => {
    const name = String(vnet["name"] ?? "");
    const azureId = String(vnet["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = vnet["properties"] as Record<string, unknown> | undefined;
    const addrSpace = props?.["addressSpace"] as Record<string, unknown> | undefined;
    const prefixes = addrSpace?.["addressPrefixes"] as string[] | undefined;
    const subnets = props?.["subnets"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "azure-vnet", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-vnet",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(vnet["location"] ?? ""),
        addressPrefixes: (prefixes ?? []).join(", "),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        subnetCount: subnets?.length ?? 0,
        enableDdosProtection: (props?.["enableDdosProtection"] as boolean) ?? false,
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAKSClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ContainerService/managedClusters?api-version=2024-01-01`,
  );
  return (data.value ?? []).map((cluster) => {
    const name = String(cluster["name"] ?? "");
    const azureId = String(cluster["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = cluster["properties"] as Record<string, unknown> | undefined;
    const agentPools = props?.["agentPoolProfiles"] as Array<Record<string, unknown>> | undefined;
    const totalNodes = agentPools?.reduce((sum, p) => sum + Number(p["count"] ?? 0), 0) ?? 0;
    const networkProfile = props?.["networkProfile"] as Record<string, unknown> | undefined;
    const powerState = props?.["powerState"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-aks-cluster", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-aks-cluster",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(cluster["location"] ?? ""),
        kubernetesVersion: String(props?.["kubernetesVersion"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        powerState: String(powerState?.["code"] ?? "Running"),
        nodeCount: totalNodes,
        nodePoolCount: agentPools?.length ?? 0,
        networkPlugin: String(networkProfile?.["networkPlugin"] ?? ""),
        tier: String((cluster["sku"] as Record<string, unknown> | undefined)?.["tier"] ?? "Free"),
      },
      resolvedOutputs: {
        fqdn: String(props?.["fqdn"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

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

export async function listStorageAccounts(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`,
  );
  return (data.value ?? []).map((sa) => {
    const name = String(sa["name"] ?? "");
    const azureId = String(sa["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = sa["properties"] as Record<string, unknown> | undefined;
    const primaryEndpoints = props?.["primaryEndpoints"] as Record<string, unknown> | undefined;
    const sku = sa["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-storage-account", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-storage-account",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(sa["location"] ?? ""),
        kind: String(sa["kind"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        accessTier: String(props?.["accessTier"] ?? ""),
        httpsOnly: (props?.["supportsHttpsTrafficOnly"] as boolean) ?? true,
        primaryLocation: String(props?.["primaryLocation"] ?? ""),
        statusOfPrimary: String(props?.["statusOfPrimary"] ?? ""),
      },
      resolvedOutputs: {
        primaryBlobEndpoint: String(primaryEndpoints?.["blob"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["creationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listFunctionApps(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Web/sites?api-version=2023-01-01`,
  );
  // Filter to only function apps (kind contains "functionapp")
  const functionApps = (data.value ?? []).filter((site) => {
    const kind = String(site["kind"] ?? "");
    return kind.toLowerCase().includes("functionapp");
  });

  return functionApps.map((fa) => {
    const name = String(fa["name"] ?? "");
    const azureId = String(fa["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = fa["properties"] as Record<string, unknown> | undefined;
    const siteConfig = props?.["siteConfig"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-function-app", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-function-app",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(fa["location"] ?? ""),
        state: String(props?.["state"] ?? ""),
        kind: String(fa["kind"] ?? ""),
        runtime: String(siteConfig?.["linuxFxVersion"] ?? siteConfig?.["windowsFxVersion"] ?? ""),
        runtimeVersion: String(siteConfig?.["netFrameworkVersion"] ?? ""),
        appServicePlan: extractName(String(props?.["serverFarmId"] ?? "")),
        httpsOnly: (props?.["httpsOnly"] as boolean) ?? false,
      },
      resolvedOutputs: {
        defaultHostName: String(props?.["defaultHostName"] ?? ""),
        outboundIpAddresses: String(props?.["outboundIpAddresses"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAppServices(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Web/sites?api-version=2023-01-01`,
  );
  // Filter to non-function apps
  const webApps = (data.value ?? []).filter((site) => {
    const kind = String(site["kind"] ?? "");
    return !kind.toLowerCase().includes("functionapp");
  });

  return webApps.map((app) => {
    const name = String(app["name"] ?? "");
    const azureId = String(app["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = app["properties"] as Record<string, unknown> | undefined;
    const siteConfig = props?.["siteConfig"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-app-service", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-app-service",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(app["location"] ?? ""),
        state: String(props?.["state"] ?? ""),
        kind: String(app["kind"] ?? ""),
        appServicePlan: extractName(String(props?.["serverFarmId"] ?? "")),
        httpsOnly: (props?.["httpsOnly"] as boolean) ?? false,
        linuxFxVersion: String(siteConfig?.["linuxFxVersion"] ?? ""),
      },
      resolvedOutputs: {
        defaultHostName: String(props?.["defaultHostName"] ?? ""),
        outboundIpAddresses: String(props?.["outboundIpAddresses"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listContainerInstances(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ContainerInstance/containerGroups?api-version=2023-05-01`,
  );
  return (data.value ?? []).map((cg) => {
    const name = String(cg["name"] ?? "");
    const azureId = String(cg["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = cg["properties"] as Record<string, unknown> | undefined;
    const containers = props?.["containers"] as unknown[] | undefined;
    const ipAddr = props?.["ipAddress"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-container-instance", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-container-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(cg["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        osType: String(props?.["osType"] ?? ""),
        restartPolicy: String(props?.["restartPolicy"] ?? ""),
        containers: containers?.length ?? 0,
        ipAddress: String(ipAddr?.["ip"] ?? ""),
        fqdn: String(ipAddr?.["fqdn"] ?? ""),
      },
      resolvedOutputs: {
        ipAddress: String(ipAddr?.["ip"] ?? ""),
        fqdn: String(ipAddr?.["fqdn"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listKeyVaults(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.KeyVault/vaults?api-version=2023-07-01&$top=100`,
  );
  return (data.value ?? []).map((vault) => {
    const name = String(vault["name"] ?? "");
    const azureId = String(vault["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = vault["properties"] as Record<string, unknown> | undefined;
    const sku = props?.["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-key-vault", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-key-vault",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(vault["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        enableSoftDelete: (props?.["enableSoftDelete"] as boolean) ?? true,
        enablePurgeProtection: (props?.["enablePurgeProtection"] as boolean) ?? false,
        enableRbacAuthorization: (props?.["enableRbacAuthorization"] as boolean) ?? false,
      },
      resolvedOutputs: {
        vaultUri: String(props?.["vaultUri"] ?? ""),
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

export async function listServiceBusNamespaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ServiceBus/namespaces?api-version=2024-01-01`,
  );
  return (data.value ?? []).map((ns) => {
    const name = String(ns["name"] ?? "");
    const azureId = String(ns["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = ns["properties"] as Record<string, unknown> | undefined;
    const sku = ns["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-service-bus", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-service-bus",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(ns["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        status: String(props?.["status"] ?? ""),
        createdAt: String(props?.["createdAt"] ?? ""),
      },
      resolvedOutputs: {
        serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listContainerRegistries(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ContainerRegistry/registries?api-version=2023-07-01`,
  );
  return (data.value ?? []).map((reg) => {
    const name = String(reg["name"] ?? "");
    const azureId = String(reg["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = reg["properties"] as Record<string, unknown> | undefined;
    const sku = reg["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-container-registry", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-container-registry",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(reg["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        adminEnabled: (props?.["adminUserEnabled"] as boolean) ?? false,
        publicNetworkAccess: String(props?.["publicNetworkAccess"] ?? "Enabled"),
      },
      resolvedOutputs: {
        loginServer: String(props?.["loginServer"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["creationDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listLoadBalancers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/loadBalancers?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((lb) => {
    const name = String(lb["name"] ?? "");
    const azureId = String(lb["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = lb["properties"] as Record<string, unknown> | undefined;
    const sku = lb["sku"] as Record<string, unknown> | undefined;
    const frontendIps = props?.["frontendIPConfigurations"] as unknown[] | undefined;
    const backendPools = props?.["backendAddressPools"] as unknown[] | undefined;
    const rules = props?.["loadBalancingRules"] as unknown[] | undefined;

    // Try to get the first frontend IP
    const firstFrontend = (frontendIps as Array<Record<string, unknown>> | undefined)?.[0];
    const frontendProps = firstFrontend?.["properties"] as Record<string, unknown> | undefined;
    const frontendIp = String(frontendProps?.["privateIPAddress"] ?? "");

    return {
      id: ctx.id(accountId, "azure-load-balancer", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-load-balancer",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(lb["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        frontendIpCount: frontendIps?.length ?? 0,
        backendPoolCount: backendPools?.length ?? 0,
        ruleCount: rules?.length ?? 0,
      },
      resolvedOutputs: {
        frontendIp,
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listDNSZones(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/dnsZones?api-version=2018-05-01`,
  );
  return (data.value ?? []).map((zone) => {
    const name = String(zone["name"] ?? "");
    const azureId = String(zone["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = zone["properties"] as Record<string, unknown> | undefined;
    const nameServers = props?.["nameServers"] as string[] | undefined;

    return {
      id: ctx.id(accountId, "azure-dns-zone", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-dns-zone",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        zoneType: String(props?.["zoneType"] ?? "Public"),
        numberOfRecordSets: Number(props?.["numberOfRecordSets"] ?? 0),
        maxNumberOfRecordSets: Number(props?.["maxNumberOfRecordSets"] ?? 0),
      },
      resolvedOutputs: {
        nameServers: (nameServers ?? []).join(", "),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listNSGs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/networkSecurityGroups?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((nsg) => {
    const name = String(nsg["name"] ?? "");
    const azureId = String(nsg["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = nsg["properties"] as Record<string, unknown> | undefined;
    const secRules = props?.["securityRules"] as unknown[] | undefined;
    const subnets = props?.["subnets"] as unknown[] | undefined;
    const nics = props?.["networkInterfaces"] as unknown[] | undefined;

    return {
      id: ctx.id(accountId, "azure-nsg", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-nsg",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(nsg["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        securityRuleCount: secRules?.length ?? 0,
        subnetCount: subnets?.length ?? 0,
        nicCount: nics?.length ?? 0,
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listPublicIPs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/publicIPAddresses?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((pip) => {
    const name = String(pip["name"] ?? "");
    const azureId = String(pip["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = pip["properties"] as Record<string, unknown> | undefined;
    const sku = pip["sku"] as Record<string, unknown> | undefined;
    const dnsSettings = props?.["dnsSettings"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-public-ip", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-public-ip",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(pip["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        allocationMethod: String(props?.["publicIPAllocationMethod"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        ipVersion: String(props?.["publicIPAddressVersion"] ?? ""),
      },
      resolvedOutputs: {
        ipAddress: String(props?.["ipAddress"] ?? ""),
        fqdn: String(dnsSettings?.["fqdn"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
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
        storageSizeGb: Number(storage?.["storageSizeGB"] ?? 0),
        haEnabled: String(ha?.["mode"] ?? "Disabled") !== "Disabled",
        backupRetentionDays: Number(backup?.["backupRetentionDays"] ?? 7),
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
        storageSizeGb: Number(storage?.["storageSizeGB"] ?? 0),
        haEnabled: String(ha?.["mode"] ?? "Disabled") !== "Disabled",
        backupRetentionDays: Number(backup?.["backupRetentionDays"] ?? 7),
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

export async function listEventHubNamespaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.EventHub/namespaces?api-version=2024-01-01`,
  );
  return (data.value ?? []).map((ns) => {
    const name = String(ns["name"] ?? "");
    const azureId = String(ns["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = ns["properties"] as Record<string, unknown> | undefined;
    const sku = ns["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-event-hub", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-event-hub",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(ns["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        status: String(props?.["status"] ?? ""),
        isAutoInflateEnabled: (props?.["isAutoInflateEnabled"] as boolean) ?? false,
        maximumThroughputUnits: Number(props?.["maximumThroughputUnits"] ?? 0),
      },
      resolvedOutputs: {
        serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAppGateways(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/applicationGateways?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((gw) => {
    const name = String(gw["name"] ?? "");
    const azureId = String(gw["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = gw["properties"] as Record<string, unknown> | undefined;
    const sku = props?.["sku"] as Record<string, unknown> | undefined;
    const backendPools = props?.["backendAddressPools"] as unknown[] | undefined;
    const httpListeners = props?.["httpListeners"] as unknown[] | undefined;
    const frontendIps = props?.["frontendIPConfigurations"] as
      | Array<Record<string, unknown>>
      | undefined;
    const firstFrontend = frontendIps?.[0];
    const frontendProps = firstFrontend?.["properties"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-app-gateway", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-app-gateway",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(gw["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        tier: String(sku?.["tier"] ?? ""),
        capacity: Number(sku?.["capacity"] ?? 0),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        operationalState: String(props?.["operationalState"] ?? ""),
        backendPoolCount: backendPools?.length ?? 0,
        httpListenerCount: httpListeners?.length ?? 0,
      },
      resolvedOutputs: {
        frontendIp: String(frontendProps?.["privateIPAddress"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listLogAnalyticsWorkspaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{
    value: Array<{
      id: string;
      name: string;
      location: string;
      properties?: {
        sku?: { name?: string };
        provisioningState?: string;
        retentionInDays?: number;
        workspaceCapping?: { dailyQuotaGb?: number };
        customerId?: string;
      };
    }>;
  }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.OperationalInsights/workspaces?api-version=2022-10-01`,
  );

  return (data.value ?? []).map((ws) => {
    const rg = extractResourceGroup(ws.id);
    const name = ws.name;
    const props = ws.properties;
    return {
      id: ctx.id(accountId, "azure-log-analytics", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-log-analytics",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: ws.location,
        sku: String(props?.sku?.name ?? ""),
        provisioningState: String(props?.provisioningState ?? ""),
        retentionInDays: props?.retentionInDays ?? 30,
        dailyQuotaGb: props?.workspaceCapping?.dailyQuotaGb ?? -1,
      },
      resolvedOutputs: {
        customerId: String(props?.customerId ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listManagedIdentities(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{
    value: Array<{
      id: string;
      name: string;
      location: string;
      properties?: {
        clientId?: string;
        principalId?: string;
        tenantId?: string;
      };
    }>;
  }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities?api-version=2023-01-31`,
  );

  return (data.value ?? []).map((mi) => {
    const rg = extractResourceGroup(mi.id);
    const name = mi.name;
    const props = mi.properties;
    return {
      id: ctx.id(accountId, "azure-managed-identity", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-managed-identity",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: mi.location,
      },
      resolvedOutputs: {
        clientId: String(props?.clientId ?? ""),
        principalId: String(props?.principalId ?? ""),
        tenantId: String(props?.tenantId ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listFirewalls(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{
    value: Array<{
      id: string;
      name: string;
      location: string;
      properties?: {
        sku?: { name?: string; tier?: string };
        provisioningState?: string;
        threatIntelMode?: string;
        ipConfigurations?: Array<{
          properties?: { privateIPAddress?: string };
        }>;
      };
    }>;
  }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/azureFirewalls?api-version=2023-09-01`,
  );

  return (data.value ?? []).map((fw) => {
    const rg = extractResourceGroup(fw.id);
    const name = fw.name;
    const props = fw.properties;
    const firstIpConfig = props?.ipConfigurations?.[0];
    return {
      id: ctx.id(accountId, "azure-firewall", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-firewall",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: fw.location,
        sku: String(props?.sku?.name ?? ""),
        tier: String(props?.sku?.tier ?? ""),
        provisioningState: String(props?.provisioningState ?? ""),
        threatIntelMode: String(props?.threatIntelMode ?? ""),
      },
      resolvedOutputs: {
        privateIp: String(firstIpConfig?.properties?.privateIPAddress ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
