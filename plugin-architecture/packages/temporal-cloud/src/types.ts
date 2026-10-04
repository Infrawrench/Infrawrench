/**
 * Cloud Ops API response shapes: the fields this plugin reads, verified
 * against the published OpenAPI document (`https://saas-api.tmprl.cloud/spec.json`,
 * v0.22.0) and the protobuf sources in `temporalio/cloud-api` (2026-10).
 */

export interface TcAccess {
  accountAccess?: { role?: string; customRoles?: string[] };
  namespaceAccesses?: Record<string, { permission?: string }>;
  projectAccesses?: Record<string, { role?: string }>;
}

export interface TcNamespace {
  namespace?: string;
  resourceVersion?: string;
  state?: string;
  asyncOperationId?: string;
  activeRegion?: string;
  projectId?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  tags?: Record<string, string>;
  endpoints?: { webAddress?: string; mtlsGrpcAddress?: string; grpcAddress?: string };
  limits?: { actionsPerSecondLimit?: number };
  regionStatus?: Record<string, { state?: string; asyncOperationId?: string }>;
  replicas?: Array<{ id?: string; region?: string; isPrimary?: boolean; state?: string }>;
  capacity?: {
    onDemand?: Record<string, unknown>;
    provisioned?: { currentValue?: number };
  };
  privateConnectivities?: Array<{
    region?: string;
    awsPrivateLink?: { vpcEndpointServiceNames?: string[]; allowedPrincipalArns?: string[] };
  }>;
  spec?: TcNamespaceSpec;
}

export interface TcNamespaceSpec {
  name?: string;
  description?: string;
  regions?: string[];
  retentionDays?: number;
  mtlsAuth?: {
    acceptedClientCa?: string;
    enabled?: boolean;
    certificateFilters?: Array<Record<string, string>>;
  };
  apiKeyAuth?: { enabled?: boolean };
  codecServer?: {
    endpoint?: string;
    passAccessToken?: boolean;
    includeCrossOriginCredentials?: boolean;
  };
  searchAttributes?: Record<string, string>;
  lifecycle?: { enableDeleteProtection?: boolean };
  highAvailability?: { disableManagedFailover?: boolean };
  connectivityRuleIds?: string[];
  fairness?: { taskQueueFairnessEnabled?: boolean };
  capacitySpec?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TcUser {
  id?: string;
  resourceVersion?: string;
  state?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  invitation?: { createdTime?: string; expiredTime?: string };
  spec?: { email?: string; access?: TcAccess };
}

export interface TcServiceAccount {
  id?: string;
  resourceVersion?: string;
  state?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  spec?: {
    name?: string;
    description?: string;
    access?: TcAccess;
    namespaceScopedAccess?: { namespace?: string; access?: { permission?: string } };
  };
}

export interface TcApiKey {
  id?: string;
  resourceVersion?: string;
  state?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  spec?: {
    ownerId?: string;
    ownerType?: string;
    displayName?: string;
    description?: string;
    expiryTime?: string;
    disabled?: boolean;
  };
}

export interface TcNexusEndpoint {
  id?: string;
  resourceVersion?: string;
  state?: string;
  projectId?: string;
  createdTime?: string;
  lastModifiedTime?: string;
  spec?: {
    name?: string;
    description?: { data?: string; metadata?: Record<string, string> };
    targetSpec?: { workerTargetSpec?: { namespaceId?: string; taskQueue?: string } };
    policySpecs?: Array<{ allowedCloudNamespacePolicySpec?: { namespaceId?: string } }>;
  };
}

export interface TcExportSink {
  name?: string;
  resourceVersion?: string;
  state?: string;
  health?: string;
  errorMessage?: string;
  latestDataExportTime?: string;
  lastHealthCheckTime?: string;
  spec?: {
    name?: string;
    enabled?: boolean;
    s3?: {
      roleName?: string;
      bucketName?: string;
      region?: string;
      kmsArn?: string;
      awsAccountId?: string;
    };
    gcs?: { saId?: string; bucketName?: string; gcpProjectId?: string; region?: string };
    azureBlob?: Record<string, string>;
  };
}

export interface TcConnectivityRule {
  id?: string;
  resourceVersion?: string;
  state?: string;
  projectId?: string;
  createdTime?: string;
  spec?: {
    publicRule?: { enableStableIps?: boolean };
    privateRule?: {
      connectionId?: string;
      region?: string;
      gcpProjectId?: string;
      azurePeResourceId?: string;
    };
  };
}

export interface TcRegion {
  id?: string;
  cloudProvider?: string;
  cloudProviderRegion?: string;
  location?: string;
}

export interface TcAccount {
  id?: string;
  state?: string;
  resourceVersion?: string;
  metrics?: { uri?: string };
  spec?: { metrics?: { acceptedClientCa?: string } };
}

export interface TcCapacityInfo {
  namespace?: string;
  hasLegacyLimits?: boolean;
  stats?: { aps?: { mean?: number; p90?: number; p99?: number } };
  modeOptions?: {
    provisioned?: { validTruValues?: number[]; maxAvailableTruValue?: number };
    onDemand?: { apsLimit?: number };
  };
}
