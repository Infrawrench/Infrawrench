import { f, o, rt } from "@infrawrench/plugin-base";

export const AlloyDbInstanceResourceType = rt({
  name: "AlloyDB Instance",
  pinnable: false,
  id: "alloydb-instance",
  description: "An instance within a Google Cloud AlloyDB cluster",
  fields: [
    f("name", "Name"),
    f("instanceType", "Instance Type", { required: false }),
    f("state", "State", { required: false }),
    f("cpuCount", "CPU Count", { kind: "number", required: false }),
    f("ipAddress", "IP Address", { required: false }),
    f("availabilityType", "Availability Type", { required: false }),
  ],
  outputs: [
    o("ipAddress", "IP Address"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("connectionUrl", "Connection URL", {
      sensitive: true,
      description: "Full PostgreSQL connection URL with embedded credentials",
    }),
  ],
  parentTypeId: "alloydb-cluster",
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
});
