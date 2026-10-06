/** Narrow shapes of the Railway GraphQL payloads this plugin reads (schema 2026-10). */

export interface Conn<T> {
  edges?: Array<{ node?: T | null } | null>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}

export interface RwWorkspaceRef {
  id: string;
  name: string;
}

export interface RwWorkspace {
  id: string;
  name: string;
  plan?: string;
  has2FAEnforcement?: boolean;
  preferredRegion?: string | null;
  createdAt?: string;
  members?: Array<{
    id: string;
    name?: string | null;
    email: string;
    role?: string;
    twoFactorAuthEnabled?: boolean | null;
  }>;
}

export interface RwCustomer {
  id: string;
  creditBalance?: number;
  currentUsage?: number;
  billingPeriod?: { start?: string; end?: string };
  usageLimit?: { softLimit?: number; hardLimit?: number | null; isOverLimit?: boolean } | null;
}

export interface RwDeployment {
  id: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  url?: string | null;
  staticUrl?: string | null;
  canRedeploy?: boolean;
  canRollback?: boolean;
  deploymentStopped?: boolean;
  /** Free-form JSON: commitHash, commitMessage, branch, image, reason, … */
  meta?: Record<string, unknown> | null;
  serviceId?: string | null;
  environmentId?: string;
  projectId?: string;
}

export interface RwServiceDomain {
  id: string;
  domain: string;
  suffix?: string | null;
  targetPort?: number | null;
  syncStatus?: string;
  createdAt?: string | null;
}

export interface RwCustomDomain {
  id: string;
  domain: string;
  targetPort?: number | null;
  syncStatus?: string;
  createdAt?: string | null;
  status?: {
    verified?: boolean;
    certificateStatus?: string;
    certificateErrorMessage?: string | null;
    certificates?: Array<{ expiresAt?: string | null }> | null;
    dnsRecords?: Array<{
      hostlabel?: string;
      fqdn?: string;
      recordType?: string;
      requiredValue?: string;
      currentValue?: string;
      status?: string;
    }>;
  };
}

export interface RwServiceInstance {
  id: string;
  serviceId: string;
  serviceName: string;
  environmentId: string;
  region?: string | null;
  numReplicas?: number | null;
  startCommand?: string | null;
  buildCommand?: string | null;
  builder?: string;
  dockerfilePath?: string | null;
  rootDirectory?: string | null;
  railwayConfigFile?: string | null;
  healthcheckPath?: string | null;
  healthcheckTimeout?: number | null;
  cronSchedule?: string | null;
  nextCronRunAt?: string | null;
  sleepApplication?: boolean | null;
  restartPolicyType?: string;
  restartPolicyMaxRetries?: number;
  preDeployCommand?: unknown;
  createdAt?: string;
  updatedAt?: string;
  source?: { repo?: string | null; image?: string | null } | null;
  domains?: { serviceDomains?: RwServiceDomain[]; customDomains?: RwCustomDomain[] };
  latestDeployment?: RwDeployment | null;
}

export interface RwVolumeInstance {
  id: string;
  volumeId: string;
  serviceId?: string | null;
  environmentId: string;
  mountPath: string;
  sizeMB: number;
  currentSizeMB?: number;
  state?: string | null;
  region?: string | null;
  createdAt?: string;
  isPendingDeletion?: boolean;
  volume?: { id: string; name: string };
}

export interface RwEnvironment {
  id: string;
  name: string;
  isEphemeral?: boolean;
  createdAt?: string;
  updatedAt?: string;
  serviceInstances?: Conn<RwServiceInstance>;
  volumeInstances?: Conn<RwVolumeInstance>;
}

export interface RwProject {
  id: string;
  name: string;
  description?: string | null;
  isPublic?: boolean;
  prDeploys?: boolean;
  workspaceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  services?: Conn<{ id: string; name: string; icon?: string | null; createdAt?: string }>;
  environments?: Conn<RwEnvironment>;
}

export interface RwTcpProxy {
  id: string;
  domain: string;
  proxyPort: number;
  applicationPort: number;
  serviceId: string;
  environmentId: string;
  syncStatus?: string;
  createdAt?: string | null;
}

export interface RwRegion {
  name: string;
  region?: string | null;
  country?: string;
  location?: string;
  deploymentConstraints?: { deprecationInfo?: { isDeprecated?: boolean } | null } | null;
}

export interface RwBackup {
  id: string;
  name?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
  usedMB?: number | null;
  referencedMB?: number | null;
}

export interface RwBackupSchedule {
  id: string;
  kind: string;
  name: string;
  cron: string;
  retentionSeconds?: number | null;
}

export interface RwLog {
  timestamp: string;
  message: string;
  severity?: string | null;
}

export interface RwHttpLog {
  timestamp: string;
  method?: string;
  path?: string;
  httpStatus?: number;
  totalDuration?: number;
  host?: string;
  srcIp?: string;
  edgeRegion?: string;
}

/** The flattened inventory the listers share: one walk of every project. */
export interface Tree {
  workspaces: RwWorkspaceRef[];
  projects: Array<{ project: RwProject; workspace: RwWorkspaceRef | null }>;
}
