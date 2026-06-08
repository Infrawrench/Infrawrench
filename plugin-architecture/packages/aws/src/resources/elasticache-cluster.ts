import { f, o, rt } from "@infrawrench/plugin-base";

export const ElastiCacheClusterResourceType = rt({
  name: "ElastiCache Cluster",
  id: "elasticache-cluster",
  description: "An Amazon ElastiCache Redis or Memcached cluster",
  fields: [
    f("clusterId", "Cluster ID"),
    f("engine", "Engine", { kind: "enum", enumValues: ["redis", "memcached"] }),
    f("engineVersion", "Engine Version"),
    f("nodeType", "Node Type"),
    f("numNodes", "Number of Nodes", { kind: "number" }),
    f("status", "Status"),
    f("availabilityZone", "Availability Zone", { required: false }),
  ],
  outputs: [
    o("endpoint", "Endpoint"),
    o("port", "Port"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Redis/Memcached connection URI (constructed from endpoint + port)",
    }),
  ],
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
});
