import { f, o, rt } from "@infrawrench/plugin-base";

export const MemorystoreRedisResourceType = rt({
  name: "Memorystore Redis",
  plural: "Memorystore Redis Instances",
  id: "memorystore-redis",
  iconKey: "cache",
  description: "A Google Cloud Memorystore for Redis instance",
  equivalence: "managed-redis",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true, sizing: "region" }),
    f("tier", "Tier", {
      showcase: true,
      kind: "enum",
      required: false,
      enumValues: ["BASIC", "STANDARD_HA"],
    }),
    f("memorySizeGb", "Memory (GB)", { kind: "number", required: false, sizing: "memory-gb" }),
    f("redisVersion", "Redis Version", { required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("authorizedNetwork", "Authorized Network", {
      required: false,
      description: "Name of the VPC network the instance is connected to",
    }),
  ],
  // The API returns the full network name; the lister keeps its last segment,
  // which is what a vpc-network's `name` field holds.
  dependsOn: [
    {
      fieldKey: "authorizedNetwork",
      targetTypeId: "vpc-network",
      targetKey: "name",
      label: "in network",
    },
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("authString", "Auth String", { sensitive: true }),
    o("redisUrl", "Redis URL", { sensitive: true }),
  ],
  supportsCreate: true,
  supportsMetrics: true,
  // `stats/memory/usage_ratio` ("Memory usage as a ratio of maximum memory"),
  // charted as 0..100 under this label (busiest node role):
  // https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z, read 2026-11-23
  capacityMetrics: [
    { seriesLabel: "Memory Usage", limit: { constant: 100 }, unit: "%", label: "Memory" },
  ],
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
});
