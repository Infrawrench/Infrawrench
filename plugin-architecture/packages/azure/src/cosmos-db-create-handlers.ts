import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getCosmosDBCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Account Name",
        kind: "text",
        required: true,
        description: "Globally unique Cosmos DB account name",
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
        key: "kind",
        label: "API",
        kind: "select",
        required: true,
        defaultValue: "GlobalDocumentDB",
        options: [
          { id: "GlobalDocumentDB", label: "NoSQL (Core)" },
          { id: "MongoDB", label: "MongoDB" },
        ],
      },
      {
        key: "consistencyLevel",
        label: "Consistency Level",
        kind: "select",
        required: true,
        defaultValue: "Session",
        options: [
          { id: "Strong", label: "Strong" },
          { id: "BoundedStaleness", label: "Bounded Staleness" },
          { id: "Session", label: "Session" },
          { id: "ConsistentPrefix", label: "Consistent Prefix" },
          { id: "Eventual", label: "Eventual" },
        ],
      },
    ],
  };
}

export async function createCosmosDB(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const kind = fields["kind"] ?? "GlobalDocumentDB";
  const consistencyLevel = fields["consistencyLevel"] ?? "Session";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.DocumentDB/databaseAccounts/${name}?api-version=2023-11-15`,
    {
      location,
      kind,
      properties: {
        databaseAccountOfferType: "Standard",
        locations: [{ locationName: location, failoverPriority: 0 }],
        consistencyPolicy: { defaultConsistencyLevel: consistencyLevel },
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-cosmos-db", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-cosmos-db",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      kind,
      databaseAccountOfferType: "Standard",
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      consistencyLevel,
      enableAutomaticFailover: false,
      enableMultipleWriteLocations: false,
      readLocations: location,
      writeLocations: location,
    },
    resolvedOutputs: {
      documentEndpoint: String(
        props?.["documentEndpoint"] ?? `https://${name}.documents.azure.com:443/`,
      ),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
