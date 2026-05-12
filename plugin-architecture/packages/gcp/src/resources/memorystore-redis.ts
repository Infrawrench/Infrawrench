import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MemorystoreRedisResourceType: ResourceTypeDefinition = {
  id: "memorystore-redis",
  displayName: "Memorystore Redis",
  pluralDisplayName: "Memorystore Redis Instances",
  description: "A Google Cloud Memorystore for Redis instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    {
      key: "tier",
      label: "Tier",
      kind: "enum",
      required: false,
      enumValues: ["BASIC", "STANDARD_HA"],
    },
    { key: "memorySizeGb", label: "Memory (GB)", kind: "number", required: false },
    { key: "redisVersion", label: "Redis Version", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
  ],
  outputs: [
    { key: "host", label: "Host", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "authString", label: "Auth String", sensitive: true },
    { key: "redisUrl", label: "Redis URL", sensitive: true },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "redis-credentials",
      displayName: "Redis Credentials",
      description: "Host, port, and auth string for Redis client connections",
      entries: [
        { envKey: "REDIS_HOST", outputKey: "host" },
        { envKey: "REDIS_PORT", outputKey: "port" },
        {
          envKey: "REDIS_AUTH",
          outputKey: "authString",
          description: "AUTH string for the Redis instance",
        },
      ],
    },
    {
      id: "redis-url",
      displayName: "Redis URL",
      description: "Single REDIS_URL in redis://:<auth>@<host>:<port> format",
      entries: [{ envKey: "REDIS_URL", outputKey: "redisUrl" }],
    },
  ],
};
