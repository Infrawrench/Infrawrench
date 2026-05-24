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
      enumValues: ["pg", "mysql", "redis", "mongodb", "kafka", "opensearch", "weaviate"],
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
      enumValues: [
        "nyc1",
        "nyc3",
        "sfo2",
        "sfo3",
        "ams3",
        "fra1",
        "sgp1",
        "lon1",
        "tor1",
        "blr1",
        "syd1",
      ],
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
  showInSidebar: true,
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "database",
  peerIntegrations: [
    {
      pluginId: "postgres",
      // DO signs managed-DB certs with its own internal CA. Map the
      // caCertificate output into the Postgres plugin's caCert credential
      // so TLS chain verification stays on with DO's CA trusted, instead
      // of failing with "self signed certificate in certificate chain".
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "pg" },
    },
    {
      pluginId: "mysql",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
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
      // DO managed OpenSearch exposes a doadmin user + a TLS endpoint on
      // port 25060. The connection.uri is shaped like
      // `https://doadmin:<pw>@cluster-host:25060` so the OpenSearch plugin
      // can pull credentials out of the URL via parseConfig().
      pluginId: "opensearch",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "endpoint" },
        { outputKey: "caCertificate", credentialKey: "caCertificate" },
      ],
      tabLabel: "OpenSearch",
      showWhen: { fieldKey: "engine", equals: "opensearch" },
    },
    {
      // DO managed Kafka uses SASL/SCRAM-SHA-256 over TLS on port 25073;
      // the connection.uri is shaped like
      // `kafkas://username:password@cluster-host:25073`. The DO client's
      // resolveOutput normalizes the URI for kafka engines so it includes
      // explicit `sasl=scram-sha-256&ssl=true` params the kafka plugin
      // driver understands.
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
    {
      id: "individual-with-ca",
      displayName: "Individual + CA Certificate",
      description: "Individual credentials plus the TLS CA certificate for verified connections",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "database" },
        { envKey: "DB_CA_CERT", outputKey: "caCertificate", description: "TLS CA certificate" },
      ],
    },
  ],
};
