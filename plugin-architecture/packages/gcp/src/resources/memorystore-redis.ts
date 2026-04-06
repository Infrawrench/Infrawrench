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
  ],
  dashboardPinnable: true,
};
