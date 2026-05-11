// Barrel module re-exporting per-service create handlers. The real
// implementations live in `<service>-create-handlers.ts` siblings; shared
// helpers and the `AzureCreateContext` interface live in
// `create-handlers-shared.ts`.

export { type AzureCreateContext } from "./create-handlers-shared.js";

export { getVMCreateConfig, createVM } from "./vm-create-handlers.js";
export { getAKSCreateConfig, createAKSCluster } from "./aks-create-handlers.js";
export {
  getStorageAccountCreateConfig,
  createStorageAccount,
} from "./storage-account-create-handlers.js";
export { getCosmosDBCreateConfig, createCosmosDB } from "./cosmos-db-create-handlers.js";
export { getRedisCacheCreateConfig, createRedisCache } from "./redis-cache-create-handlers.js";
export { getFlexibleDBCreateConfig, createFlexibleDB } from "./flexible-db-create-handlers.js";
export { getSQLDatabaseCreateConfig, createSQLDatabase } from "./sql-database-create-handlers.js";
export { getDiskCreateConfig, createDisk } from "./disk-create-handlers.js";
export { getAppServiceCreateConfig, createAppService } from "./app-service-create-handlers.js";
export { getFunctionAppCreateConfig, createFunctionApp } from "./function-app-create-handlers.js";
export {
  getContainerInstanceCreateConfig,
  createContainerInstance,
} from "./container-instance-create-handlers.js";
export {
  getMessagingNamespaceCreateConfig,
  createMessagingNamespace,
} from "./messaging-namespace-create-handlers.js";
export { getPublicIPCreateConfig, createPublicIP } from "./public-ip-create-handlers.js";
export {
  getLogAnalyticsCreateConfig,
  createLogAnalyticsWorkspace,
} from "./log-analytics-create-handlers.js";
export { getLoadBalancerCreateConfig } from "./load-balancer-create-handlers.js";
export { getSimpleCreateConfig, createSimpleResource } from "./simple-create-handlers.js";
export { getVNetCreateConfig, createVNet } from "./vnet-create-handlers.js";
export { getKeyVaultCreateConfig, createKeyVault } from "./key-vault-create-handlers.js";
export {
  getContainerRegistryCreateConfig,
  createContainerRegistry,
} from "./container-registry-create-handlers.js";
export { createAppRegistration } from "./app-registration-create-handlers.js";
export { createResourceGroup } from "./resource-group-create-handlers.js";
