import { f, o, rt } from "@infrawrench/plugin-base";
import { MYSQL_FLEXIBLE_EXTENDED_SUPPORT } from "../extended-support.js";

export const MySQLFlexibleServerResourceType = rt({
  name: "MySQL Flexible Server",
  id: "azure-mysql-flexible",
  carbon: {
    regionFieldKey: "location",
    vcpus: { from: "size", sizeFieldKey: "sku" },
  },
  description: "An Azure Database for MySQL Flexible Server",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("state", "State"),
    f("version", "MySQL Version", { required: false }),
    f("sku", "SKU", { required: false }),
    f("tier", "Tier", { required: false }),
    f("billableVCores", "Billable vCores", {
      kind: "number",
      required: false,
      editable: false,
      description: "vCores extended support bills on, including a high-availability standby",
    }),
    f("storageSizeGb", "Storage (GB)", { kind: "number", required: false }),
    f("haEnabled", "HA Enabled", { kind: "boolean", required: false }),
    f("backupRetentionDays", "Backup Retention (Days)", { kind: "number", required: false }),
    f("delegatedSubnet", "Delegated Subnet", { required: false }),
    f("privateDnsZone", "Private DNS Zone", { required: false }),
    f("keyVaultName", "Encryption Key Vault", {
      required: false,
      description: "Key Vault holding the customer-managed encryption key",
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
  extendedSupport: MYSQL_FLEXIBLE_EXTENDED_SUPPORT,
  iconKey: "database",
  // Sleep/wake schedules: flexibleServers start / stop. Compute stops billing;
  // Azure restarts a stopped server by itself after 30 days.
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["Ready"],
    stoppedValues: ["Stopped"],
  },
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
  // As on the PostgreSQL flexible server next door: no listable snapshot type,
  // so the retention window is the only protection signal, and the only one
  // a policy can check.
  backupPolicy: { protectedBy: [], retentionDaysFieldKey: "backupRetentionDays" },
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
