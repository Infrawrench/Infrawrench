import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ManagedDbResourceType: ResourceTypeDefinition = {
  id: "managed-db",
  displayName: "Managed Database",
  pluralDisplayName: "Managed Databases",
  description: "An OVHcloud Public Cloud managed database service",
  fields: [
    { key: "description", label: "Name", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: [
        "postgresql",
        "mysql",
        "mongodb",
        "redis",
        "kafka",
        "opensearch",
        "cassandra",
        "m3db",
        "grafana",
      ],
    },
    {
      key: "version",
      label: "Version",
      kind: "string",
      required: true,
      description: "Engine version, e.g. 16 for PostgreSQL 16",
    },
    {
      key: "plan",
      label: "Plan",
      kind: "string",
      required: true,
      description: "Service plan, e.g. essential, business, enterprise",
    },
    {
      key: "region",
      label: "Region",
      kind: "string",
      required: true,
    },
    {
      key: "flavor",
      label: "Flavor",
      kind: "string",
      required: true,
      description: "Node flavor, e.g. db1-7",
    },
    {
      key: "nodeCount",
      label: "Node Count",
      kind: "number",
      required: true,
    },
    {
      key: "status",
      label: "Status",
      kind: "string",
      required: false,
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
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "database",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "postgresql" },
    },
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "mysql" },
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "redis" },
    },
    {
      pluginId: "mongodb",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MongoDB",
      showWhen: { fieldKey: "engine", equals: "mongodb" },
    },
    {
      // OVH Public Cloud Databases returns the OpenSearch endpoint as
      // `https://<host>:<port>` in `endpoint.uri`. Password is set/rotated
      // by the user (OVH never returns it back) — see ovh client.ts where
      // resolveOutput("password") returns ""; users either let OpenSearch
      // plugin's credentials carry the password they set, or rotate it.
      pluginId: "opensearch",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "endpoint" },
        { outputKey: "username", credentialKey: "username" },
        { outputKey: "password", credentialKey: "password" },
      ],
      tabLabel: "OpenSearch",
      showWhen: { fieldKey: "engine", equals: "opensearch" },
    },
    {
      // OVH Managed Kafka uses SASL/SCRAM-SHA-512 over TLS — OVH's docs
      // (databases / kafka / connection guides) call SCRAM-SHA-512 out
      // explicitly. The ovh client normalizes the endpoint.uri for kafka
      // engines so it includes `sasl=scram-sha-512&ssl=true` for the
      // kafka plugin driver. Password isn't returned by OVH after
      // creation, same as other OVH managed DBs.
      pluginId: "kafka",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Kafka",
      showWhen: { fieldKey: "engine", equals: "kafka" },
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full connection string",
      entries: [
        {
          envKey: "DATABASE_URL",
          outputKey: "connectionString",
          description: "Full connection URI",
        },
      ],
    },
    {
      id: "individual",
      displayName: "Individual Credentials",
      description: "Separate environment variables for host, port, user, password, and database",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "database" },
      ],
    },
  ],
};
