import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ElastiCacheClusterResourceType: ResourceTypeDefinition = {
  id: "elasticache-cluster",
  displayName: "ElastiCache Cluster",
  pluralDisplayName: "ElastiCache Clusters",
  description: "An Amazon ElastiCache Redis or Memcached cluster",
  fields: [
    { key: "clusterId", label: "Cluster ID", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: ["redis", "memcached"],
    },
    { key: "engineVersion", label: "Engine Version", kind: "string", required: true },
    { key: "nodeType", label: "Node Type", kind: "string", required: true },
    { key: "numNodes", label: "Number of Nodes", kind: "number", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "availabilityZone", label: "Availability Zone", kind: "string", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    {
      key: "connectionString",
      label: "Connection String",
      sensitive: true,
      description: "Redis/Memcached connection URI (constructed from endpoint + port)",
    },
  ],
  dashboardPinnable: true,
  iconKey: "cache",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "redis" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Cluster endpoint is not reachable from this host.",
        suggestions: [
          "ElastiCache clusters are VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
    {
      pluginId: "memcached",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Memcached",
      showWhen: { fieldKey: "engine", equals: "memcached" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Cluster endpoint is not reachable from this host.",
        suggestions: [
          "ElastiCache clusters are VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "redis-url",
      displayName: "Redis URL",
      description: "REDIS_URL for Redis-engine clusters",
      entries: [
        {
          envKey: "REDIS_URL",
          outputKey: "connectionString",
          description: "Redis connection URI",
        },
      ],
    },
    {
      id: "connection",
      displayName: "Connection Details",
      description: "ElastiCache endpoint and port",
      entries: [
        { envKey: "CACHE_HOST", outputKey: "endpoint" },
        { envKey: "CACHE_PORT", outputKey: "port" },
      ],
    },
  ],
};
