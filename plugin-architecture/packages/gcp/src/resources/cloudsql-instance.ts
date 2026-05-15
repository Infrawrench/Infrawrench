import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudSqlInstanceResourceType: ResourceTypeDefinition = {
  id: "cloudsql-instance",
  displayName: "Cloud SQL Instance",
  pluralDisplayName: "Cloud SQL Instances",
  description: "A Google Cloud SQL managed database instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "databaseVersion", label: "Database Version", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "tier", label: "Machine Tier", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "availabilityType", label: "Availability Type", kind: "string", required: false },
    {
      key: "network",
      label: "VPC Network",
      kind: "association",
      required: false,
      description: "VPC network for private IP access",
      allowLiteral: true,
      resolvableOutputKeys: ["selfLink"],
      resolvableFrom: [
        {
          pluginId: "gcp",
          resourceTypeId: "vpc-network",
          outputKey: "selfLink",
        },
      ],
    },
  ],
  outputs: [
    {
      key: "connectionName",
      label: "Connection Name",
      sensitive: false,
      description: "project:region:instance",
    },
    { key: "ipAddress", label: "IP Address", sensitive: false },
    {
      key: "connectionUrl",
      label: "Connection URL",
      sensitive: true,
      description: "Full database connection URL with embedded credentials",
    },
    { key: "username", label: "Username", sensitive: false },
    { key: "password", label: "Password", sensitive: true },
    { key: "port", label: "Port", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: (() => {
    // The peer plugin connects directly to the Cloud SQL instance's public IP
    // using the URL the GCP plugin builds in `resolveOutput("connectionUrl")`
    // (engine-specific scheme, embedded password, IPv4 endpoint).
    //
    // `unreachableWhen` short-circuits the tab when the instance has no public
    // IP — a private-only Cloud SQL is only reachable from inside its VPC,
    // and a desktop / web Infrawrench process almost never is. The host
    // renders a static guidance pane instead of attempting a doomed connect.
    const unreachableWhen = {
      fieldsEmpty: ["publicIpAddress"],
      title:
        "This Cloud SQL instance has no public IP, so Infrawrench can't reach it from outside its VPC.",
      suggestions: [
        "Add a public IP in the Google Cloud console (Cloud SQL → this instance → Connections → Networking).",
        "Run Infrawrench from a host inside the VPC — Cloud Shell, a GCE VM, or a Cloud Run job.",
        "Set up a Cloud VPN, Cloud Interconnect, or IAP TCP tunnel from your network into the VPC.",
      ],
    };
    return [
      {
        pluginId: "postgres",
        tabLabel: "PostgreSQL",
        credentialMappings: [{ outputKey: "connectionUrl", credentialKey: "connectionString" }],
        showWhen: { fieldKey: "databaseVersion", prefix: "POSTGRES_" },
        unreachableWhen,
      },
      {
        pluginId: "mysql",
        tabLabel: "MySQL",
        credentialMappings: [{ outputKey: "connectionUrl", credentialKey: "connectionString" }],
        showWhen: { fieldKey: "databaseVersion", prefix: "MYSQL_" },
        unreachableWhen,
      },
      {
        pluginId: "mssql",
        tabLabel: "SQL Server",
        credentialMappings: [{ outputKey: "connectionUrl", credentialKey: "connectionString" }],
        showWhen: { fieldKey: "databaseVersion", prefix: "SQLSERVER_" },
        unreachableWhen,
      },
    ];
  })(),
  secretExportTemplates: [
    {
      id: "cloudsql-connection-url",
      displayName: "Database URL",
      description: "Full database connection URL (postgres://, mysql://, or sqlserver://)",
      entries: [
        {
          envKey: "DATABASE_URL",
          outputKey: "connectionUrl",
          description: "Engine-specific connection URL with credentials",
        },
      ],
    },
    {
      id: "cloudsql-connection",
      displayName: "Cloud SQL Connection",
      description: "Connection name and IP address for Cloud SQL proxy or direct access",
      entries: [
        {
          envKey: "CLOUDSQL_CONNECTION_NAME",
          outputKey: "connectionName",
          description: "project:region:instance format",
        },
        { envKey: "DB_HOST", outputKey: "ipAddress" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
      ],
    },
  ],
};
