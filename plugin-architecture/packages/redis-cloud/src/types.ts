/**
 * Wire shapes for the parts of the Redis Cloud API this plugin reads. The
 * published OpenAPI document leaves most response schemas as bare objects
 * with an example attached, so these follow the examples plus the official
 * Go client (`RedisLabs/rediscloud-go-api`), which models the same payloads.
 * Every field is optional: a missing one renders as absent, never as zero.
 */

export interface RcPricing {
  type?: string | undefined;
  typeDetails?: string | undefined;
  quantity?: number | undefined;
  quantityMeasurement?: string | undefined;
  pricePerUnit?: number | undefined;
  priceCurrency?: string | undefined;
  /** `hour` for shard/storage lines, `Month` for flat ones. */
  pricePeriod?: string | undefined;
  region?: string | undefined;
}

export interface RcCloudRegion {
  region?: string | undefined;
  networking?: Array<{ deploymentCIDR?: string; vpcId?: string; subnetId?: string }>;
  preferredAvailabilityZones?: string[] | undefined;
  multipleAvailabilityZones?: boolean | undefined;
}

export interface RcCloudDetail {
  provider?: string | undefined;
  cloudAccountId?: number | undefined;
  awsAccountId?: string | undefined;
  totalSizeInGb?: number | undefined;
  regions?: RcCloudRegion[] | undefined;
}

/** A Pro (flexible) subscription. */
export interface RcProSubscription {
  id?: number | undefined;
  name?: string | undefined;
  status?: string | undefined;
  deploymentType?: string | undefined;
  paymentMethodId?: number | undefined;
  paymentMethodType?: string | undefined;
  memoryStorage?: string | undefined;
  storageEncryption?: boolean | undefined;
  numberOfDatabases?: number | undefined;
  publicEndpointAccess?: boolean | undefined;
  prometheusEndpoint?: string | undefined;
  subscriptionPricing?: RcPricing[] | undefined;
  cloudDetails?: RcCloudDetail[] | undefined;
}

/** An Essentials (fixed) subscription. */
export interface RcEssentialsSubscription {
  id?: number | undefined;
  name?: string | undefined;
  status?: string | undefined;
  paymentMethodId?: number | undefined;
  paymentMethodType?: string | undefined;
  planId?: number | undefined;
  planName?: string | undefined;
  planType?: string | undefined;
  size?: number | undefined;
  sizeMeasurementUnit?: string | undefined;
  provider?: string | undefined;
  region?: string | undefined;
  price?: number | undefined;
  pricePeriod?: string | undefined;
  priceCurrency?: string | undefined;
  maximumDatabases?: number | undefined;
  availability?: string | undefined;
  connections?: string | undefined;
  cidrAllowRules?: number | undefined;
  supportDataPersistence?: boolean | undefined;
  supportInstantAndDailyBackups?: boolean | undefined;
  supportReplication?: boolean | undefined;
  supportClustering?: boolean | undefined;
  customerSupport?: string | undefined;
  creationDate?: string | undefined;
}

export interface RcModule {
  id?: number | undefined;
  name?: string | undefined;
  capabilityName?: string | undefined;
  version?: string | undefined;
}

export interface RcAlert {
  name?: string | undefined;
  value?: number | undefined;
  defaultValue?: number | undefined;
}

export interface RcSecurity {
  enableDefaultUser?: boolean | undefined;
  /** Essentials spells the same flag differently. */
  defaultUserEnabled?: boolean | undefined;
  password?: string | undefined;
  enableTls?: boolean | undefined;
  sslClientAuthentication?: boolean | undefined;
  tlsClientAuthentication?: boolean | undefined;
  sourceIps?: string[] | undefined;
}

export interface RcBackup {
  remoteBackupEnabled?: boolean | undefined;
  status?: string | undefined;
  interval?: string | undefined;
  destination?: string | undefined;
  timeUTC?: string | undefined;
}

/** A database, Pro or Essentials: the two share most of their shape. */
export interface RcDatabase {
  databaseId?: number | undefined;
  name?: string | undefined;
  protocol?: string | undefined;
  provider?: string | undefined;
  region?: string | undefined;
  redisVersion?: string | undefined;
  redisVersionCompliance?: string | undefined;
  respVersion?: string | undefined;
  status?: string | undefined;
  memoryLimitInGb?: number | undefined;
  datasetSizeInGb?: number | undefined;
  /** Essentials: the plan's memory limit, in `memoryLimitMeasurementUnit`. */
  planMemoryLimit?: number | undefined;
  planDatasetSize?: number | undefined;
  memoryLimitMeasurementUnit?: string | undefined;
  memoryUsedInMb?: number | undefined;
  networkMonthlyUsageInByte?: number | undefined;
  memoryStorage?: string | undefined;
  supportOSSClusterApi?: boolean | undefined;
  dataPersistence?: string | undefined;
  replication?: boolean | undefined;
  dataEvictionPolicy?: string | undefined;
  throughputMeasurement?: { by?: string; value?: number };
  activatedOn?: string | undefined;
  lastModified?: string | undefined;
  publicEndpoint?: string | undefined;
  privateEndpoint?: string | undefined;
  clustering?: { numberOfShards?: number; enabled?: boolean; hashingPolicy?: string };
  security?: RcSecurity | undefined;
  modules?: RcModule[] | undefined;
  alerts?: RcAlert[] | undefined;
  backup?: RcBackup | undefined;
  autoMinorVersionUpgrade?: boolean | undefined;
  queryPerformanceFactor?: string | undefined;
  activeActiveRedis?: boolean | undefined;
}

export interface RcProSubscriptionDatabases {
  accountId?: number | undefined;
  subscription?: Array<{
    subscriptionId?: number;
    numberOfDatabases?: number;
    databases?: RcDatabase[];
  }>;
}

export interface RcEssentialsSubscriptionDatabases {
  accountId?: number | undefined;
  subscription?:
    | { subscriptionId?: number; numberOfDatabases?: number; databases?: RcDatabase[] }
    | Array<{ subscriptionId?: number; numberOfDatabases?: number; databases?: RcDatabase[] }>;
}

export interface RcAclRule {
  id?: number | undefined;
  name?: string | undefined;
  acl?: string | undefined;
  isDefault?: boolean | undefined;
  status?: string | undefined;
}

export interface RcAclRole {
  id?: number | undefined;
  name?: string | undefined;
  redisRules?: Array<{
    ruleId?: number | undefined;
    ruleName?: string | undefined;
    databases?: Array<{
      subscriptionId?: number | undefined;
      databaseId?: number | undefined;
      databaseName?: string | undefined;
      regions?: string[] | undefined;
    }>;
  }>;
  users?: Array<{ id?: number; name?: string }>;
  status?: string | undefined;
}

export interface RcAclUser {
  id?: number | undefined;
  name?: string | undefined;
  role?: string | undefined;
  status?: string | undefined;
}

export interface RcCloudAccount {
  id?: number | undefined;
  name?: string | undefined;
  provider?: string | undefined;
  status?: string | undefined;
  accessKeyId?: string | undefined;
  signInLoginUrl?: string | undefined;
  awsUserArn?: string | undefined;
  awsConsoleRoleArn?: string | undefined;
}

export interface RcVpcPeering {
  vpcPeeringId?: number | undefined;
  status?: string | undefined;
  awsAccountId?: string | undefined;
  awsPeeringUid?: string | undefined;
  vpcUid?: string | undefined;
  vpcCidr?: string | undefined;
  vpcCidrs?: Array<{ vpcCidr?: string; active?: string }>;
  projectUid?: string | undefined;
  networkName?: string | undefined;
  redisProjectUid?: string | undefined;
  redisNetworkName?: string | undefined;
  cloudPeeringId?: string | undefined;
  regionName?: string | undefined;
}

export interface RcTransitGateway {
  id?: number | undefined;
  awsTgwUid?: string | undefined;
  attachmentUid?: string | undefined;
  status?: string | undefined;
  attachmentStatus?: string | undefined;
  awsAccountId?: string | undefined;
  cidrs?: Array<{ cidrAddress?: string; status?: string }>;
}

export interface RcTgwInvitation {
  id?: number | undefined;
  name?: string | undefined;
  resourceShareUid?: string | undefined;
  awsAccountId?: string | undefined;
  status?: string | undefined;
  sharedDate?: string | undefined;
}

export interface RcPscService {
  id?: number | undefined;
  connectionHostName?: string | undefined;
  serviceAttachmentName?: string | undefined;
  status?: string | undefined;
}

export interface RcPscEndpoint {
  id?: number | undefined;
  gcpProjectId?: string | undefined;
  gcpVpcName?: string | undefined;
  gcpVpcSubnetName?: string | undefined;
  endpointConnectionName?: string | undefined;
  status?: string | undefined;
}

export interface RcAccount {
  id?: number | undefined;
  name?: string | undefined;
  createdTimestamp?: string | undefined;
  updatedTimestamp?: string | undefined;
  pocStatus?: string | undefined;
  marketplaceStatus?: string | undefined;
  key?: {
    name?: string | undefined;
    accountId?: number | undefined;
    accountName?: string | undefined;
    allowedSourceIps?: string[] | undefined;
    createdTimestamp?: string | undefined;
    owner?: { name?: string; email?: string };
    httpSourceIp?: string | undefined;
  };
}

export interface RcPaymentMethod {
  id?: number | undefined;
  type?: string | undefined;
  creditCardEndsWith?: string | undefined;
  nameOnCard?: string | undefined;
  expirationMonth?: number | undefined;
  expirationYear?: number | undefined;
}

export interface RcEssentialsPlan {
  id?: number | undefined;
  name?: string | undefined;
  size?: number | undefined;
  datasetSize?: number | undefined;
  sizeMeasurementUnit?: string | undefined;
  provider?: string | undefined;
  region?: string | undefined;
  price?: number | undefined;
  priceCurrency?: string | undefined;
  pricePeriod?: string | undefined;
  maximumDatabases?: number | undefined;
  availability?: string | undefined;
  supportReplication?: boolean | undefined;
  supportDataPersistence?: boolean | undefined;
  supportedAlerts?: string[] | undefined;
  redisFlex?: boolean | undefined;
}

export interface RcSystemLogEntry {
  id?: number | undefined;
  time?: string | undefined;
  originator?: string | undefined;
  apiKeyName?: string | undefined;
  resource?: string | undefined;
  resourceId?: number | undefined;
  type?: string | undefined;
  description?: string | undefined;
}

export interface RcSlowLogEntry {
  id?: number | undefined;
  startTime?: string | undefined;
  duration?: number | undefined;
  arguments?: string | undefined;
}
