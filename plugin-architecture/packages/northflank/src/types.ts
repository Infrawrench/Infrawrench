/**
 * The slices of Northflank API objects this plugin reads. Every field is
 * optional: the API omits empty ones, and mappers must cope with partial
 * objects (listings carry far less than the single-object GETs).
 */

export interface NfAuth {
  tokenKind?: string;
  id?: string;
  name?: string;
  description?: string;
  entityId?: string;
  entityType?: "team" | "org" | string;
  orgId?: string;
  role?: { name?: string; roleId?: string };
  creatorEmail?: string;
  createdAt?: string;
  expiresAt?: string | null;
}

export interface NfTeam {
  id?: string;
  uid?: string;
  name?: string;
  description?: string;
}

export interface NfProject {
  id?: string;
  uid?: string;
  name?: string;
  description?: string;
  color?: string;
  createdAt?: string;
  deployment?: { region?: string };
  cluster?: { id?: string; name?: string; namespace?: string };
  services?: Array<{ id?: string; name?: string; serviceType?: string }>;
  jobs?: Array<{ id?: string; name?: string; jobType?: string }>;
  addons?: Array<{ id?: string; name?: string }>;
}

export interface NfStatus {
  build?: { status?: string; lastTransitionTime?: string };
  deployment?: { status?: string; reason?: string; lastTransitionTime?: string };
}

export interface NfService {
  id?: string;
  uid?: string;
  appId?: string;
  projectId?: string;
  name?: string;
  description?: string;
  tags?: string[];
  serviceType?: "combined" | "build" | "deployment" | string;
  disabledCI?: boolean;
  disabledCD?: boolean;
  status?: NfStatus;
  billing?: { deploymentPlan?: string; buildPlan?: string };
  deployment?: {
    instances?: number;
    type?: string;
    imageUrl?: string;
    external?: { imagePath?: string; credentials?: string };
    internal?: { id?: string; branch?: string; buildSHA?: string };
  };
  vcsData?: { projectUrl?: string; projectType?: string; projectBranch?: string };
  ports?: NfPort[];
  cluster?: { id?: string; name?: string };
  createdAt?: string;
  updatedAt?: string;
}

export interface NfPort {
  id?: string;
  name?: string;
  internalPort?: number;
  protocol?: string;
  public?: boolean;
  dns?: string;
  domains?: Array<{ name?: string; certificate?: { expiryDate?: string } }>;
}

export interface NfJob {
  id?: string;
  uid?: string;
  projectId?: string;
  name?: string;
  description?: string;
  tags?: string[];
  jobType?: "manual" | "cron" | string;
  disabledCI?: boolean;
  disabledCD?: boolean;
  suspended?: boolean;
  createdAt?: string;
  billing?: { deploymentPlan?: string; buildPlan?: string };
  settings?: {
    cron?: { schedule?: string; concurrencyPolicy?: string };
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
  };
  deployment?: {
    external?: { imagePath?: string };
    internal?: { id?: string; branch?: string };
    region?: string;
  };
  vcsData?: { projectUrl?: string; projectBranch?: string };
}

export interface NfJobRun {
  id?: string;
  runName?: string;
  status?: string;
  concluded?: boolean;
  startedAt?: string;
  concludedAt?: string;
}

export interface NfAddon {
  id?: string;
  uid?: string;
  name?: string;
  description?: string;
  tags?: string[];
  status?: string;
  createdAt?: string;
  spec?: {
    type?: string;
    config?: {
      versionTag?: string;
      lifecycleStatus?: string;
      deployment?: {
        replicas?: number;
        storageClass?: string;
        storageSize?: number;
        planId?: string;
        region?: string;
      };
      networking?: {
        tlsEnabled?: boolean;
        externalAccessEnabled?: boolean;
        vpcAccessible?: boolean;
      };
    };
    pendingActions?: Array<{ type?: string }>;
  };
  cluster?: { id?: string; name?: string };
}

export interface NfAddonType {
  type?: string;
  name?: string;
  description?: string;
  versions?: string[];
  major?: string[];
  features?: Record<string, boolean>;
  resources?: {
    storage?: { options?: number[]; default?: number };
    replicas?: { options?: number[]; default?: number };
  };
}

export interface NfSecretGroup {
  id?: string;
  projectId?: string;
  name?: string;
  description?: string;
  tags?: string[];
  type?: string;
  secretType?: string;
  priority?: number;
  restrictions?: { restricted?: boolean };
  createdAt?: string;
  updatedAt?: string;
  secrets?: { variables?: Record<string, string>; files?: Record<string, unknown> };
}

export interface NfVolume {
  id?: string;
  uid?: string;
  name?: string;
  tags?: string[];
  spec?: { accessMode?: string; storageClassName?: string; storageSize?: number };
  attachedObjects?: Array<{ id?: string; type?: string }>;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NfPipeline {
  id?: string;
  name?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  nfObjects?: Array<{ id?: string; type?: string; stage?: string }>;
}

export interface NfDomain {
  name?: string;
  status?: string;
  hostname?: string;
  token?: string;
  subdomains?: Array<{ name?: string; fullName?: string }>;
  certificates?: { mode?: string; status?: { expiryDate?: string } };
  redirect?: { mode?: string; target?: { record?: string } };
}

export interface NfSubdomain {
  name?: string;
  fullName?: string;
  recordType?: string;
  content?: string;
  verified?: boolean;
  routingMode?: string;
  certificate?: { inProgress?: boolean; expiryDate?: string };
  cdn?: { northflank?: { enabled?: boolean } };
}

export interface NfCluster {
  id?: string;
  name?: string;
  description?: string;
  provider?: string;
  region?: string;
  status?: { state?: { state?: string; reason?: string } };
  nodePools?: Array<{
    id?: string;
    nodeType?: string;
    nodeCount?: number;
    autoscaling?: { enabled?: boolean; min?: number; max?: number };
  }>;
  createdAt?: string;
  updatedAt?: string;
  deletionRequested?: boolean;
}

export interface NfNode {
  nodeId?: string;
  nodeName?: string;
  nodePool?: string;
  status?: string;
  zone?: string;
  instanceType?: string;
  createdAt?: string;
}

export interface NfPlan {
  id?: string;
  name?: string;
  currency?: string;
  amountPerMonth?: number;
  amountPerHour?: number;
  cpuResource?: number;
  ramResource?: number;
}

export interface NfRegion {
  id?: string;
  name?: string;
  regionName?: string;
}

export interface NfBuild {
  id?: string;
  branch?: string;
  sha?: string;
  status?: string;
  concluded?: boolean;
  success?: boolean;
  createdAt?: string;
  message?: string;
}

export interface NfDeployment {
  id?: string;
  name?: string;
  createdAt?: string;
  active?: boolean;
  releaseType?: string;
  instances?: number;
  image?: { imagePath?: string; image?: string; tag?: string; sha?: string };
  commit?: { sha?: string; message?: string; author?: string };
}

export interface NfBackup {
  id?: string;
  name?: string;
  status?: string;
  createdAt?: string;
  completedAt?: string;
  config?: { source?: { type?: string }; size?: string; addonVersion?: string };
}

export interface NfUsageSlice {
  price?: Record<string, number | undefined>;
  usage?: Record<string, unknown>;
}

export interface NfUsageEntry {
  timestamp?: number;
  currency?: string;
  total?: number;
  paas?: NfUsageSlice;
  byoc?: NfUsageSlice;
  egressIp?: NfUsageSlice;
  loadBalancer?: NfUsageSlice;
}

export interface NfInvoice {
  id?: string;
  period?: { start?: number; end?: number };
  currency?: string;
  status?: string;
  total?: number;
  subTotal?: number;
}

export interface NfLogLine {
  containerId?: string;
  log?: unknown;
  ts?: string;
}

export interface NfMetricBlock {
  metricInfo?: { metricId?: string; metricUnit?: string };
  values?: Array<{
    metadata?: { containerId?: string };
    data?: Array<{ value?: number; ts?: string }>;
  }>;
}
