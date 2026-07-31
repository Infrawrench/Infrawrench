// Barrel for Azure resource listers, split by service domain.
// Re-exports keep the historical `./resource-listers.js` path stable.
export type { ListerContext } from "./resource-listers/shared.js";

export {
  listVMs,
  listDisks,
  listAKSClusters,
  listFunctionApps,
  listAppServices,
  listAppServicePlans,
  listContainerInstances,
  listContainerRegistries,
} from "./resource-listers/compute.js";
export {
  listVNets,
  listSubnets,
  listRouteTables,
  listNatGateways,
  listLoadBalancers,
  listNSGs,
  listPublicIPs,
  listAppGateways,
  listFirewalls,
} from "./resource-listers/networking.js";
export {
  listSQLDatabases,
  listCosmosDBAccounts,
  listRedisCaches,
  listPostgresFlexibleServers,
  listMySQLFlexibleServers,
} from "./resource-listers/database.js";
export { listStorageAccounts, listKeyVaults } from "./resource-listers/storage.js";
export { listServiceBusNamespaces, listEventHubNamespaces } from "./resource-listers/messaging.js";
export { listDNSZones, listPrivateDNSZones } from "./resource-listers/dns.js";
export {
  listResourceGroups,
  listLogAnalyticsWorkspaces,
  listManagedIdentities,
} from "./resource-listers/management.js";
