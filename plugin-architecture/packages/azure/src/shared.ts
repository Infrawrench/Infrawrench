/**
 * Shared types and constants for Azure client modules.
 *
 * The Azure client surface is split across many small modules co-located in this
 * directory. They all need a slim "HTTP context" (the AAD-authenticated request
 * helpers) and a couple of shared lookup tables (ARM provider/api-version specs).
 * Keeping those here avoids re-importing the entire client class wherever a
 * per-service module needs to make a request.
 */

import type { AzureHttpTransport } from "./http.js";

export const ARM = "https://management.azure.com";

/**
 * Minimal HTTP surface required by per-service Azure client modules.
 *
 * `http` rides along so modules that talk to something *other* than ARM (the
 * ACR token dance and registry API, for instance) can reach the host's HTTP
 * service the same way the ARM verbs above already do — see `http.ts` for why
 * every Azure request has to have the option of going through the host.
 */
export interface AzureHttpContext extends AzureHttpTransport {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown): Promise<T>;
  put<T>(url: string, body: unknown): Promise<T>;
  patch<T>(url: string, body: unknown): Promise<T>;
  del(url: string): Promise<void>;
  subscriptionId: string;
  tenantId: string;
}

/** ARM resource spec — provider path segment + api-version query parameter. */
export interface ArmResourceSpec {
  provider: string;
  apiVersion: string;
}

/**
 * Map of plugin type-id → ARM spec. The single source of provider paths and
 * api-versions for the generic ARM URL builders: metrics, the manifest
 * get/apply path, and `delete-handlers.ts` (which spreads this map and adds
 * the one delete-only entry it needs).
 */
export const AZURE_ARM_SPECS: Record<string, ArmResourceSpec> = {
  "azure-resource-group": { provider: "", apiVersion: "2022-09-01" },
  "azure-vm": { provider: "Microsoft.Compute/virtualMachines", apiVersion: "2024-03-01" },
  "azure-disk": { provider: "Microsoft.Compute/disks", apiVersion: "2023-10-02" },
  "azure-vnet": { provider: "Microsoft.Network/virtualNetworks", apiVersion: "2023-09-01" },
  "azure-route-table": {
    provider: "Microsoft.Network/routeTables",
    apiVersion: "2023-09-01",
  },
  "azure-nat-gateway": {
    provider: "Microsoft.Network/natGateways",
    apiVersion: "2023-09-01",
  },
  "azure-aks-cluster": {
    provider: "Microsoft.ContainerService/managedClusters",
    apiVersion: "2024-01-01",
  },
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
  "azure-app-service-plan": { provider: "Microsoft.Web/serverfarms", apiVersion: "2023-01-01" },
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
  "azure-private-dns-zone": {
    provider: "Microsoft.Network/privateDnsZones",
    apiVersion: "2020-06-01",
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
