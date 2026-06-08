import { f, o, rt } from "@infrawrench/plugin-base";

export const PostgresFlexibleServerResourceType = rt({
  name: "PostgreSQL Flexible Server",
  id: "azure-postgres-flexible",
  description: "An Azure Database for PostgreSQL Flexible Server",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("state", "State"),
    f("version", "PostgreSQL Version", { required: false }),
    f("sku", "SKU", { required: false }),
    f("tier", "Tier", { required: false }),
    f("storageSizeGb", "Storage (GB)", { kind: "number", required: false }),
    f("haEnabled", "HA Enabled", { kind: "boolean", required: false }),
    f("backupRetentionDays", "Backup Retention (Days)", { kind: "number", required: false }),
    f("network", "Virtual Network", {
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
    }),
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
});
