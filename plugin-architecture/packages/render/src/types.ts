/** Narrow shapes of the Render API payloads this plugin reads (spec 2026-10). */

export interface RenderOwner {
  id: string;
  name?: string;
  email?: string;
  type?: "user" | "team";
  twoFactorAuthEnabled?: boolean;
}

export interface RenderIpAllow {
  cidrBlock: string;
  description?: string;
}

export interface RenderAutoscaling {
  enabled: boolean;
  min: number;
  max: number;
  criteria?: {
    cpu?: { enabled: boolean; percentage: number };
    memory?: { enabled: boolean; percentage: number };
  };
}

export interface RenderServiceDetails {
  // static sites
  buildCommand?: string;
  publishPath?: string;
  // runtime services
  autoscaling?: RenderAutoscaling;
  disk?: { id: string; name: string; sizeGB: number; mountPath: string };
  env?: string;
  runtime?: string;
  envSpecificDetails?: {
    buildCommand?: string;
    startCommand?: string;
    preDeployCommand?: string;
    dockerCommand?: string;
    dockerContext?: string;
    dockerfilePath?: string;
  };
  healthCheckPath?: string;
  maintenanceMode?: { enabled: boolean; uri: string };
  numInstances?: number;
  openPorts?: Array<{ port: number; protocol: string }>;
  parentServer?: { id: string; name: string };
  plan?: string;
  preDeployCommand?: string;
  pullRequestPreviewsEnabled?: "yes" | "no";
  previews?: { generation?: "off" | "manual" | "automatic" };
  region?: string;
  sshAddress?: string;
  url?: string;
  buildPlan?: string;
  maxShutdownDelaySeconds?: number;
  // cron jobs
  schedule?: string;
  lastSuccessfulRunAt?: string;
}

export interface RenderService {
  id: string;
  name: string;
  type: "static_site" | "web_service" | "private_service" | "background_worker" | "cron_job";
  ownerId: string;
  slug?: string;
  repo?: string;
  branch?: string;
  rootDir?: string;
  imagePath?: string;
  autoDeploy?: "yes" | "no";
  autoDeployTrigger?: "commit" | "off" | "checksPass";
  suspended?: "suspended" | "not_suspended";
  suspenders?: string[];
  dashboardUrl?: string;
  environmentId?: string;
  notifyOnFail?: string;
  createdAt?: string;
  updatedAt?: string;
  serviceDetails?: RenderServiceDetails;
}

export interface RenderDeploy {
  id: string;
  commit?: { id?: string; message?: string; createdAt?: string };
  image?: { ref?: string; sha?: string };
  status?: string;
  trigger?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RenderEnvVar {
  key: string;
  value: string;
}

export interface RenderCustomDomain {
  id: string;
  name: string;
  domainType?: "apex" | "subdomain";
  publicSuffix?: string;
  redirectForName?: string;
  verificationStatus?: "verified" | "unverified";
  createdAt?: string;
  server?: { id?: string; name?: string };
}

export interface RenderMaintenance {
  id: string;
  type?: string;
  scheduledAt?: string;
  pendingMaintenanceBy?: string;
  state?: string;
  resourceId?: string;
}

export interface RenderPostgres {
  id: string;
  name: string;
  owner?: RenderOwner;
  plan?: string;
  region?: string;
  status?: string;
  version?: string;
  role?: "primary" | "replica";
  primaryPostgresID?: string;
  databaseName?: string;
  databaseUser?: string;
  diskSizeGB?: number;
  diskAutoscalingEnabled?: boolean;
  highAvailabilityEnabled?: boolean;
  connectionPool?: string;
  environmentId?: string;
  ipAllowList?: RenderIpAllow[];
  readReplicas?: Array<{ id: string; name: string }>;
  suspended?: "suspended" | "not_suspended";
  suspenders?: string[];
  expiresAt?: string;
  dashboardUrl?: string;
  maintenance?: RenderMaintenance;
  createdAt?: string;
  updatedAt?: string;
}

export interface RenderPostgresConnection {
  password?: string;
  internalConnectionString?: string;
  externalConnectionString?: string;
  internalConnectionPoolString?: string;
  externalConnectionPoolString?: string;
  psqlCommand?: string;
}

export interface RenderPostgresUser {
  username?: string;
  default?: boolean;
  createdAt?: string;
  openConnections?: number;
}

export interface RenderKeyValue {
  id: string;
  name: string;
  owner?: RenderOwner;
  plan?: string;
  region?: string;
  status?: string;
  version?: string;
  options?: { maxmemoryPolicy?: string; persistenceMode?: string };
  ipAllowList?: RenderIpAllow[];
  environmentId?: string;
  dashboardUrl?: string;
  maintenance?: RenderMaintenance;
  createdAt?: string;
  updatedAt?: string;
}

export interface RenderKeyValueConnection {
  internalConnectionString?: string;
  externalConnectionString?: string;
  cliCommand?: string;
}

export interface RenderDisk {
  id: string;
  name: string;
  sizeGB: number;
  mountPath: string;
  serviceId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RenderDiskSnapshot {
  createdAt?: string;
  snapshotKey?: string;
  instanceId?: string;
}

export interface RenderJob {
  id: string;
  serviceId: string;
  startCommand: string;
  planId?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RenderEnvGroup {
  id: string;
  name: string;
  ownerId: string;
  environmentId?: string;
  serviceLinks?: Array<{ id: string; name: string; type: string }>;
  envVars?: RenderEnvVar[];
  secretFiles?: Array<{ name: string; content: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface RenderBlueprint {
  id: string;
  name: string;
  status?: string;
  autoSync?: boolean;
  repo?: string;
  branch?: string;
  path?: string;
  lastSync?: string;
}

export interface RenderBlueprintSync {
  id: string;
  commit?: { id?: string };
  startedAt?: string;
  completedAt?: string;
  state?: string;
}

export interface RenderProject {
  id: string;
  name: string;
  owner?: RenderOwner;
  environmentIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface RenderEnvironment {
  id: string;
  name: string;
  projectId: string;
  serviceIds?: string[];
  databasesIds?: string[];
  redisIds?: string[];
  envGroupIds?: string[];
  protectedStatus?: "protected" | "unprotected";
  networkIsolationEnabled?: boolean;
  ipAllowList?: RenderIpAllow[];
}

export interface RenderMetricSeries {
  labels?: Array<{ field: string; value: string }>;
  values?: Array<{ timestamp: string; value: number }>;
  unit?: string;
}

export interface RenderLogLine {
  id?: string;
  message?: string;
  timestamp?: string;
  labels?: Array<{ name: string; value: string }>;
}
