// Barrel module re-exporting per-service create-config helpers. The real
// implementations live in `<service>-create-handlers.ts` siblings; shared
// helpers and the `AzureCreateContext` interface live in
// `create-handlers-shared.ts`. The `create*` executors are exported directly
// from their per-service modules (and exercised by the test suite there).

export { type AzureCreateContext } from "./create-handlers-shared.js";

export { getVMCreateConfig } from "./vm-create-handlers.js";
export { getAKSCreateConfig } from "./aks-create-handlers.js";
export { getStorageAccountCreateConfig } from "./storage-account-create-handlers.js";
export { getCosmosDBCreateConfig } from "./cosmos-db-create-handlers.js";
export { getRedisCacheCreateConfig } from "./redis-cache-create-handlers.js";
export { getFlexibleDBCreateConfig } from "./flexible-db-create-handlers.js";
export { getSQLDatabaseCreateConfig } from "./sql-database-create-handlers.js";
export { getDiskCreateConfig } from "./disk-create-handlers.js";
export { getAppServiceCreateConfig } from "./app-service-create-handlers.js";
export { getFunctionAppCreateConfig } from "./function-app-create-handlers.js";
export { getContainerInstanceCreateConfig } from "./container-instance-create-handlers.js";
export { getMessagingNamespaceCreateConfig } from "./messaging-namespace-create-handlers.js";
export { getPublicIPCreateConfig } from "./public-ip-create-handlers.js";
export { getLogAnalyticsCreateConfig } from "./log-analytics-create-handlers.js";
export { getLoadBalancerCreateConfig } from "./load-balancer-create-handlers.js";
export { getSimpleCreateConfig } from "./simple-create-handlers.js";
export { getVNetCreateConfig } from "./vnet-create-handlers.js";
export { getKeyVaultCreateConfig } from "./key-vault-create-handlers.js";
export { getContainerRegistryCreateConfig } from "./container-registry-create-handlers.js";
