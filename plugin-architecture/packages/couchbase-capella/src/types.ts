/** Wire shapes from the Capella Management API v4 OpenAPI document (2026-10). */

export interface Audit {
  createdBy?: string;
  createdAt?: string;
  modifiedBy?: string;
  modifiedAt?: string;
  version?: number;
}

export interface CpProject {
  id: string;
  name?: string;
  description?: string;
  audit?: Audit;
}

export interface CpServiceGroup {
  node?: {
    compute?: { cpu?: number; ram?: number };
    disk?: { type?: string; storage?: number; iops?: number; autoExpansion?: boolean };
  };
  numOfNodes?: number;
  services?: string[];
}

export interface CpCluster {
  id: string;
  appServiceId?: string;
  name?: string;
  description?: string;
  configurationType?: string;
  connectionString?: string;
  cloudProvider?: { type?: string; region?: string; cidr?: string };
  couchbaseServer?: { version?: string };
  serviceGroups?: CpServiceGroup[];
  availability?: { type?: string };
  support?: { plan?: string; timezone?: string };
  currentState?: string;
  audit?: Audit;
  deletionProtection?: boolean;
}

export interface CpAppService {
  id: string;
  name?: string;
  description?: string;
  cloudProvider?: string;
  nodes?: number;
  compute?: { cpu?: number; ram?: number };
  clusterId?: string;
  currentState?: string;
  version?: string;
  plan?: string;
  audit?: Audit;
}

export interface CpBucket {
  id: string;
  name?: string;
  type?: string;
  storageBackend?: string;
  memoryAllocationInMb?: number;
  bucketConflictResolution?: string;
  durabilityLevel?: string;
  replicas?: number;
  flush?: boolean;
  flushEnabled?: boolean;
  timeToLiveInSeconds?: number;
  evictionPolicy?: string;
  stats?: {
    itemCount?: number;
    opsPerSecond?: number;
    diskUsedInMib?: number;
    memoryUsedInMib?: number;
  };
}

export interface CpCredential {
  id: string;
  name?: string;
  audit?: Audit;
  access?: Array<{
    privileges?: string[];
    resources?: {
      buckets?: Array<{ name?: string; scopes?: Array<{ name?: string; collections?: string[] }> }>;
    };
  }>;
  userRoles?: string[];
}

export interface CpCidr {
  id: string;
  cidr?: string;
  comment?: string;
  expiresAt?: string;
  status?: string;
  type?: string;
  audit?: Audit;
}

export interface CpBackup {
  id: string;
  clusterID?: string;
  date?: string;
  restoreBefore?: string;
  status?: string;
  method?: string;
  bucketName?: string;
  bucketID?: string;
  source?: string;
  stats?: { sizeInMb?: number; items?: number };
  elapsedTimeInSeconds?: number;
}

export interface CpUser {
  id: string;
  name?: string;
  email?: string;
  status?: string;
  inactive?: boolean;
  organizationRoles?: string[];
  lastLogin?: string;
  resources?: Array<{ type?: string; id?: string; roles?: string[] }>;
  audit?: Audit;
}

export interface CpApiKey {
  id: string;
  name?: string;
  description?: string;
  expiry?: number;
  allowedCIDRs?: string[];
  organizationRoles?: string[];
  resources?: Array<{ type?: string; id?: string; roles?: string[] }>;
  audit?: Audit;
}

export interface CpBillingPeriod {
  startDate?: string;
  endDate?: string;
  categories?: Array<{
    category?: string;
    creditSpend?: number | null;
    currencySpend?: number | null;
  }>;
}

export interface CpBilling {
  data?: { periods?: CpBillingPeriod[]; billingCurrency?: string };
}
