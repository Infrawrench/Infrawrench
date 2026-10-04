import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const PERSISTENCE_OPTIONS = [
  "none",
  "aof-every-1-second",
  "aof-every-write",
  "snapshot-every-1-hour",
  "snapshot-every-6-hours",
  "snapshot-every-12-hours",
];

export const EVICTION_OPTIONS = [
  "noeviction",
  "allkeys-lru",
  "allkeys-lfu",
  "allkeys-random",
  "volatile-lru",
  "volatile-lfu",
  "volatile-random",
  "volatile-ttl",
];

export const T = {
  account: "rc-account",
  subscription: "rc-subscription",
  database: "rc-database",
  vpcPeering: "rc-vpc-peering",
  transitGateway: "rc-transit-gateway",
  pscEndpoint: "rc-psc-endpoint",
  aclRule: "rc-acl-rule",
  aclRole: "rc-acl-role",
  aclUser: "rc-acl-user",
  cloudAccount: "rc-cloud-account",
} as const;

const AccountType = rt({
  name: "Account",
  id: T.account,
  description:
    "The Redis Cloud account: API key owner, payment methods, recent tasks and the system log",
  fields: [
    f("name", "Account Name", { editable: false }),
    f("accountId", "Account ID", { editable: false }),
    f("marketplaceStatus", "Marketplace Status", { required: false, editable: false }),
    f("keyName", "API Key Name", { required: false, editable: false }),
    f("keyOwner", "API Key Owner", { required: false, editable: false }),
    f("paymentMethods", "Payment Methods", { kind: "number", required: false, editable: false }),
  ],
  iconKey: "account",
});

const SubscriptionType = rt({
  name: "Subscription",
  id: T.subscription,
  description:
    "A Redis Cloud subscription: Pro (dedicated deployment, priced per shard-hour) or Essentials (a fixed monthly plan)",
  fields: [
    f("name", "Name"),
    f("plan", "Plan", { kind: "enum", enumValues: ["Pro", "Essentials"], editable: false }),
    f("status", "Status", { editable: false }),
    f("provider", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("deploymentType", "Deployment", { required: false, editable: false }),
    f("memoryStorage", "Memory Storage", { required: false, editable: false }),
    f("numberOfDatabases", "Databases", { kind: "number", required: false, editable: false }),
    f("shards", "Shards", { kind: "number", required: false, editable: false }),
    f("shardType", "Shard Type", { required: false, editable: false }),
    f("planName", "Essentials Plan", { required: false, editable: false }),
    f("planSizeGb", "Plan Size (GB)", { kind: "number", required: false, editable: false }),
    f("monthlyPrice", "List Price / Month", {
      kind: "number",
      required: false,
      editable: false,
      description: "Shard-hours × list price × 730 for Pro; the plan price for Essentials.",
    }),
    f("priceCurrency", "Currency", { required: false, editable: false }),
    f("paymentMethodType", "Payment Method", { required: false, editable: false }),
    f("publicEndpointAccess", "Public Endpoint Access", {
      kind: "boolean",
      required: false,
      description:
        "Pro only. When off, every database in the subscription rejects connections from outside the private address space.",
    }),
    f("cloudAccountId", "Cloud Account", { required: false, editable: false }),
    f("multiAz", "Multi-AZ", { kind: "boolean", required: false, editable: false }),
    f("deploymentCidr", "Deployment CIDR", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("prometheusEndpoint", "Prometheus Endpoint", { hidden: true })],
  iconKey: "cache",
  supportsUpdate: true,
  supportsDelete: true,
  postureChecks: [
    {
      id: "redis-cloud-subscription-public-endpoint",
      title: "Public endpoint access enabled",
      severity: "low",
      category: "public-exposure",
      conditions: [
        { fieldKey: "plan", when: "equals", value: "Pro" },
        { fieldKey: "publicEndpointAccess", when: "truthy" },
      ],
      reason:
        "Databases in this Pro subscription accept connections on their public endpoints. With VPC peering or Private Service Connect in place, turning public access off limits them to the private network.",
    },
  ],
});

const DatabaseType = rt({
  name: "Database",
  id: T.database,
  description:
    "A Redis Cloud database with its endpoints, memory limit, throughput and capabilities",
  parentTypeId: T.subscription,
  showInSidebar: true,
  fields: [
    f("name", "Name"),
    f("plan", "Plan", { kind: "enum", enumValues: ["Pro", "Essentials"], editable: false }),
    f("subscriptionId", "Subscription ID", { editable: false }),
    f("subscriptionName", "Subscription", { required: false, editable: false }),
    f("status", "Status", { editable: false }),
    f("provider", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("protocol", "Protocol", { required: false, editable: false }),
    f("redisVersion", "Redis Version", { required: false, editable: false }),
    f("respVersion", "RESP Version", { required: false, editable: false }),
    f("memoryLimitGb", "Memory Limit (GB)", {
      kind: "number",
      required: false,
      editable: false,
      description: "Total memory including replication overhead. Change it with Resize memory.",
    }),
    f("datasetSizeGb", "Dataset Size (GB)", { kind: "number", required: false, editable: false }),
    f("memoryUsedMb", "Memory Used (MB)", { kind: "number", required: false, editable: false }),
    f("memoryUsedPct", "Memory Used (%)", { kind: "number", required: false, editable: false }),
    f("throughput", "Throughput", { required: false, editable: false }),
    f("throughputOpsPerSec", "Provisioned ops/sec", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("shards", "Shards", { kind: "number", required: false, editable: false }),
    f("modules", "Capabilities", { required: false, editable: false }),
    f("replication", "Replication", { kind: "boolean", required: false }),
    f("dataPersistence", "Persistence", {
      kind: "enum",
      enumValues: PERSISTENCE_OPTIONS,
      required: false,
    }),
    f("dataEvictionPolicy", "Eviction Policy", {
      kind: "enum",
      enumValues: EVICTION_OPTIONS,
      required: false,
    }),
    f("enableTls", "TLS Required", { kind: "boolean", required: false }),
    f("defaultUserEnabled", "Default User Enabled", { kind: "boolean", required: false }),
    f("sourceIps", "Allowed Source IPs", {
      required: false,
      description:
        "Comma-separated CIDR blocks allowed to connect, e.g. 10.0.0.0/8, 203.0.113.4/32.",
    }),
    f("password", "Default User Password", {
      kind: "password",
      required: false,
      description: "Set a new password for the default user. Leave blank to keep the current one.",
    }),
    f("publicEndpoint", "Public Endpoint", { required: false, editable: false }),
    f("privateEndpoint", "Private Endpoint", { required: false, editable: false }),
    f("alerts", "Alerts", { required: false, editable: false }),
    f("backupEnabled", "Remote Backup", { kind: "boolean", required: false, editable: false }),
    f("backupInterval", "Backup Interval", { required: false, editable: false }),
    f("activatedOn", "Activated", { required: false, editable: false }),
    f("lastModified", "Last Modified", { required: false, editable: false }),
    f("savingsFlag", "Savings Flag", {
      required: false,
      editable: false,
      description: "`empty` when the database holds next to no data; drives the savings finder.",
    }),
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("password", "Default User Password", { sensitive: true }),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "rediss:// when TLS is required, redis:// otherwise, for the default user",
    }),
  ],
  iconKey: "cache",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
      exposeMetricsToParent: true,
      unreachableWhen: {
        fieldsEmpty: ["publicEndpoint"],
        title: "This database has no public endpoint reachable from here.",
        suggestions: [
          "Turn on public endpoint access for the subscription, or",
          "Attach a bastion inside the network peered with Redis Cloud to this account so connections route through it.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "redis-cloud-connection",
      displayName: "Redis Connection",
      description: "Redis Cloud database connection details",
      entries: [
        { envKey: "REDIS_HOST", outputKey: "host" },
        { envKey: "REDIS_PORT", outputKey: "port" },
        { envKey: "REDIS_PASSWORD", outputKey: "password" },
        { envKey: "REDIS_URL", outputKey: "connectionString" },
      ],
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "savingsFlag", when: "equals", value: "empty" }],
    reason:
      "Active paid database holding next to no data (under 5 MB used); delete it or fold it into another database.",
  },
  postureChecks: [
    {
      id: "redis-cloud-db-no-tls",
      title: "TLS not required",
      severity: "high",
      category: "encryption",
      conditions: [{ fieldKey: "enableTls", when: "falsy" }],
      reason:
        "Clients can connect without TLS, so the password and cached data cross the network in clear text.",
    },
    {
      id: "redis-cloud-db-open-source-ips",
      title: "Open to every source IP",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "sourceIps", when: "equals", value: "0.0.0.0/0" }],
      reason:
        "The database accepts connections from any address. Restrict the allowed source IPs to the networks your applications run in.",
    },
    {
      id: "redis-cloud-db-no-persistence",
      title: "No data persistence",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "dataPersistence", when: "equals", value: "none" }],
      reason:
        "Nothing is written to persistent storage, so a full node failure loses the data set. Fine for a pure cache; not for anything else.",
    },
  ],
});

const VpcPeeringType = rt({
  name: "VPC Peering",
  id: T.vpcPeering,
  description: "A VPC peering between a Pro subscription and your AWS VPC or Google Cloud network",
  parentTypeId: T.subscription,
  fields: [
    f("status", "Status", { editable: false }),
    f("subscriptionId", "Subscription ID", { editable: false }),
    f("provider", "Cloud", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("awsAccountId", "AWS Account", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("vpcCidrs", "VPC CIDRs", {
      required: false,
      description: "AWS only: comma-separated CIDRs routed through the peering.",
    }),
    f("gcpProject", "Google Cloud Project", { required: false, editable: false }),
    f("gcpNetwork", "Google Cloud Network", { required: false, editable: false }),
    f("redisProject", "Redis Project", { required: false, editable: false }),
    f("redisNetwork", "Redis Network", { required: false, editable: false }),
    f("cloudPeeringId", "Cloud Peering ID", { required: false, editable: false }),
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const TransitGatewayType = rt({
  name: "Transit Gateway",
  id: T.transitGateway,
  description: "An AWS Transit Gateway shared with a Pro subscription, and its attachment",
  parentTypeId: T.subscription,
  fields: [
    f("status", "Status", { editable: false }),
    f("subscriptionId", "Subscription ID", { editable: false }),
    f("awsTgwId", "Transit Gateway", { required: false, editable: false }),
    f("awsAccountId", "AWS Account", { required: false, editable: false }),
    f("attachmentId", "Attachment", { required: false, editable: false }),
    f("attachmentStatus", "Attachment Status", { required: false, editable: false }),
    f("cidrs", "Routed CIDRs", {
      required: false,
      description: "Comma-separated CIDRs Redis Cloud routes to the transit gateway.",
    }),
  ],
  iconKey: "network",
  supportsUpdate: true,
});

const PscEndpointType = rt({
  name: "Private Service Connect Endpoint",
  id: T.pscEndpoint,
  plural: "Private Service Connect Endpoints",
  description: "A Google Cloud Private Service Connect endpoint into a Pro subscription",
  parentTypeId: T.subscription,
  fields: [
    f("status", "Status", { editable: false }),
    f("subscriptionId", "Subscription ID", { editable: false }),
    f("pscServiceId", "PSC Service", { required: false, editable: false }),
    f("serviceStatus", "Service Status", { required: false, editable: false }),
    f("connectionHostName", "Connection Host Name", { required: false, editable: false }),
    f("gcpProjectId", "Google Cloud Project", { required: false, editable: false }),
    f("gcpVpcName", "VPC Network", { required: false, editable: false }),
    f("gcpVpcSubnetName", "Subnet", { required: false, editable: false }),
    f("endpointConnectionName", "Endpoint Name Prefix", { required: false, editable: false }),
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsDelete: true,
});

const AclRuleType = rt({
  name: "ACL Rule",
  id: T.aclRule,
  description: "A Redis ACL rule (command and key permissions) that roles apply to databases",
  fields: [
    f("name", "Name"),
    f("rule", "Rule", {
      description: "Redis ACL syntax, for example +@read ~cache:*",
    }),
    f("isDefault", "Built-in", { kind: "boolean", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
  ],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const AclRoleType = rt({
  name: "ACL Role",
  id: T.aclRole,
  description: "A database access role: ACL rules applied to a set of databases",
  fields: [
    f("name", "Name"),
    f("rules", "Rules", { required: false, editable: false }),
    f("databases", "Databases", { required: false, editable: false }),
    f("users", "Users", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
  ],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const AclUserType = rt({
  name: "ACL User",
  id: T.aclUser,
  description: "A database user that authenticates with a password and holds one access role",
  fields: [
    f("name", "Name", { editable: false }),
    f("role", "Role", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Set a new password. Leave blank to keep the current one.",
    }),
  ],
  iconKey: "user",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});

const CloudAccountType = rt({
  name: "Cloud Account",
  id: T.cloudAccount,
  description:
    "An AWS account registered with Redis Cloud so Pro subscriptions deploy into your own cloud account",
  fields: [
    f("name", "Name", { editable: false }),
    f("provider", "Cloud", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("accessKeyId", "Access Key ID", { required: false, editable: false }),
    f("signInLoginUrl", "Console Sign-in URL", { required: false, editable: false }),
    f("awsConsoleRoleArn", "Console Role ARN", { required: false, editable: false }),
    f("awsUserArn", "Programmatic User ARN", { required: false, editable: false }),
  ],
  iconKey: "account",
  supportsDelete: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountType,
  SubscriptionType,
  DatabaseType,
  VpcPeeringType,
  TransitGatewayType,
  PscEndpointType,
  AclRuleType,
  AclRoleType,
  AclUserType,
  CloudAccountType,
];
