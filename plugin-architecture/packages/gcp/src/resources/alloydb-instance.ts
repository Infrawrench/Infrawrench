import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AlloyDbInstanceResourceType: ResourceTypeDefinition = {
  id: "alloydb-instance",
  displayName: "AlloyDB Instance",
  pluralDisplayName: "AlloyDB Instances",
  description: "An instance within a Google Cloud AlloyDB cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "instanceType", label: "Instance Type", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "cpuCount", label: "CPU Count", kind: "number", required: false },
    { key: "ipAddress", label: "IP Address", kind: "string", required: false },
    { key: "availabilityType", label: "Availability Type", kind: "string", required: false },
  ],
  outputs: [
    { key: "ipAddress", label: "IP Address", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "username", label: "Username", sensitive: false },
    { key: "password", label: "Password", sensitive: true },
    {
      key: "connectionUrl",
      label: "Connection URL",
      sensitive: true,
      description: "Full PostgreSQL connection URL with embedded credentials",
    },
  ],
  parentTypeId: "alloydb-cluster",
  dashboardPinnable: false,
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "postgres",
      tabLabel: "PostgreSQL",
      credentialMappings: [{ outputKey: "connectionUrl", credentialKey: "connectionString" }],
      // Gate on ipAddress so the tab stays hidden while the instance is still
      // CREATING and there's nothing to connect to yet.
      showWhen: { fieldKey: "ipAddress" },
    },
  ],
  secretExportTemplates: [
    {
      id: "alloydb-connection-url",
      displayName: "Database URL",
      description: "Full PostgreSQL connection URL with credentials",
      entries: [
        {
          envKey: "DATABASE_URL",
          outputKey: "connectionUrl",
          description: "postgres://user:password@host:5432/postgres",
        },
      ],
    },
    {
      id: "alloydb-connection",
      displayName: "AlloyDB Connection",
      description: "Host, port, and credentials for direct AlloyDB access",
      entries: [
        { envKey: "DB_HOST", outputKey: "ipAddress" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
      ],
    },
  ],
};
