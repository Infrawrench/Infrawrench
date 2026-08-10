import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

function storageSku(sku: string): { tier: string; replication: string } | null {
  const match = /^(Standard|Premium)_([A-Z0-9]+)$/i.exec(sku);
  if (!match) return null;
  return { tier: match[1]!, replication: match[2]! };
}

/**
 * Terraform mapping for Azure — provider `hashicorp/azurerm`.
 *
 * VM, AKS, SQL database, Cosmos DB, App Service, and PostgreSQL Flexible
 * Server require nested blocks or credentials that the listers do not
 * persist, so they are not exported.
 */
export const azureTerraformExport: TerraformExportCapability = {
  provider: { name: "azurerm", source: "hashicorp/azurerm", version: "~> 5.0" },
  providerConfig: {
    // Required empty block — rendered as `features {}` (not `features = {}`).
    features: tf.block(),
    subscription_id: tf.ref("var.azure_subscription_id"),
    tenant_id: tf.ref("var.azure_tenant_id"),
    client_id: tf.ref("var.azure_client_id"),
    client_secret: tf.ref("var.azure_client_secret"),
  },
  variables: [
    { name: "azure_subscription_id", description: "Azure subscription ID" },
    { name: "azure_tenant_id", description: "Microsoft Entra tenant ID" },
    { name: "azure_client_id", description: "Azure service principal client ID" },
    {
      name: "azure_client_secret",
      description: "Azure service principal client secret",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "azure-resource-group",
    "azure-vnet",
    "azure-subnet",
    "azure-nsg",
    "azure-storage-account",
    "azure-dns-zone",
    "azure-key-vault",
    "azure-redis-cache",
  ],
  mapResource(resource): TerraformExportResult | null {
    switch (resource.resourceTypeId) {
      case "azure-resource-group": {
        const name = fieldString(resource, "name") || resource.displayName;
        const location = fieldString(resource, "location");
        if (!name || !location) return null;
        return {
          resource: {
            type: "azurerm_resource_group",
            name,
            attributes: { name: tf.str(name), location: tf.str(location) },
            importId: resource.externalId,
          },
        };
      }
      case "azure-vnet": {
        const name = fieldString(resource, "name") || resource.displayName;
        const resourceGroup = fieldString(resource, "resourceGroup");
        const location = fieldString(resource, "location");
        const prefixes = fieldString(resource, "addressPrefixes");
        if (!name || !resourceGroup || !location || !prefixes) return null;
        const addressSpace = prefixes
          .split(",")
          .map((prefix) => prefix.trim())
          .filter(Boolean)
          .map(tf.str);
        if (addressSpace.length === 0) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          resource_group_name: tf.str(resourceGroup),
          location: tf.str(location),
          address_space: tf.list(addressSpace),
        };
        return {
          resource: {
            type: "azurerm_virtual_network",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "azure-subnet": {
        const name = fieldString(resource, "name") || resource.displayName;
        const resourceGroup = fieldString(resource, "resourceGroup");
        const vnetName = fieldString(resource, "vnetName");
        const addressPrefix = fieldString(resource, "addressPrefix");
        if (!name || !resourceGroup || !vnetName || !addressPrefix) return null;
        return {
          resource: {
            type: "azurerm_subnet",
            name,
            attributes: {
              name: tf.str(name),
              resource_group_name: tf.str(resourceGroup),
              virtual_network_name: tf.str(vnetName),
              address_prefixes: tf.list([tf.str(addressPrefix)]),
            },
            importId: resource.externalId,
          },
        };
      }
      case "azure-nsg": {
        const name = fieldString(resource, "name") || resource.displayName;
        const resourceGroup = fieldString(resource, "resourceGroup");
        const location = fieldString(resource, "location");
        if (!name || !resourceGroup || !location) return null;
        return {
          resource: {
            type: "azurerm_network_security_group",
            name,
            attributes: {
              name: tf.str(name),
              resource_group_name: tf.str(resourceGroup),
              location: tf.str(location),
            },
            importId: resource.externalId,
            comments: ["Security rules are not persisted; add them before applying."],
          },
        };
      }
      case "azure-storage-account": {
        const name = fieldString(resource, "name") || resource.displayName;
        const resourceGroup = fieldString(resource, "resourceGroup");
        const location = fieldString(resource, "location");
        const sku = fieldString(resource, "sku");
        if (!name || !resourceGroup || !location || !sku) return null;
        const parsedSku = storageSku(sku);
        if (!parsedSku) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          resource_group_name: tf.str(resourceGroup),
          location: tf.str(location),
          account_tier: tf.str(parsedSku.tier),
          account_replication_type: tf.str(parsedSku.replication),
        };
        const kind = fieldString(resource, "kind");
        if (kind) attributes["account_kind"] = tf.str(kind);
        const accessTier = fieldString(resource, "accessTier");
        if (accessTier) attributes["access_tier"] = tf.str(accessTier);
        if (fieldBool(resource, "httpsOnly"))
          attributes["https_traffic_only_enabled"] = tf.bool(true);
        return {
          resource: {
            type: "azurerm_storage_account",
            name,
            attributes,
            importId: resource.externalId,
          },
        };
      }
      case "azure-dns-zone": {
        const name = fieldString(resource, "name") || resource.displayName;
        const resourceGroup = fieldString(resource, "resourceGroup");
        if (!name || !resourceGroup) return null;
        if (fieldString(resource, "zoneType")?.toLowerCase() === "private") return null;
        return {
          resource: {
            type: "azurerm_dns_zone",
            name,
            attributes: { name: tf.str(name), resource_group_name: tf.str(resourceGroup) },
            importId: resource.externalId,
          },
        };
      }
      case "azure-key-vault": {
        const name = fieldString(resource, "name") || resource.displayName;
        const resourceGroup = fieldString(resource, "resourceGroup");
        const location = fieldString(resource, "location");
        const sku = fieldString(resource, "sku");
        if (!name || !resourceGroup || !location || !sku) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          resource_group_name: tf.str(resourceGroup),
          location: tf.str(location),
          tenant_id: tf.ref("var.azure_tenant_id"),
          sku_name: tf.str(sku.toLowerCase()),
          rbac_authorization_enabled: tf.bool(fieldBool(resource, "enableRbacAuthorization")),
        };
        if (fieldBool(resource, "enablePurgeProtection"))
          attributes["purge_protection_enabled"] = tf.bool(true);
        return {
          resource: {
            type: "azurerm_key_vault",
            name,
            attributes,
            importId: resource.externalId,
            comments: ["Access policies and role assignments are not retained by the lister."],
          },
        };
      }
      case "azure-redis-cache": {
        const name = fieldString(resource, "name") || resource.displayName;
        const resourceGroup = fieldString(resource, "resourceGroup");
        const location = fieldString(resource, "location");
        const sku = fieldString(resource, "sku");
        const capacity = fieldNumber(resource, "capacity");
        if (!name || !resourceGroup || !location || !sku || capacity === undefined) return null;
        return {
          resource: {
            type: "azurerm_redis_cache",
            name,
            attributes: {
              name: tf.str(name),
              resource_group_name: tf.str(resourceGroup),
              location: tf.str(location),
              capacity: tf.num(capacity),
              family: tf.str(sku.toLowerCase() === "premium" ? "P" : "C"),
              sku_name: tf.str(sku),
              enable_non_ssl_port: tf.bool(fieldBool(resource, "nonSslPort")),
            },
            importId: resource.externalId,
          },
        };
      }
      default:
        return null;
    }
  },
};
