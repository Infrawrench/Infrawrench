import { f, o, rt } from "@infrawrench/plugin-base";

export const RedisInstanceResourceType = rt({
  name: "Redis Instance",
  id: "redis-instance",
  description: "A Redis server — connects via connection string",
  fields: [
    f("name", "Display Name"),
    f("connectionString", "Connection String", {
      kind: "secret",
      allowLiteral: true,
      description: "Redis connection URI (redis:// or rediss://).",
      resolvableOutputKeys: ["connectionString"],
    }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("redisVersion", "Redis Version"),
  ],
  iconKey: "redis",
});
