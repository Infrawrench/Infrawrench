import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MySQLFlexibleServerResourceType: ResourceTypeDefinition = {
  id: "azure-mysql-flexible",
  displayName: "MySQL Flexible Server",
  pluralDisplayName: "MySQL Flexible Servers",
  description: "An Azure Database for MySQL Flexible Server",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: true },
    { key: "version", label: "MySQL Version", kind: "string", required: false },
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
  ],
  outputs: [
    { key: "fqdn", label: "FQDN", sensitive: false },
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "administratorLogin", label: "Admin Username", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  secretExportTemplates: [
    {
      id: "mysql-connection",
      displayName: "MySQL Connection",
      description: "Connection details for Azure MySQL Flexible Server",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
        { envKey: "MYSQL_HOST", outputKey: "fqdn" },
        { envKey: "MYSQL_USER", outputKey: "administratorLogin" },
      ],
    },
  ],
};
