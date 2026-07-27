/**
 * Resolves output keys (connection strings, kubeconfigs, primary keys) by
 * making the per-service "list secrets" ARM call that returns the actual
 * credential material — Azure doesn't surface these on the resource itself.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, type AzureHttpContext } from "./shared.js";

interface ResolveOutputDeps {
  ctx: AzureHttpContext;
  getResource: (typeId: string, resourceId: string, accountId: string) => Promise<ResourceInstance>;
  /** Exports app-registration client-secret via Graph addPassword. */
  exportAppRegistrationSecret: (
    typeId: string,
    resourceId: string,
    accountId: string,
  ) => Promise<string>;
}

export async function resolveAzureOutput(
  deps: ResolveOutputDeps,
  typeId: string,
  resourceId: string,
  outputKey: string,
  accountId: string,
): Promise<string> {
  const { ctx, getResource } = deps;

  // For AKS kubeconfig, we need to fetch it via API
  if (typeId === "azure-aks-cluster" && outputKey === "kubeconfig") {
    const resource = await getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    const kubeconfigData = await ctx.post<{ kubeconfigs?: Array<{ value: string }> }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/${name}/listClusterUserCredential?api-version=2024-01-01`,
      {},
    );
    const encoded = kubeconfigData.kubeconfigs?.[0]?.value ?? "";
    return atob(encoded);
  }

  if (
    typeId === "azure-cosmos-db" &&
    (outputKey === "primaryKey" || outputKey === "connectionString")
  ) {
    const resource = await getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    if (outputKey === "primaryKey") {
      const keys = await ctx.post<{ primaryMasterKey?: string }>(
        `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}/listKeys?api-version=2023-11-15`,
        {},
      );
      return keys.primaryMasterKey ?? "";
    }
    const connStrings = await ctx.post<{
      connectionStrings?: Array<{ connectionString: string }>;
    }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}/listConnectionStrings?api-version=2023-11-15`,
      {},
    );
    return connStrings.connectionStrings?.[0]?.connectionString ?? "";
  }

  if (
    typeId === "azure-storage-account" &&
    (outputKey === "primaryKey" || outputKey === "connectionString")
  ) {
    const resource = await getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    const keys = await ctx.post<{ keys?: Array<{ keyName: string; value: string }> }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}/listKeys?api-version=2023-01-01`,
      {},
    );
    const primaryKey = keys.keys?.[0]?.value ?? "";
    if (outputKey === "primaryKey") return primaryKey;
    return `DefaultEndpointsProtocol=https;AccountName=${name};AccountKey=${primaryKey};EndpointSuffix=core.windows.net`;
  }

  if (
    typeId === "azure-redis-cache" &&
    (outputKey === "primaryKey" || outputKey === "connectionString")
  ) {
    const resource = await getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    const keys = await ctx.post<{ primaryKey?: string }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Cache/redis/${name}/listKeys?api-version=2023-08-01`,
      {},
    );
    const pk = keys.primaryKey ?? "";
    if (outputKey === "primaryKey") return pk;
    const hostName = String(resource.fields["name"] ?? "");
    return `${hostName}.redis.cache.windows.net:6380,password=${pk},ssl=True,abortConnect=False`;
  }

  if (typeId === "azure-service-bus" && outputKey === "primaryConnectionString") {
    const resource = await getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    const keys = await ctx.post<{ primaryConnectionString?: string }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ServiceBus/namespaces/${name}/AuthorizationRules/RootManageSharedAccessKey/listKeys?api-version=2024-01-01`,
      {},
    );
    return keys.primaryConnectionString ?? "";
  }

  if (typeId === "azure-event-hub" && outputKey === "primaryConnectionString") {
    const resource = await getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    const keys = await ctx.post<{ primaryConnectionString?: string }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.EventHub/namespaces/${name}/AuthorizationRules/RootManageSharedAccessKey/listKeys?api-version=2024-01-01`,
      {},
    );
    return keys.primaryConnectionString ?? "";
  }

  if (typeId === "azure-sql-database" && outputKey === "connectionString") {
    const resource = await getResource(typeId, resourceId, accountId);
    const serverName = String(resource.fields["serverName"] ?? "");
    const dbName = String(resource.fields["name"] ?? "");
    return `Server=tcp:${serverName}.database.windows.net,1433;Initial Catalog=${dbName};Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;Authentication=Active Directory Default;`;
  }

  if (typeId === "azure-log-analytics" && outputKey === "primarySharedKey") {
    const resource = await getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    const keys = await ctx.post<{ primarySharedKey?: string }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.OperationalInsights/workspaces/${name}/sharedKeys?api-version=2020-08-01`,
      {},
    );
    return keys.primarySharedKey ?? "";
  }

  if (typeId === "azure-postgres-flexible" && outputKey === "connectionString") {
    const resource = await getResource(typeId, resourceId, accountId);
    const fqdn = String(resource.resolvedOutputs["fqdn"] ?? "");
    const adminLogin = String(resource.resolvedOutputs["administratorLogin"] ?? "");
    return `postgresql://${adminLogin}:{your_password}@${fqdn}:5432/postgres?sslmode=require`;
  }

  if (typeId === "azure-mysql-flexible" && outputKey === "connectionString") {
    const resource = await getResource(typeId, resourceId, accountId);
    const fqdn = String(resource.resolvedOutputs["fqdn"] ?? "");
    const adminLogin = String(resource.resolvedOutputs["administratorLogin"] ?? "");
    return `mysql://${adminLogin}:{your_password}@${fqdn}:3306/?ssl-mode=REQUIRED`;
  }

  if (typeId === "azure-app-registration" && outputKey === "clientSecret") {
    return deps.exportAppRegistrationSecret(typeId, resourceId, accountId);
  }

  // Default: look up in resolved outputs
  const resource = await getResource(typeId, resourceId, accountId);
  const value = resource.resolvedOutputs[outputKey];
  if (value === undefined) {
    throw new Error(`Azure plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }
  return String(value);
}
