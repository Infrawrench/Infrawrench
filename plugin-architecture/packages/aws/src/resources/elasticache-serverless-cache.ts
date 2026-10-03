import { f, o, rt } from "@infrawrench/plugin-base";

const UNREACHABLE = {
  fieldsEmpty: ["endpoint"],
  title: "Serverless cache endpoint is not reachable from this host.",
  suggestions: [
    "Serverless caches with a VPC connection are only reachable from inside that VPC; connect via an SSH tunnel or a bastion in the same VPC.",
    "Connections must use TLS; the connection string already uses rediss://.",
  ],
};

export const ElastiCacheServerlessCacheResourceType = rt({
  name: "ElastiCache Serverless Cache",
  id: "elasticache-serverless-cache",
  description: "An Amazon ElastiCache Serverless cache running Valkey, Redis OSS or Memcached",
  // Edit = ModifyServerlessCache. The engine, network placement and
  // connection type are fixed at creation.
  fields: [
    f("name", "Cache Name", { editable: false }),
    f("engine", "Engine", {
      kind: "enum",
      enumValues: ["valkey", "redis", "memcached"],
      editable: false,
    }),
    f("engineVersion", "Engine Version", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("description", "Description", { required: false }),
    f("maxDataStorageGb", "Max Data Storage (GB)", {
      kind: "number",
      required: false,
      description: "Upper limit on stored data. 0 means no limit",
    }),
    f("maxEcpuPerSecond", "Max ECPU per Second", {
      kind: "number",
      required: false,
      description: "Upper limit on ElastiCache Processing Units per second. 0 means no limit",
    }),
    f("snapshotRetentionLimit", "Snapshot Retention (days)", {
      kind: "number",
      required: false,
      description: "Days automatic snapshots are kept, 0 to 35. Not available for Memcached",
    }),
    f("dailySnapshotTime", "Daily Snapshot Time", {
      required: false,
      description: "UTC time of day the daily snapshot starts, e.g. 04:00",
    }),
    f("connectionType", "Connection Type", {
      kind: "enum",
      enumValues: ["vpc", "public"],
      required: false,
      editable: false,
    }),
    f("networkType", "Network Type", { required: false, editable: false }),
    f("subnetIds", "Subnets", {
      required: false,
      editable: false,
      description: "Comma-separated subnet IDs of the cache's VPC endpoint",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      editable: false,
      description: "Comma-separated VPC security group IDs on the cache's VPC endpoint",
    }),
  ],
  outputs: [
    o("endpoint", "Endpoint"),
    o("readerEndpoint", "Reader Endpoint"),
    o("port", "Port"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "TLS connection URI (rediss:// for Valkey and Redis OSS)",
    }),
    o("arn", "ARN"),
  ],
  dependsOn: [
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  iconKey: "cache",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Valkey",
      showWhen: { fieldKey: "engine", equals: "valkey" },
      unreachableWhen: UNREACHABLE,
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "redis" },
      unreachableWhen: UNREACHABLE,
    },
  ],
  secretExportTemplates: [
    {
      id: "redis-url",
      displayName: "Redis URL",
      description: "REDIS_URL for Valkey and Redis OSS caches",
      entries: [
        { envKey: "REDIS_URL", outputKey: "connectionString", description: "TLS connection URI" },
      ],
    },
    {
      id: "connection",
      displayName: "Connection Details",
      description: "Serverless cache endpoint and port",
      entries: [
        { envKey: "CACHE_HOST", outputKey: "endpoint" },
        { envKey: "CACHE_PORT", outputKey: "port" },
      ],
    },
  ],
});
