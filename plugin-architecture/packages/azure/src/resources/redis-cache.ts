import { f, o, rt } from "@infrawrench/plugin-base";

export const RedisCacheResourceType = rt({
  name: "Redis Cache",
  id: "azure-redis-cache",
  description: "An Azure Cache for Redis instance",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("capacity", "Capacity", { kind: "number" }),
    f("provisioningState", "Provisioning State"),
    f("redisVersion", "Redis Version", { required: false }),
    f("nonSslPort", "Non-SSL Port Enabled", { kind: "boolean", required: false }),
    f("shardCount", "Shard Count", { kind: "number", required: false }),
  ],
  outputs: [
    o("hostName", "Hostname"),
    o("port", "SSL Port"),
    o("primaryKey", "Primary Key", { sensitive: true }),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
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
});
