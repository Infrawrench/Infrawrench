import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RedisInstanceResourceType: ResourceTypeDefinition = {
  id: "redis-instance",
  displayName: "Redis Instance",
  pluralDisplayName: "Redis Instances",
  description: "A Redis server — connects via connection string",
  fields: [
    { key: "name", label: "Display Name", kind: "string", required: true },
    {
      key: "connectionString",
      label: "Connection String",
      kind: "secret",
      required: true,
      allowLiteral: true,
      description: "Redis connection URI (redis:// or rediss://).",
      resolvableOutputKeys: ["connectionString"],
    },
  ],
  outputs: [
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "redisVersion", label: "Redis Version", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "redis",
};
