import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RedisCacheResourceType: ResourceTypeDefinition = {
  id: "azure-redis-cache",
  displayName: "Redis Cache",
  pluralDisplayName: "Redis Caches",
  description: "An Azure Cache for Redis instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "capacity", label: "Capacity", kind: "number", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "redisVersion", label: "Redis Version", kind: "string", required: false },
    { key: "nonSslPort", label: "Non-SSL Port Enabled", kind: "boolean", required: false },
    { key: "shardCount", label: "Shard Count", kind: "number", required: false },
  ],
  outputs: [
    { key: "hostName", label: "Hostname", sensitive: false },
    { key: "port", label: "SSL Port", sensitive: false },
    { key: "primaryKey", label: "Primary Key", sensitive: true },
    { key: "connectionString", label: "Connection String", sensitive: true },
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
    },
  ],
  secretExportTemplates: [
    {
      id: "redis-connection",
      displayName: "Redis Connection",
      description: "Azure Redis Cache connection details",
      entries: [
        { envKey: "REDIS_HOST", outputKey: "hostName" },
        { envKey: "REDIS_PORT", outputKey: "port" },
        { envKey: "REDIS_PASSWORD", outputKey: "primaryKey" },
        { envKey: "REDIS_URL", outputKey: "connectionString" },
      ],
    },
  ],
};
