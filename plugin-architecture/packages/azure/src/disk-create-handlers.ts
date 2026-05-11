import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getDiskCreateConfig(ctx: AzureCreateContext): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: "Disk Name", kind: "text", required: true },
      {
        key: "resourceGroup",
        label: "Resource Group",
        kind: "select",
        required: true,
        options: rgOptions,
      },
      {
        key: "region",
        label: "Region",
        kind: "region-picker",
        required: true,
        regions: AZURE_REGIONS,
      },
      {
        key: "sku",
        label: "Disk Type",
        kind: "select",
        required: true,
        defaultValue: "Premium_LRS",
        options: [
          { id: "Standard_LRS", label: "Standard HDD (LRS)" },
          { id: "StandardSSD_LRS", label: "Standard SSD (LRS)" },
          { id: "Premium_LRS", label: "Premium SSD (LRS)" },
          { id: "PremiumV2_LRS", label: "Premium SSD v2 (LRS)" },
          { id: "UltraSSD_LRS", label: "Ultra Disk" },
        ],
      },
      {
        key: "diskSizeGb",
        label: "Size",
        kind: "disk-slider",
        required: true,
        minGb: 1,
        maxGb: 32767,
        defaultGb: 128,
        stepGb: 1,
      },
    ],
  };
}

export async function createDisk(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Premium_LRS";
  const diskSizeGb = Number(fields["diskSizeGb"] ?? "128");

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Compute/disks/${name}?api-version=2023-10-02`,
    {
      location,
      sku: { name: sku },
      properties: {
        diskSizeGB: diskSizeGb,
        creationData: { createOption: "Empty" },
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-disk", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-disk",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      diskSizeGb,
      diskState: "Unattached",
      sku,
      osType: "",
      managedBy: "",
      encryption: String(props?.["encryption"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
