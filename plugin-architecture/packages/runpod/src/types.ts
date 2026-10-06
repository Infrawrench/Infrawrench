/**
 * The slice of Runpod payloads this plugin reads. REST field names are from
 * the published OpenAPI document (`https://rest.runpod.io/v1/openapi.json`),
 * GraphQL names from the public schema reference
 * (`https://graphql-spec.runpod.io`), both checked 2026-10. Everything is
 * optional because the spec marks almost nothing required.
 */

export interface RpGpuInfo {
  id?: string;
  count?: number;
  displayName?: string;
}

export interface RpMachine {
  gpuTypeId?: string;
  gpuType?: RpGpuInfo;
  cpuTypeId?: string;
  cpuType?: { id?: string; displayName?: string };
  location?: string;
  dataCenterId?: string;
  secureCloud?: boolean;
  supportPublicIp?: boolean;
  maintenanceStart?: string;
  maintenanceEnd?: string;
  maintenanceNote?: string;
  gpuDisplayName?: string;
}

export interface RpSavingsPlan {
  id?: string;
  costPerHr?: number;
  startTime?: string;
  endTime?: string;
  gpuTypeId?: string;
  podId?: string;
}

export interface RpPod {
  id: string;
  name?: string;
  desiredStatus?: "RUNNING" | "EXITED" | "TERMINATED" | string;
  image?: string;
  imageName?: string;
  costPerHr?: number;
  adjustedCostPerHr?: number;
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  memoryInGb?: number;
  vcpuCount?: number;
  gpu?: RpGpuInfo;
  cpuFlavorId?: string;
  interruptible?: boolean;
  locked?: boolean;
  templateId?: string;
  containerRegistryAuthId?: string;
  networkVolumeId?: string;
  networkVolume?: { id?: string; name?: string; size?: number; dataCenterId?: string };
  endpointId?: string;
  machineId?: string;
  machine?: RpMachine;
  publicIp?: string;
  portMappings?: Record<string, number>;
  ports?: string[];
  env?: Record<string, string>;
  lastStartedAt?: string;
  lastStatusChange?: string;
  savingsPlans?: RpSavingsPlan[];
  volumeEncrypted?: boolean;
}

/** GraphQL extras merged into each pod: runtime telemetry and the SSH proxy host id. */
export interface RpPodExtras {
  id: string;
  createdAt?: string;
  machine?: { podHostId?: string; dataCenterId?: string; secureCloud?: boolean };
  runtime?: {
    uptimeInSeconds?: number;
    container?: { cpuPercent?: number; memoryPercent?: number };
    gpus?: Array<{ id?: string; gpuUtilPercent?: number; memoryUtilPercent?: number }>;
  } | null;
}

export interface RpTemplate {
  id: string;
  name?: string;
  imageName?: string;
  category?: string;
  isServerless?: boolean;
  isPublic?: boolean;
  isRunpod?: boolean;
  containerDiskInGb?: number;
  volumeInGb?: number;
  volumeMountPath?: string;
  ports?: string[];
  env?: Record<string, string>;
  dockerStartCmd?: string[];
  dockerEntrypoint?: string[];
  containerRegistryAuthId?: string;
  readme?: string;
  earned?: number;
  runtimeInMin?: number;
}

export interface RpEndpoint {
  id: string;
  name?: string;
  templateId?: string;
  template?: RpTemplate;
  computeType?: "GPU" | "CPU" | string;
  gpuTypeIds?: string[];
  gpuCount?: number;
  instanceIds?: string[];
  dataCenterIds?: string[];
  workersMin?: number;
  workersMax?: number;
  idleTimeout?: number;
  scalerType?: string;
  scalerValue?: number;
  executionTimeoutMs?: number;
  flashboot?: boolean;
  networkVolumeId?: string;
  networkVolumeIds?: string[];
  allowedCudaVersions?: string[];
  version?: number;
  createdAt?: string;
}

export interface RpEndpointHealth {
  jobs?: {
    completed?: number;
    failed?: number;
    inProgress?: number;
    inQueue?: number;
    retried?: number;
  };
  workers?: {
    idle?: number;
    running?: number;
    initializing?: number;
    ready?: number;
    throttled?: number;
    unhealthy?: number;
  };
}

export interface RpNetworkVolume {
  id: string;
  name?: string;
  size?: number;
  dataCenterId?: string;
}

export interface RpRegistryAuth {
  id: string;
  name?: string;
}

export interface RpBillingRecord {
  amount?: number;
  time?: string;
  podId?: string;
  endpointId?: string;
  gpuTypeId?: string;
  timeBilledMs?: number;
  diskSpaceBilledGb?: number;
  highPerformanceStorageAmount?: number;
  highPerformanceStorageDiskSpaceBilledGb?: number;
}

export interface RpGpuType {
  id: string;
  displayName?: string;
  memoryInGb?: number;
  manufacturer?: string;
  secureCloud?: boolean;
  communityCloud?: boolean;
  securePrice?: number | null;
  communityPrice?: number | null;
  secureSpotPrice?: number | null;
  communitySpotPrice?: number | null;
  maxGpuCount?: number | null;
  lowestPrice?: {
    stockStatus?: string | null;
    uninterruptablePrice?: number | null;
    minimumBidPrice?: number | null;
  } | null;
}

export interface RpDataCenter {
  id: string;
  name?: string;
  location?: string;
  storageSupport?: boolean;
  listed?: boolean;
  gpuAvailability?: Array<{ gpuTypeId?: string; available?: boolean; stockStatus?: string | null }>;
}

export interface RpMyself {
  id?: string;
  email?: string;
  clientBalance?: number | null;
  currentSpendPerHr?: number | null;
  spendLimit?: number | null;
  maxServerlessConcurrency?: number | null;
  underBalance?: boolean | null;
  pubKey?: string | null;
  savingsPlans?: Array<
    RpSavingsPlan & {
      upfrontCost?: number | null;
      planLength?: string | null;
      savingsPlanType?: string | null;
    }
  > | null;
}
