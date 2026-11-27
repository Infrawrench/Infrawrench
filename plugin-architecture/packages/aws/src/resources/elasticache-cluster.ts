import { f, o, rt } from "@infrawrench/plugin-base";
import { ELASTICACHE_EXTENDED_SUPPORT } from "../extended-support.js";

export const ElastiCacheClusterResourceType = rt({
  name: "ElastiCache Cluster",
  id: "elasticache-cluster",
  carbon: {
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      sizeFieldKey: "nodeType",
      catalogueTypeId: "ec2-instance",
      catalogueFieldKey: "instanceType",
      stripPrefix: "cache.",
    },
    countFieldKey: "numNodes",
  },
  description: "An Amazon ElastiCache Valkey, Redis OSS or Memcached cluster",
  // Memcached has no cross-provider category. The stored `nodeType` and
  // `numNodes` are `cacheNodeType` and `numCacheNodes` on the create form;
  // the estimator reads both spellings.
  equivalence: [
    {
      category: "managed-redis",
      when: { fieldKey: "engine", oneOf: ["redis", "valkey"] },
      createFields: { engine: "redis" },
    },
  ],
  fields: [
    f("clusterId", "Cluster ID"),
    f("region", "Region", { required: false, editable: false, sizing: "region" }),
    f("engine", "Engine", { kind: "enum", enumValues: ["valkey", "redis", "memcached"] }),
    f("engineVersion", "Engine Version"),
    f("nodeType", "Node Type", { showcase: true, sizing: "instance-type" }),
    f("numNodes", "Number of Nodes", { showcase: true, kind: "number", sizing: "node-count" }),
    f("status", "Status", { showcase: true }),
    f("availabilityZone", "Availability Zone", { showcase: true, required: false }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated VPC security group IDs attached to the cluster",
    }),
  ],
  outputs: [
    o("endpoint", "Endpoint"),
    o("port", "Port"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description:
        "Redis/Memcached connection URI (constructed from endpoint + port; Valkey uses redis://)",
    }),
  ],
  dependsOn: [
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  extendedSupport: ELASTICACHE_EXTENDED_SUPPORT,
  iconKey: "cache",
  supportsCreate: true,
  supportsMetrics: true,
  // `elastiCacheClusterMetrics` charts `DatabaseMemoryUsagePercentage`
  // (Valkey and Redis OSS; evictions start at 100) as "Memory Used":
  // https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheMetrics.Redis.html
  // (read 2026-11-23).
  capacityMetrics: [
    { seriesLabel: "Memory Used", limit: { constant: 100 }, unit: "%", label: "Memory" },
  ],
  peerIntegrations: [
    {
      // Valkey speaks the Redis protocol, so the Redis plugin drives it.
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Valkey",
      showWhen: { fieldKey: "engine", equals: "valkey" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Cluster endpoint is not reachable from this host.",
        suggestions: [
          "ElastiCache clusters are VPC-only; connect from inside the VPC or via an SSH tunnel.",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "redis" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Cluster endpoint is not reachable from this host.",
        suggestions: [
          "ElastiCache clusters are VPC-only. Connect from inside the VPC or via an SSH tunnel.",
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
          "ElastiCache clusters are VPC-only. Connect from inside the VPC or via an SSH tunnel.",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "redis-url",
      displayName: "Redis URL",
      description: "REDIS_URL for Valkey and Redis OSS clusters",
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
