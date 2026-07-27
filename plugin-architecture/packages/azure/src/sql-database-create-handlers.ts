import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getSQLDatabaseCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  const servers = await ctx.get<{ value: Array<{ name: string; id: string }> }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Sql/servers?api-version=2023-05-01-preview`,
  );
  const serverOptions = (servers.value ?? []).map((s) => {
    const sRg = s.id.match(/resourceGroups\/([^/]+)/i)?.[1] ?? "";
    return { id: `${sRg}/${s.name}`, label: s.name };
  });

  return {
    fields: [
      { key: "databaseName", label: "Database Name", kind: "text", required: true },
      ...(serverOptions.length > 0
        ? [
            {
              key: "existingServer" as const,
              label: "Existing SQL Server",
              kind: "select" as const,
              required: false,
              options: [{ id: "", label: "(Create new server)" }, ...serverOptions],
              description: "Select an existing server or create a new one",
            },
          ]
        : []),
      {
        key: "serverName",
        label: "New SQL Server Name",
        kind: "text",
        required: false,
        description: "Globally unique server name (only if creating new server)",
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
        key: "adminUsername",
        label: "Server Admin Username",
        kind: "text",
        required: false,
        defaultValue: "sqladmin",
        description: "Only for new server",
      },
      {
        key: "adminPassword",
        label: "Server Admin Password",
        kind: "text",
        required: false,
        description: "Only for new server. Must meet complexity requirements.",
      },
      {
        key: "sku",
        label: "Pricing Tier",
        kind: "select",
        required: true,
        defaultValue: "Basic",
        options: [
          { id: "Basic", label: "Basic (5 DTU, ~$5/mo)" },
          { id: "S0", label: "Standard S0 (10 DTU, ~$15/mo)" },
          { id: "S1", label: "Standard S1 (20 DTU, ~$30/mo)" },
          { id: "S2", label: "Standard S2 (50 DTU, ~$75/mo)" },
          { id: "P1", label: "Premium P1 (125 DTU, ~$465/mo)" },
          { id: "GP_S_Gen5_1", label: "General Purpose Serverless (1 vCore)" },
          { id: "GP_Gen5_2", label: "General Purpose Provisioned (2 vCores)" },
        ],
      },
      {
        key: "maxSizeGb",
        label: "Max Size",
        kind: "select",
        required: true,
        defaultValue: "2",
        options: [
          { id: "1", label: "1 GB" },
          { id: "2", label: "2 GB" },
          { id: "5", label: "5 GB" },
          { id: "10", label: "10 GB" },
          { id: "50", label: "50 GB" },
          { id: "100", label: "100 GB" },
          { id: "250", label: "250 GB" },
        ],
      },
    ],
  };
}

export async function createSQLDatabase(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const dbName = fields["databaseName"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const existingServer = fields["existingServer"] ?? "";
  const skuName = fields["sku"] ?? "Basic";
  const maxSizeGb = Number(fields["maxSizeGb"] ?? "2");

  let serverName: string;
  let serverRg: string;

  if (existingServer) {
    const parts = existingServer.split("/");
    serverRg = parts[0] ?? "";
    serverName = parts[1] ?? "";
  } else {
    serverName = fields["serverName"]!;
    serverRg = rg;
    const adminUsername = fields["adminUsername"] ?? "sqladmin";
    const adminPassword = fields["adminPassword"] ?? "";

    // Create SQL Server
    await ctx.put(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${serverRg}/providers/Microsoft.Sql/servers/${serverName}?api-version=2023-05-01-preview`,
      {
        location,
        properties: {
          administratorLogin: adminUsername,
          administratorLoginPassword: adminPassword,
        },
      },
    );
  }

  const isVCoreBased =
    skuName.startsWith("GP_") || skuName.startsWith("BC_") || skuName.startsWith("HS_");
  const tier =
    skuName === "Basic"
      ? "Basic"
      : skuName.startsWith("S")
        ? "Standard"
        : skuName.startsWith("P")
          ? "Premium"
          : skuName.startsWith("GP_")
            ? "GeneralPurpose"
            : skuName.startsWith("BC_")
              ? "BusinessCritical"
              : "GeneralPurpose";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${serverRg}/providers/Microsoft.Sql/servers/${serverName}/databases/${dbName}?api-version=2023-05-01-preview`,
    {
      location,
      sku: { name: skuName, tier },
      properties: {
        maxSizeBytes: isVCoreBased ? undefined : maxSizeGb * 1073741824,
        collation: "SQL_Latin1_General_CP1_CI_AS",
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-sql-database", `${serverRg}/${serverName}/${dbName}`),
    pluginId: "azure",
    resourceTypeId: "azure-sql-database",
    accountId,
    displayName: `${serverName}/${dbName}`,
    fields: {
      name: dbName,
      serverName,
      resourceGroup: serverRg,
      location,
      status: String(props?.["status"] ?? "Creating"),
      edition: tier,
      serviceLevelObjective: skuName,
      maxSizeBytes: maxSizeGb * 1073741824,
      collation: "SQL_Latin1_General_CP1_CI_AS",
      zoneRedundant: false,
    },
    resolvedOutputs: {
      serverFqdn: `${serverName}.database.windows.net`,
    },
    secretStates: [],
    externalId: `${serverRg}/${serverName}/${dbName}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
