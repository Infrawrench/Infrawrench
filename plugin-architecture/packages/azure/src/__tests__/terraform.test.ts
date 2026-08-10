import { describe, expect, it } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { azureTerraformExport } from "../terraform.js";

function resource(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
): ResourceInstance {
  return {
    id: `account:${resourceTypeId}:example`,
    pluginId: "azure",
    resourceTypeId,
    accountId: "account",
    displayName: "example",
    fields,
    resolvedOutputs: {},
    secretStates: [],
    externalId: "/subscriptions/example/resourceGroups/rg/providers/Microsoft.Example/example",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("azureTerraformExport", () => {
  it("maps a resource group", () => {
    expect(
      azureTerraformExport.mapResource(
        resource("azure-resource-group", { name: "rg-main", location: "westeurope" }),
      ),
    ).toMatchObject({
      resource: {
        type: "azurerm_resource_group",
        attributes: { location: { value: "westeurope" } },
      },
    });
  });

  it("maps a virtual network", () => {
    expect(
      azureTerraformExport.mapResource(
        resource("azure-vnet", {
          name: "vnet-main",
          resourceGroup: "rg-main",
          location: "westeurope",
          addressPrefixes: "10.0.0.0/16, 10.1.0.0/16",
        }),
      ),
    ).toMatchObject({
      resource: {
        type: "azurerm_virtual_network",
        attributes: {
          address_space: {
            items: [
              { kind: "string", value: "10.0.0.0/16" },
              { kind: "string", value: "10.1.0.0/16" },
            ],
          },
        },
      },
    });
  });

  it("maps a storage account SKU", () => {
    expect(
      azureTerraformExport.mapResource(
        resource("azure-storage-account", {
          name: "storageexample",
          resourceGroup: "rg-main",
          location: "westeurope",
          sku: "Standard_LRS",
        }),
      ),
    ).toMatchObject({
      resource: {
        type: "azurerm_storage_account",
        attributes: {
          account_tier: { value: "Standard" },
          account_replication_type: { value: "LRS" },
        },
      },
    });
  });
});
