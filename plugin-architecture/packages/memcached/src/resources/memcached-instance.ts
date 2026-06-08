import { f, o, rt } from "@infrawrench/plugin-base";

export const MemcachedInstanceResourceType = rt({
  name: "Memcached Instance",
  id: "memcached-instance",
  description: "A Memcached server",
  fields: [
    f("name", "Display Name"),
    f("connectionString", "Server(s)", {
      kind: "secret",
      allowLiteral: true,
      description: "Host:port, or comma-separated for multiple servers (e.g. localhost:11211).",
      resolvableOutputKeys: ["connectionString"],
    }),
  ],
  outputs: [o("connectionString", "Connection String", { sensitive: true })],
  iconKey: "memcached",
});
