import { f, o, rt } from "@infrawrench/plugin-base";

export const CloudSqlInstanceResourceType = rt({
  name: "Cloud SQL Instance",
  id: "cloudsql-instance",
  description: "A Google Cloud SQL managed database instance",
  fields: [
    f("name", "Name"),
    f("databaseVersion", "Database Version", { required: false }),
    f("region", "Region"),
    f("tier", "Machine Tier", { required: false }),
    f("state", "State", { required: false }),
    f("availabilityType", "Availability Type", { required: false }),
    f("network", "VPC Network", {
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
    }),
    f("privateNetwork", "Private VPC Network", {
      required: false,
      description: "Name of the VPC network serving this instance's private IP",
    }),
  ],
  // The API returns a resource link; the lister keeps its last segment, which is
  // what a vpc-network's `name` field holds.
  dependsOn: [
    {
      fieldKey: "privateNetwork",
      targetTypeId: "vpc-network",
      targetKey: "name",
      label: "private IP in",
    },
  ],
  outputs: [
    o("connectionName", "Connection Name", { description: "project:region:instance" }),
    o("ipAddress", "IP Address"),
    o("connectionUrl", "Connection URL", {
      sensitive: true,
      description: "Full database connection URL with embedded credentials",
    }),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("port", "Port"),
  ],
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
});
