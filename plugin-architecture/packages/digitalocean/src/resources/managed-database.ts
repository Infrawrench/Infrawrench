import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ManagedDatabaseResourceType: ResourceTypeDefinition = {
  id: "managed-database",
  displayName: "Managed Database",
  pluralDisplayName: "Managed Databases",
  description: "A DigitalOcean Managed Database cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: ["pg", "mysql", "redis", "mongodb", "kafka", "opensearch"],
    },
    {
      key: "version",
      label: "Version",
      kind: "string",
      required: true,
      description: "Engine version, e.g. 16 for PostgreSQL 16",
    },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: ["nyc1", "nyc3", "sfo2", "sfo3", "ams3", "fra1", "sgp1", "lon1", "tor1", "blr1", "syd1"],
    },
    {
      key: "size",
      label: "Node Size",
      kind: "string",
      required: true,
      description: "Node size slug, e.g. db-s-1vcpu-1gb",
    },
    {
      key: "nodeCount",
      label: "Node Count",
      kind: "number",
      required: true,
    },
  ],
  outputs: [
    {
      key: "connectionString",
      label: "Connection String",
      sensitive: true,
      description: "Full connection URI",
    },
    { key: "host", label: "Host", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "username", label: "Username", sensitive: false },
    { key: "password", label: "Password", sensitive: true },
    { key: "database", label: "Database Name", sensitive: false },
    {
      key: "caCertificate",
      label: "CA Certificate",
      sensitive: false,
      description: "TLS CA certificate for verifying the server",
    },
  ],
  parentTypeId: "project",
  dashboardPinnable: true,
  iconKey: "database",
};
