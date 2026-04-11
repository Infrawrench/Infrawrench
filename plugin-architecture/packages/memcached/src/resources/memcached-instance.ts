import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MemcachedInstanceResourceType: ResourceTypeDefinition = {
  id: "memcached-instance",
  displayName: "Memcached Instance",
  pluralDisplayName: "Memcached Instances",
  description: "A Memcached server",
  fields: [
    { key: "name", label: "Display Name", kind: "string", required: true },
    {
      key: "connectionString",
      label: "Server(s)",
      kind: "secret",
      required: true,
      allowLiteral: true,
      description: "Host:port, or comma-separated for multiple servers (e.g. localhost:11211).",
      resolvableOutputKeys: ["connectionString"],
    },
  ],
  outputs: [{ key: "connectionString", label: "Connection String", sensitive: true }],
  dashboardPinnable: true,
  iconKey: "memcached",
};
