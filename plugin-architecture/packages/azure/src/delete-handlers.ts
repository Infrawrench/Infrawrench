/**
 * Generic delete dispatch.
 *
 * Most Azure resource types follow the same URL pattern, so a single
 * `provider / api-version` lookup table is enough. The two exceptions —
 * resource groups (no provider segment) and SQL databases (three-part
 * externalId rg/server/database) — are handled explicitly.
 *
 * The delete map differs from the read/manifest map in `shared.ts`: SQL
 * database is special-cased here, and a couple of api-versions are tuned for
 * the delete operation.
 */
import type { Client as GraphClient } from "@microsoft/microsoft-graph-client";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, type ArmResourceSpec, type AzureHttpContext } from "./shared.js";

const DELETE_SPECS: Record<string, ArmResourceSpec> = {
  "azure-resource-group": { provider: "", apiVersion: "2022-09-01" },
  "azure-vm": { provider: "Microsoft.Compute/virtualMachines", apiVersion: "2024-03-01" },
  "azure-disk": { provider: "Microsoft.Compute/disks", apiVersion: "2023-10-02" },
  "azure-vnet": { provider: "Microsoft.Network/virtualNetworks", apiVersion: "2023-09-01" },
  "azure-aks-cluster": {
    provider: "Microsoft.ContainerService/managedClusters",
    apiVersion: "2024-01-01",
  },
  "azure-sql-database": { provider: "", apiVersion: "" }, // Special handling
  "azure-cosmos-db": {
    provider: "Microsoft.DocumentDB/databaseAccounts",
    apiVersion: "2023-11-15",
  },
  "azure-storage-account": {
    provider: "Microsoft.Storage/storageAccounts",
    apiVersion: "2023-01-01",
  },
  "azure-function-app": { provider: "Microsoft.Web/sites", apiVersion: "2023-01-01" },
  "azure-app-service": { provider: "Microsoft.Web/sites", apiVersion: "2023-01-01" },
  "azure-container-instance": {
    provider: "Microsoft.ContainerInstance/containerGroups",
    apiVersion: "2023-05-01",
  },
  "azure-key-vault": { provider: "Microsoft.KeyVault/vaults", apiVersion: "2023-07-01" },
  "azure-redis-cache": { provider: "Microsoft.Cache/redis", apiVersion: "2023-08-01" },
  "azure-service-bus": {
    provider: "Microsoft.ServiceBus/namespaces",
    apiVersion: "2022-10-01-preview",
  },
  "azure-container-registry": {
    provider: "Microsoft.ContainerRegistry/registries",
    apiVersion: "2023-07-01",
  },
  "azure-load-balancer": {
    provider: "Microsoft.Network/loadBalancers",
    apiVersion: "2023-09-01",
  },
  "azure-dns-zone": {
    provider: "Microsoft.Network/dnszones",
    apiVersion: "2023-07-01-preview",
  },
  "azure-nsg": {
    provider: "Microsoft.Network/networkSecurityGroups",
    apiVersion: "2023-09-01",
  },
  "azure-public-ip": {
    provider: "Microsoft.Network/publicIPAddresses",
    apiVersion: "2023-09-01",
  },
  "azure-postgres-flexible": {
    provider: "Microsoft.DBforPostgreSQL/flexibleServers",
    apiVersion: "2023-06-01-preview",
  },
  "azure-mysql-flexible": {
    provider: "Microsoft.DBforMySQL/flexibleServers",
    apiVersion: "2023-06-30",
  },
  "azure-event-hub": {
    provider: "Microsoft.EventHub/namespaces",
    apiVersion: "2022-10-01-preview",
  },
  "azure-app-gateway": {
    provider: "Microsoft.Network/applicationGateways",
    apiVersion: "2023-09-01",
  },
  "azure-log-analytics": {
    provider: "Microsoft.OperationalInsights/workspaces",
    apiVersion: "2022-10-01",
  },
  "azure-managed-identity": {
    provider: "Microsoft.ManagedIdentity/userAssignedIdentities",
    apiVersion: "2023-01-31",
  },
  "azure-firewall": { provider: "Microsoft.Network/azureFirewalls", apiVersion: "2023-09-01" },
};

interface DeleteContext extends AzureHttpContext {
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
  graphClient: GraphClient;
}

export async function deleteAzureResource(
  ctx: DeleteContext,
  typeId: string,
  resourceId: string,
  accountId: string,
): Promise<void> {
  if (typeId === "azure-app-registration") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const objectId = String(resource.externalId ?? resource.fields["objectId"] ?? "");
    if (!objectId) throw new Error("Cannot determine app registration object id");
    await ctx.graphClient.api(`/applications/${objectId}`).delete();
    return;
  }
  const resource = await ctx.getResource(typeId, resourceId, accountId);
  const externalId = resource.externalId ?? "";

  const spec = DELETE_SPECS[typeId];
  if (!spec) throw new Error(`Azure plugin: delete not supported for "${typeId}"`);

  if (typeId === "azure-resource-group") {
    const rgName = externalId;
    await ctx.del(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups/${rgName}?api-version=${spec.apiVersion}`,
    );
    return;
  }

  if (typeId === "azure-sql-database") {
    // externalId is rg/server/database
    const parts = externalId.split("/");
    const [rg, server, db] = parts;
    await ctx.del(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Sql/servers/${server}/databases/${db}?api-version=2023-05-01-preview`,
    );
    return;
  }

  // Standard two-part externalId: rg/name
  const [rg, name] = externalId.split("/");
  await ctx.del(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${spec.provider}/${name}?api-version=${spec.apiVersion}`,
  );
}
