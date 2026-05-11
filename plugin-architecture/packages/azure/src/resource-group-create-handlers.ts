import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, type AzureCreateContext } from "./create-handlers-shared.js";

export async function createResourceGroup(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const location = fields["region"]!;
  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups/${name}?api-version=2022-09-01`,
    { location },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-resource-group", name),
    pluginId: "azure",
    resourceTypeId: "azure-resource-group",
    accountId,
    displayName: name,
    fields: {
      name,
      location,
      provisioningState: String(props?.["provisioningState"] ?? "Succeeded"),
    },
    resolvedOutputs: { resourceId: String(result["id"] ?? "") },
    secretStates: [],
    externalId: name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
