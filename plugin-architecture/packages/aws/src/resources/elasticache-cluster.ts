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
  ],
  dashboardPinnable: true,
  iconKey: "cache",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
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
