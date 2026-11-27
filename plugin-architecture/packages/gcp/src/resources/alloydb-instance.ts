import { f, o, rt } from "@infrawrench/plugin-base";

export const AlloyDbInstanceResourceType = rt({
  name: "AlloyDB Instance",
  pinnable: false,
  id: "alloydb-instance",
  iconKey: "database",
  description: "An instance within a Google Cloud AlloyDB cluster",
  // AlloyDB is PostgreSQL-compatible; the instance is what runs (and bills)
  // the compute, so it stands for the managed Postgres.
  equivalence: "managed-postgres",
  fields: [
    f("name", "Name"),
    f("instanceType", "Instance Type", { showcase: true, required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("cpuCount", "CPU Count", {
      showcase: true,
      kind: "number",
      required: false,
      sizing: "vcpus",
    }),
    f("ipAddress", "IP Address", { showcase: true, required: false }),
    f("availabilityType", "Availability Type", { required: false }),
    f("cluster", "Cluster", {
      required: false,
      description: "Name of the AlloyDB cluster this instance belongs to",
    }),
  ],
  // Clusters are keyed by their full resource path, so match the bare `name`
  // field the lister writes on them.
  dependsOn: [
    {
      fieldKey: "cluster",
      targetTypeId: "alloydb-cluster",
      targetKey: "name",
      label: "in cluster",
    },
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
  // `instance/postgres/average_connections` ("The mean number of active and
  // idle connections ... across serving nodes") over
  // `instance/postgres/connections_limit` ("The current limit on the number
  // of connections per node"), charted as 0..100 under this label:
  // https://docs.cloud.google.com/monitoring/api/metrics_gcp_a_b, read 2026-11-23
  capacityMetrics: [
    {
      seriesLabel: "Connections Used (per node)",
      limit: { constant: 100 },
      unit: "%",
      label: "Connections",
    },
  ],
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
