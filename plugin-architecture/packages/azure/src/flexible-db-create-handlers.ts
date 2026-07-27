import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getFlexibleDBCreateConfig(
  ctx: AzureCreateContext,
  dbEngine: string,
  versions: string[],
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: `${dbEngine} Server Name`,
        kind: "text",
        required: true,
        description: `Globally unique ${dbEngine} server name`,
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
        key: "version",
        label: `${dbEngine} Version`,
        kind: "select",
        required: true,
        defaultValue: versions[0]!,
        options: versions.map((v) => ({ id: v, label: v })),
      },
      {
        key: "sku",
        label: "Compute Tier",
        kind: "size-picker",
        required: true,
        sizes: [
          {
            id: "Standard_B1ms",
            label: "B1ms",
            vcpus: 1,
            memoryMb: 2048,
            category: "Burstable",
          },
          {
            id: "Standard_B2s",
            label: "B2s",
            vcpus: 2,
            memoryMb: 4096,
            category: "Burstable",
          },
          {
            id: "Standard_B2ms",
            label: "B2ms",
            vcpus: 2,
            memoryMb: 8192,
            category: "Burstable",
          },
          {
            id: "Standard_D2ds_v4",
            label: "D2ds v4",
            vcpus: 2,
            memoryMb: 8192,
            category: "General Purpose",
          },
          {
            id: "Standard_D4ds_v4",
            label: "D4ds v4",
            vcpus: 4,
            memoryMb: 16384,
            category: "General Purpose",
          },
          {
            id: "Standard_D8ds_v4",
            label: "D8ds v4",
            vcpus: 8,
            memoryMb: 32768,
            category: "General Purpose",
          },
          {
            id: "Standard_E2ds_v4",
            label: "E2ds v4",
            vcpus: 2,
            memoryMb: 16384,
            category: "Memory Optimized",
          },
          {
            id: "Standard_E4ds_v4",
            label: "E4ds v4",
            vcpus: 4,
            memoryMb: 32768,
            category: "Memory Optimized",
          },
        ],
      },
      {
        key: "storageSizeGb",
        label: "Storage Size",
        kind: "disk-slider",
        required: true,
        minGb: 32,
        maxGb: 16384,
        defaultGb: 128,
        stepGb: 32,
      },
      {
        key: "adminUsername",
        label: "Admin Username",
        kind: "text",
        required: true,
        defaultValue: "adminuser",
      },
      {
        key: "adminPassword",
        label: "Admin Password",
        kind: "text",
        required: true,
        description: "Must meet Azure password complexity requirements",
      },
    ],
  };
}

export async function createFlexibleDB(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
  typeId: string,
  resourceProvider: string,
  apiVersion: string,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const version = fields["version"]!;
  const sku = fields["sku"]!;
  const storageSizeGb = Number(fields["storageSizeGb"] ?? "128");
  const adminUsername = fields["adminUsername"] ?? "adminuser";
  const adminPassword = fields["adminPassword"] ?? "";

  const tier = sku.startsWith("Standard_B")
    ? "Burstable"
    : sku.startsWith("Standard_E")
      ? "MemoryOptimized"
      : "GeneralPurpose";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${resourceProvider}/${name}?api-version=${apiVersion}`,
    {
      location,
      sku: { name: sku, tier },
      properties: {
        version,
        administratorLogin: adminUsername,
        administratorLoginPassword: adminPassword,
        storage: { storageSizeGB: storageSizeGb },
        backup: { backupRetentionDays: 7 },
      },
    },
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
      state: String(props?.["state"] ?? "Creating"),
      version,
      sku,
      tier,
      storageSizeGb,
      haEnabled: false,
      backupRetentionDays: 7,
    },
    resolvedOutputs: {
      fqdn: String(props?.["fullyQualifiedDomainName"] ?? ""),
      administratorLogin: adminUsername,
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
