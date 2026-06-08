import { f, o, rt } from "@infrawrench/plugin-base";

export const MySQLFlexibleServerResourceType = rt({
  name: "MySQL Flexible Server",
  id: "azure-mysql-flexible",
  description: "An Azure Database for MySQL Flexible Server",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("state", "State"),
    f("version", "MySQL Version", { required: false }),
    f("sku", "SKU", { required: false }),
    f("tier", "Tier", { required: false }),
    f("storageSizeGb", "Storage (GB)", { kind: "number", required: false }),
    f("haEnabled", "HA Enabled", { kind: "boolean", required: false }),
    f("backupRetentionDays", "Backup Retention (Days)", { kind: "number", required: false }),
  ],
  outputs: [
    o("fqdn", "FQDN"),
    o("connectionString", "Connection String", { sensitive: true }),
    o("administratorLogin", "Admin Username"),
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
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
});
