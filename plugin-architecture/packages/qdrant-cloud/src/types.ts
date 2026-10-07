/** JSON shapes of the Qdrant Cloud public API (protobuf JSON, lowerCamelCase). Only what is read. */

export interface QcKeyValue {
  key?: string;
  value?: string;
}

export interface QcAccount {
  id: string;
  name?: string;
  ownerEmail?: string;
  createdAt?: string;
  privileges?: string[];
}

export interface QcNodeResources {
  base?: number;
  complimentary?: number;
  additional?: number;
  reserved?: number;
  available?: number;
}

export interface QcClusterConfiguration {
  numberOfNodes?: number;
  version?: string;
  packageId?: string;
  additionalResources?: { disk?: number };
  databaseConfiguration?: {
    collection?: {
      replicationFactor?: number;
      writeConsistencyFactor?: number;
      vectors?: { onDisk?: boolean };
    };
    inference?: { enabled?: boolean };
    auditLogging?: { enabled?: boolean };
    [k: string]: unknown;
  };
  allowedIpSourceRanges?: string[];
  restartPolicy?: string;
  rebalanceStrategy?: string;
  clusterStorageConfiguration?: { storageTierType?: string; [k: string]: unknown };
  reservedCpuPercentage?: number;
  reservedMemoryPercentage?: number;
  lastModifiedAt?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface QcClusterNode {
  name?: string;
  startedAt?: string;
  version?: string;
  state?: string;
  availabilityZone?: string;
  notReadyInfo?: { conditionMessage?: string; reasonMessage?: string };
}

export interface QcClusterState {
  version?: string;
  nodesUp?: number;
  restartedAt?: string;
  phase?: string;
  reason?: string;
  endpoint?: { url?: string; restPort?: number; grpcPort?: number };
  resources?: {
    cpu?: QcNodeResources;
    ram?: QcNodeResources;
    disk?: QcNodeResources;
    gpu?: QcNodeResources;
  };
  nodes?: QcClusterNode[];
  jwtRbac?: boolean;
}

export interface QcCluster {
  id: string;
  createdAt?: string;
  accountId?: string;
  name: string;
  deletedAt?: string;
  cloudProviderId?: string;
  cloudProviderRegionId?: string;
  labels?: QcKeyValue[];
  costAllocationLabel?: string;
  configuration?: QcClusterConfiguration;
  state?: QcClusterState;
}

export interface QcPackage {
  id: string;
  name?: string;
  type?: string;
  resourceConfiguration?: { ram?: string; cpu?: string; disk?: string; gpu?: string };
  currency?: string;
  unitIntPricePerHour?: number;
  status?: string;
  tier?: string;
  multiAz?: boolean;
  availableAdditionalResources?: { diskPricePerHour?: number };
}

export interface QcCloudProvider {
  id: string;
  name?: string;
  available?: boolean;
  freeTier?: boolean;
}

export interface QcRegion {
  id: string;
  name?: string;
  available?: boolean;
  provider?: string;
  countryIsoCode?: string;
  geographicalSubRegion?: string;
}

export interface QcRelease {
  version: string;
  default?: boolean;
  endOfLife?: boolean;
  unavailable?: boolean;
  releaseNotesUrl?: string;
}

export interface QcAccessRule {
  globalAccess?: { accessType?: string };
  collectionAccess?: { collectionName?: string; accessType?: string };
}

export interface QcDatabaseApiKey {
  id: string;
  accountId?: string;
  createdAt?: string;
  clusterId?: string;
  name?: string;
  expiresAt?: string;
  accessRules?: QcAccessRule[];
  createdByEmail?: string;
  postfix?: string;
  key?: string;
  createdByActorType?: string;
}

export interface QcBackup {
  id: string;
  createdAt?: string;
  accountId?: string;
  clusterId?: string;
  name?: string;
  status?: string;
  deletedAt?: string;
  backupDuration?: string;
  backupScheduleId?: string;
  retentionPeriod?: string;
  clusterInfo?: {
    name?: string;
    cloudProviderId?: string;
    cloudProviderRegionId?: string;
    restorePackageId?: string;
    resourcesSummary?: { disk?: { amount?: number; unit?: string } };
  };
  displayName?: string;
  price?: { currency?: string; discountedPricePerMonth?: string };
}

export interface QcBackupSchedule {
  id: string;
  createdAt?: string;
  accountId?: string;
  clusterId?: string;
  schedule?: string;
  retentionPeriod?: string;
  status?: string;
  displayName?: string;
}

export interface QcBackupRestore {
  id: string;
  createdAt?: string;
  clusterId?: string;
  backupId?: string;
  status?: string;
}

export interface QcHybridEnvironment {
  id: string;
  accountId?: string;
  name: string;
  createdAt?: string;
  createdByEmail?: string;
  bootstrapCommandsGenerated?: boolean;
  configuration?: { namespace?: string; [k: string]: unknown };
  status?: {
    phase?: string;
    kubernetesVersion?: string;
    kubernetesDistribution?: string;
    numberOfNodes?: number;
    clusterCreationReadiness?: string;
    message?: string;
  };
}

export interface QcMetric {
  timestamp?: string;
  value?: number;
}

export interface QcUsageMetrics {
  cpu?: QcMetric[];
  ram?: QcMetric[];
  ramCache?: QcMetric[];
  ramRss?: QcMetric[];
  ramQdrantRss?: QcMetric[];
  disk?: QcMetric[];
  rps?: QcMetric[];
  latency?: QcMetric[];
  gpu?: QcMetric[];
  gpuRam?: QcMetric[];
}

export interface QcAlert {
  id?: string;
  type?: string;
  severity?: string;
  title?: string;
  description?: string;
  lastFiringAt?: string;
  state?: string;
}

export interface QcMeteringItem {
  clusterId?: string;
  clusterName?: string;
  startTime?: string;
  endTime?: string;
  billableEntityType?: string;
  billableEntityReferenceName?: string;
  usageHours?: number;
  amountMillicents?: string;
  discountAmountMillicents?: string;
  currency?: string;
  clusterLabels?: Record<string, string>;
}

export interface QcCreditContract {
  id: string;
  totalAmount?: number;
  currency?: string;
  activeFrom?: string;
  activeTo?: string;
  usedAmount?: number;
  remainingAmount?: number;
  exhaustedAt?: string;
}

export interface QcQuotas {
  maxClusters?: number;
  maxClusterNodes?: number;
  maxClusterDatabaseApiKeys?: number;
  maxFreeTierClusters?: number;
}

/** Qdrant database API (`<cluster>:6333`). */
export interface QdbCollectionInfo {
  status?: string;
  optimizer_status?: unknown;
  indexed_vectors_count?: number | null;
  points_count?: number | null;
  segments_count?: number;
  config?: {
    params?: {
      vectors?:
        { size?: number; distance?: string } | Record<string, { size?: number; distance?: string }>;
      shard_number?: number;
      replication_factor?: number;
      write_consistency_factor?: number;
      on_disk_payload?: boolean;
    };
  };
}
