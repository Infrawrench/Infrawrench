import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PostgresFlexibleServerResourceType: ResourceTypeDefinition = {
  id: "azure-postgres-flexible",
  displayName: "PostgreSQL Flexible Server",
  pluralDisplayName: "PostgreSQL Flexible Servers",
  description: "An Azure Database for PostgreSQL Flexible Server",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: true },
    { key: "version", label: "PostgreSQL Version", kind: "string", required: false },
    { key: "sku", label: "SKU", kind: "string", required: false },
    { key: "tier", label: "Tier", kind: "string", required: false },
    { key: "storageSizeGb", label: "Storage (GB)", kind: "number", required: false },
    { key: "haEnabled", label: "HA Enabled", kind: "boolean", required: false },
    {
      key: "backupRetentionDays",
      label: "Backup Retention (Days)",
      kind: "number",
      required: false,
    },
    {
      key: "network",
      label: "Virtual Network",
      kind: "association",
      required: false,
      description: "Virtual network for private access",
      allowLiteral: true,
      resolvableOutputKeys: ["resourceId"],
      resolvableFrom: [
        {
          pluginId: "azure",
          resourceTypeId: "azure-vnet",
          outputKey: "resourceId",
        },
      ],
    },
  ],
  outputs: [
    { key: "fqdn", label: "FQDN", sensitive: false },
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "administratorLogin", label: "Admin Username", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  resourceSqlDriver: {
    driver: "postgres",
    connectionStringOutputKey: "connectionString",
  },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      unreachableWhen: {
        fieldsEmpty: ["fqdn"],
        title: "Server has no public endpoint reachable from this host.",
        suggestions: [
          "Connect from inside the VNet (jump VM, AKS pod, or Bastion).",
          "Enable public network access on the flexible server (firewall rules required).",
          "Use a self-hosted VPN or ExpressRoute that peers into the server's VNet.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "postgres-connection",
      displayName: "PostgreSQL Connection",
      description: "Connection details for Azure PostgreSQL Flexible Server",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
        { envKey: "PGHOST", outputKey: "fqdn" },
        { envKey: "PGUSER", outputKey: "administratorLogin" },
      ],
    },
  ],
};
