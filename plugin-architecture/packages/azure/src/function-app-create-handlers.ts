import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getFunctionAppCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  // List storage accounts for the required storage binding
  const storageAccounts = await ctx.get<{ value: Array<{ id: string; name: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`,
  );
  const saOptions = (storageAccounts.value ?? []).map((sa) => {
    const saRg = sa.id.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "";
    return { id: `${saRg}/${sa.name}`, label: sa.name };
  });

  return {
    fields: [
      {
        key: "name",
        label: "Function App Name",
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
        defaultValue: "node",
        options: [
          { id: "node", label: "Node.js" },
          { id: "python", label: "Python" },
          { id: "dotnet-isolated", label: ".NET (Isolated)" },
          { id: "java", label: "Java" },
          { id: "powershell", label: "PowerShell" },
        ],
      },
      {
        key: "runtimeVersion",
        label: "Runtime Version",
        kind: "select",
        required: true,
        defaultValue: "~4",
        options: [{ id: "~4", label: "Functions v4" }],
      },
      {
        key: "storageAccount",
        label: "Storage Account",
        kind: "select",
        required: true,
        options: saOptions,
        description: "Storage account required for function triggers and state",
      },
      {
        key: "sku",
        label: "Hosting Plan",
        kind: "select",
        required: true,
        defaultValue: "Y1",
        options: [
          { id: "Y1", label: "Consumption (Serverless, pay per execution)" },
          { id: "B1", label: "Basic B1 (~$13/mo)" },
          { id: "S1", label: "Standard S1 (~$69/mo)" },
          { id: "EP1", label: "Elastic Premium EP1 (~$171/mo)" },
        ],
      },
    ],
  };
}

export async function createFunctionApp(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const runtime = fields["runtime"] ?? "node";
  const runtimeVersion = fields["runtimeVersion"] ?? "~4";
  const storageRef = fields["storageAccount"] ?? "";
  const [storageRg, storageAccountName] = storageRef.split("/");
  const sku = fields["sku"] ?? "Y1";

  // Create consumption plan
  const planName = `${name}-plan`;
  const isConsumption = sku === "Y1";
  await ctx.put(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}?api-version=2023-01-01`,
    {
      location,
      kind: "functionapp",
      properties: { reserved: true },
      sku: { name: sku, tier: isConsumption ? "Dynamic" : undefined },
    },
  );

  // Get storage account key
  const storageKeys = await ctx.post<{ keys?: Array<{ value: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${storageRg}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/listKeys?api-version=2023-01-01`,
    {},
  );
  const storageKey = storageKeys.keys?.[0]?.value ?? "";
  const storageConnStr = `DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageKey};EndpointSuffix=core.windows.net`;

  // Create function app
  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}?api-version=2023-01-01`,
    {
      location,
      kind: "functionapp,linux",
      properties: {
        serverFarmId: `/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${planName}`,
        siteConfig: {
          linuxFxVersion: "",
          appSettings: [
            { name: "FUNCTIONS_EXTENSION_VERSION", value: runtimeVersion },
            { name: "FUNCTIONS_WORKER_RUNTIME", value: runtime },
            { name: "AzureWebJobsStorage", value: storageConnStr },
          ],
        },
        httpsOnly: true,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-function-app", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-function-app",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      state: String(props?.["state"] ?? "Running"),
      kind: "functionapp,linux",
      runtime,
      runtimeVersion,
      appServicePlan: planName,
      httpsOnly: true,
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
