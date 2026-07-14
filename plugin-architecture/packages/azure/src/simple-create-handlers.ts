import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getSimpleCreateConfig(
  ctx: AzureCreateContext,
  nameLabel: string,
  description: string,
  _typeId: string,
  options?: { includeRegion?: boolean },
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: nameLabel, kind: "text", required: true, description },
      {
        key: "resourceGroup",
        label: "Resource Group",
        kind: "select",
        required: true,
        options: rgOptions,
      },
      ...(options?.includeRegion === false
        ? []
        : [
            {
              key: "region",
              label: "Region",
              kind: "region-picker" as const,
              required: true,
              regions: AZURE_REGIONS,
            },
          ]),
    ],
  };
}

export async function createSimpleResource(
  ctx: AzureCreateContext,
  accountId: string,
  typeId: string,
  fields: Record<string, string>,
  provider: string,
  apiVersion: string,
  extraProperties: Record<string, unknown>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}?api-version=${apiVersion}`,
    { location, properties: extraProperties },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, typeId, `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: typeId,
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
