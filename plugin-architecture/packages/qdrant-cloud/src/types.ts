/** The shapes of the Qdrant Cloud public API (protobuf JSON, lowerCamelCase), named from its documents. */
import type { ApiListItem, ApiResponse } from "@infrawrench/plugin-base";
import type { operations as accountOperations } from "./api-types.account.gen.js";
import type { operations as billingOperations } from "./api-types.billing.gen.js";
import type { operations as bookingOperations } from "./api-types.booking.gen.js";
import type {
  components as clusterAuthComponents,
  operations as clusterAuthOperations,
} from "./api-types.cluster-auth.gen.js";
import type { operations as clusterBackupOperations } from "./api-types.cluster-backup.gen.js";
import type {
  components as clusterComponents,
  operations as clusterOperations,
} from "./api-types.cluster.gen.js";
import type {
  components as databaseComponents,
  operations as databaseOperations,
} from "./api-types.database.gen.js";
import type { operations as hybridOperations } from "./api-types.hybrid.gen.js";
import type { operations as meteringOperations } from "./api-types.metering.gen.js";
import type { operations as monitoringOperations } from "./api-types.monitoring.gen.js";
import type { operations as platformOperations } from "./api-types.platform.gen.js";
import type { operations as quotaOperations } from "./api-types.quota.gen.js";

export type QcKeyValue = clusterComponents["schemas"]["v1KeyValue"];
export type QcAccount = ApiListItem<accountOperations["AccountService_ListAccounts"], "items">;
export type QcCluster = ApiListItem<clusterOperations["ClusterService_ListClusters"], "items">;
export type QcPackage = ApiListItem<bookingOperations["BookingService_ListPackages"], "items">;
export type QcCloudProvider = ApiListItem<
  platformOperations["PlatformService_ListCloudProviders"],
  "items"
>;
export type QcRegion = ApiListItem<
  platformOperations["PlatformService_ListCloudProviderRegions"],
  "items"
>;
export type QcRelease = ApiListItem<
  clusterOperations["ClusterService_ListQdrantReleases"],
  "items"
>;
export type QcAccessRule = clusterAuthComponents["schemas"]["v2AccessRule"];
export type QcDatabaseApiKey = ApiListItem<
  clusterAuthOperations["DatabaseApiKeyService_ListDatabaseApiKeys"],
  "items"
>;
export type QcBackup = ApiListItem<clusterBackupOperations["BackupService_ListBackups"], "items">;
export type QcBackupSchedule = ApiListItem<
  clusterBackupOperations["BackupService_ListBackupSchedules"],
  "items"
>;
export type QcBackupRestore = ApiListItem<
  clusterBackupOperations["BackupService_ListBackupRestores"],
  "items"
>;
export type QcHybridEnvironment = ApiListItem<
  hybridOperations["HybridCloudService_ListHybridCloudEnvironments"],
  "items"
>;
export type QcUsageMetrics = ApiResponse<
  monitoringOperations["MonitoringService_GetClusterUsageMetrics"]
>;
export type QcAlert = ApiListItem<
  monitoringOperations["MonitoringService_ListClusterAlerts"],
  "alerts"
>;
export type QcMeteringItem = ApiListItem<
  meteringOperations["MeteringService_ListMeterings"],
  "items"
>;
export type QcCreditContracts = ApiResponse<
  billingOperations["BillingService_ListCreditContracts"]
>;
export type QcQuotas = ApiResponse<quotaOperations["QuotaService_GetAccountQuotas"]>;

/** Qdrant database API (`<cluster>:6333`). */
export type QdbCollectionInfo = NonNullable<
  ApiResponse<databaseOperations["get_collection"]>["result"]
>;
export type QdbCollectionParamsDiff = databaseComponents["schemas"]["CollectionParamsDiff"];
export type QdbVectorsConfig = databaseComponents["schemas"]["VectorsConfig"];
export type QdbVectorParams = databaseComponents["schemas"]["VectorParams"];
