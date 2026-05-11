/**
 * `getCreateConfig` dispatch — maps a plugin type-id to the matching
 * `get*CreateConfig` helper from `create-handlers.ts`.
 *
 * Kept separate from the per-handler module so adding a new resource type's
 * create flow only touches `create-handlers.ts` and this dispatch table.
 */
import type { CreateResourceConfig } from "@infrawrench/plugin-base";
import {
  type AzureCreateContext,
  getVMCreateConfig,
  getAKSCreateConfig,
  getStorageAccountCreateConfig,
  getCosmosDBCreateConfig,
  getRedisCacheCreateConfig,
  getFlexibleDBCreateConfig,
  getSQLDatabaseCreateConfig,
  getDiskCreateConfig,
  getAppServiceCreateConfig,
  getFunctionAppCreateConfig,
  getContainerInstanceCreateConfig,
  getMessagingNamespaceCreateConfig,
  getPublicIPCreateConfig,
  getLogAnalyticsCreateConfig,
  getLoadBalancerCreateConfig,
  getSimpleCreateConfig,
  getVNetCreateConfig,
  getKeyVaultCreateConfig,
  getContainerRegistryCreateConfig,
} from "./create-handlers.js";
import { AZURE_REGIONS } from "./regions.js";

export async function getAzureCreateConfig(
  ctx: AzureCreateContext,
  typeId: string,
): Promise<CreateResourceConfig> {
  if (typeId === "azure-app-registration") {
    return {
      fields: [
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
          description: "Shown in the Entra ID portal. 1–120 chars.",
        },
      ],
    };
  }
  if (typeId === "azure-vm") return getVMCreateConfig(ctx);
  if (typeId === "azure-aks-cluster") return getAKSCreateConfig(ctx);
  if (typeId === "azure-storage-account") return getStorageAccountCreateConfig(ctx);
  if (typeId === "azure-cosmos-db") return getCosmosDBCreateConfig(ctx);
  if (typeId === "azure-redis-cache") return getRedisCacheCreateConfig(ctx);
  if (typeId === "azure-postgres-flexible") {
    return getFlexibleDBCreateConfig(ctx, "PostgreSQL", ["16", "15", "14", "13"]);
  }
  if (typeId === "azure-mysql-flexible") {
    return getFlexibleDBCreateConfig(ctx, "MySQL", ["8.0.21", "5.7"]);
  }
  if (typeId === "azure-log-analytics") return getLogAnalyticsCreateConfig(ctx);
  if (typeId === "azure-managed-identity") {
    return getSimpleCreateConfig(
      ctx,
      "Managed Identity Name",
      "Name for the user-assigned managed identity",
      "azure-managed-identity",
    );
  }
  if (typeId === "azure-dns-zone") {
    return getSimpleCreateConfig(
      ctx,
      "DNS Zone Name",
      "DNS zone name (e.g. example.com)",
      "azure-dns-zone",
    );
  }
  if (typeId === "azure-vnet") return getVNetCreateConfig(ctx);
  if (typeId === "azure-nsg") {
    return getSimpleCreateConfig(ctx, "NSG Name", "e.g. my-nsg", "azure-nsg");
  }
  if (typeId === "azure-key-vault") return getKeyVaultCreateConfig(ctx);
  if (typeId === "azure-container-registry") return getContainerRegistryCreateConfig(ctx);
  if (typeId === "azure-resource-group") {
    return {
      fields: [
        {
          key: "name",
          label: "Resource Group Name",
          kind: "text",
          required: true,
          description: "Name for the new resource group",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: AZURE_REGIONS,
        },
      ],
    };
  }
  if (typeId === "azure-container-instance") return getContainerInstanceCreateConfig(ctx);
  if (typeId === "azure-service-bus") {
    return getMessagingNamespaceCreateConfig(ctx, "Service Bus Namespace");
  }
  if (typeId === "azure-event-hub") {
    return getMessagingNamespaceCreateConfig(ctx, "Event Hub Namespace");
  }
  if (typeId === "azure-public-ip") return getPublicIPCreateConfig(ctx);
  if (typeId === "azure-disk") return getDiskCreateConfig(ctx);
  if (typeId === "azure-app-service") return getAppServiceCreateConfig(ctx);
  if (typeId === "azure-function-app") return getFunctionAppCreateConfig(ctx);
  if (typeId === "azure-sql-database") return getSQLDatabaseCreateConfig(ctx);
  if (typeId === "azure-load-balancer") return getLoadBalancerCreateConfig(ctx);
  throw new Error(`Azure plugin: create not supported for type "${typeId}"`);
}
