import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getAppServiceCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "App Name",
        kind: "text",
        required: true,
        description: "Globally unique name (becomes <name>.azurewebsites.net)",
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
        key: "runtime",
        label: "Runtime Stack",
        kind: "select",
        required: true,
        defaultValue: "NODE|20-lts",
        options: [
          { id: "NODE|20-lts", label: "Node.js 20 LTS" },
          { id: "NODE|18-lts", label: "Node.js 18 LTS" },
          { id: "PYTHON|3.12", label: "Python 3.12" },
          { id: "PYTHON|3.11", label: "Python 3.11" },
          { id: "DOTNETCORE|8.0", label: ".NET 8" },
          { id: "DOTNETCORE|6.0", label: ".NET 6" },
          { id: "JAVA|17-java17", label: "Java 17" },
          { id: "PHP|8.3", label: "PHP 8.3" },
          { id: "GO|1.21", label: "Go 1.21" },
        ],
      },
      {
        key: "sku",
        label: "App Service Plan SKU",
        kind: "select",
        required: true,
        defaultValue: "B1",
        options: [
          { id: "F1", label: "Free (F1)" },
          { id: "B1", label: "Basic B1 (~$13/mo)" },
          { id: "B2", label: "Basic B2 (~$26/mo)" },
          { id: "S1", label: "Standard S1 (~$69/mo)" },
          { id: "S2", label: "Standard S2 (~$138/mo)" },
          { id: "P1v3", label: "Premium v3 P1 (~$138/mo)" },
          { id: "P2v3", label: "Premium v3 P2 (~$276/mo)" },
        ],
      },
    ],
  };
}

export async function createAppService(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const runtime = fields["runtime"] ?? "NODE|20-lts";
  const sku = fields["sku"] ?? "B1";

  const planName = `${name}-plan`;
  await ctx.put(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2023-01-01`,
    {
      location,
      kind: "linux",
      properties: { reserved: true },
      sku: { name: sku },
    },
  );

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}?api-version=2023-01-01`,
    {
      location,
      kind: "app,linux",
      properties: {
        serverFarmId: `/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}`,
        siteConfig: {
          linuxFxVersion: runtime,
        },
        httpsOnly: true,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-app-service", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-app-service",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      state: String(props?.["state"] ?? "Running"),
      kind: "app,linux",
      appServicePlan: planName,
      httpsOnly: true,
      linuxFxVersion: runtime,
    },
    resolvedOutputs: {
      defaultHostName: String(props?.["defaultHostName"] ?? `${name}.azurewebsites.net`),
      outboundIpAddresses: String(props?.["outboundIpAddresses"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
