/**
 * `createResource` dispatch — maps a plugin type-id to the matching
 * `create*` executor from the per-service `<service>-create-handlers.ts`
 * modules. Sibling of `create-config-dispatch.ts` and mirrors its branch
 * order, so the two tables stay easy to diff: every type-id that
 * `getAzureCreateConfig` renders a form for must have an executor here.
 *
 * The parameterized executors receive the same ARM provider path +
 * api-version used by `delete-handlers.ts` for the type.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { AzureCreateContext } from "./create-handlers-shared.js";
import { createAppRegistration } from "./app-registration-create-handlers.js";
import { createVM } from "./vm-create-handlers.js";
import { createAKSCluster } from "./aks-create-handlers.js";
import { createStorageAccount } from "./storage-account-create-handlers.js";
import { createCosmosDB } from "./cosmos-db-create-handlers.js";
import { createRedisCache } from "./redis-cache-create-handlers.js";
import { createFlexibleDB } from "./flexible-db-create-handlers.js";
import { createLogAnalyticsWorkspace } from "./log-analytics-create-handlers.js";
import { createSimpleResource } from "./simple-create-handlers.js";
import { createVNet } from "./vnet-create-handlers.js";
import { createKeyVault } from "./key-vault-create-handlers.js";
import { createContainerRegistry } from "./container-registry-create-handlers.js";
import { createResourceGroup } from "./resource-group-create-handlers.js";
import { createContainerInstance } from "./container-instance-create-handlers.js";
import { createMessagingNamespace } from "./messaging-namespace-create-handlers.js";
import { createPublicIP } from "./public-ip-create-handlers.js";
import { createDisk } from "./disk-create-handlers.js";
import { createAppService } from "./app-service-create-handlers.js";
import { createFunctionApp } from "./function-app-create-handlers.js";
import { createSQLDatabase } from "./sql-database-create-handlers.js";
import { createLoadBalancer } from "./load-balancer-create-handlers.js";

export async function createAzureResource(
  ctx: AzureCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  if (typeId === "azure-app-registration") return createAppRegistration(ctx, accountId, fields);
  if (typeId === "azure-vm") return createVM(ctx, accountId, fields);
  if (typeId === "azure-aks-cluster") return createAKSCluster(ctx, accountId, fields);
  if (typeId === "azure-storage-account") return createStorageAccount(ctx, accountId, fields);
  if (typeId === "azure-cosmos-db") return createCosmosDB(ctx, accountId, fields);
  if (typeId === "azure-redis-cache") return createRedisCache(ctx, accountId, fields);
  if (typeId === "azure-postgres-flexible") {
    return createFlexibleDB(
      ctx,
      accountId,
      fields,
      typeId,
      "Microsoft.DBforPostgreSQL/flexibleServers",
      "2023-06-01-preview",
    );
  }
  if (typeId === "azure-mysql-flexible") {
    return createFlexibleDB(
      ctx,
      accountId,
      fields,
      typeId,
      "Microsoft.DBforMySQL/flexibleServers",
      "2023-06-30",
    );
  }
  if (typeId === "azure-log-analytics") return createLogAnalyticsWorkspace(ctx, accountId, fields);
  if (typeId === "azure-managed-identity") {
    return createSimpleResource(
      ctx,
      accountId,
      typeId,
      fields,
      "Microsoft.ManagedIdentity/userAssignedIdentities",
      "2023-01-31",
      {},
    );
  }
  if (typeId === "azure-dns-zone") {
    // ARM rejects any location other than "global" for DNS zones.
    return createSimpleResource(
      ctx,
      accountId,
      typeId,
      { ...fields, region: "global" },
      "Microsoft.Network/dnszones",
      "2023-07-01-preview",
      {},
    );
  }
  if (typeId === "azure-vnet") return createVNet(ctx, accountId, fields);
  if (typeId === "azure-nsg") {
    return createSimpleResource(
      ctx,
      accountId,
      typeId,
      fields,
      "Microsoft.Network/networkSecurityGroups",
      "2023-09-01",
      {},
    );
  }
  if (typeId === "azure-key-vault") return createKeyVault(ctx, accountId, fields);
  if (typeId === "azure-container-registry") return createContainerRegistry(ctx, accountId, fields);
  if (typeId === "azure-resource-group") return createResourceGroup(ctx, accountId, fields);
  if (typeId === "azure-container-instance") return createContainerInstance(ctx, accountId, fields);
  if (typeId === "azure-service-bus") {
    return createMessagingNamespace(
      ctx,
      accountId,
      fields,
      typeId,
      "Microsoft.ServiceBus/namespaces",
      "2022-10-01-preview",
    );
  }
  if (typeId === "azure-event-hub") {
    return createMessagingNamespace(
      ctx,
      accountId,
      fields,
      typeId,
      "Microsoft.EventHub/namespaces",
      "2022-10-01-preview",
    );
  }
  if (typeId === "azure-public-ip") return createPublicIP(ctx, accountId, fields);
  if (typeId === "azure-disk") return createDisk(ctx, accountId, fields);
  if (typeId === "azure-app-service") return createAppService(ctx, accountId, fields);
  if (typeId === "azure-function-app") return createFunctionApp(ctx, accountId, fields);
  if (typeId === "azure-sql-database") return createSQLDatabase(ctx, accountId, fields);
  if (typeId === "azure-load-balancer") return createLoadBalancer(ctx, accountId, fields);
  throw new Error(`Azure plugin: createResource not supported for type "${typeId}"`);
}
