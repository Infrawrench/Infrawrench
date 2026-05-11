import type { CreateResourceConfig } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getLoadBalancerCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Load Balancer Name",
        kind: "text",
        required: true,
        description: "Name for the load balancer",
      },
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
        label: "SKU",
        kind: "select",
        required: true,
        options: [
          { id: "Standard", label: "Standard" },
          { id: "Basic", label: "Basic" },
        ],
        defaultValue: "Standard",
      },
    ],
  };
}
