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
    f("delegatedSubnet", "Delegated Subnet", { required: false }),
    f("privateDnsZone", "Private DNS Zone", { required: false }),
    f("keyVaultName", "Encryption Key Vault", {
      required: false,
      description: "Key Vault holding the customer-managed encryption key",
    }),
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
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    { fieldKey: "delegatedSubnet", targetTypeId: "azure-subnet", label: "in subnet" },
    {
      fieldKey: "privateDnsZone",
      targetTypeId: "azure-private-dns-zone",
      targetKey: "name",
      label: "resolves via",
    },
    {
      fieldKey: "keyVaultName",
      targetTypeId: "azure-key-vault",
      targetKey: "name",
      label: "encrypted with",
    },
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
  // Azure has no listable snapshot type here — Flexible Server backups are
  // service-managed and never appear as resources — so the retention window is
  // the whole story, and it is the one thing a policy can meaningfully check.
  // The lister defaults it to 7 when ARM omits `properties.backup`, which is
  // Azure's own default, so a value of 0 really does mean disabled.
  backupPolicy: { protectedBy: [], retentionDaysFieldKey: "backupRetentionDays" },
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
