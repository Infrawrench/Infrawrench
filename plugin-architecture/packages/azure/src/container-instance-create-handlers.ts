import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getContainerInstanceCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: "Container Group Name", kind: "text", required: true },
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
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        description: "Docker image (e.g. mcr.microsoft.com/azuredocs/aci-helloworld:latest)",
      },
      {
        key: "osType",
        label: "OS Type",
        kind: "select",
        required: true,
        defaultValue: "Linux",
        options: [
          { id: "Linux", label: "Linux" },
          { id: "Windows", label: "Windows" },
        ],
      },
      {
        key: "cpu",
        label: "CPU Cores",
        kind: "select",
        required: true,
        defaultValue: "1",
        options: [
          { id: "0.5", label: "0.5 cores" },
          { id: "1", label: "1 core" },
          { id: "2", label: "2 cores" },
          { id: "4", label: "4 cores" },
        ],
      },
      {
        key: "memoryGb",
        label: "Memory (GB)",
        kind: "select",
        required: true,
        defaultValue: "1.5",
        options: [
          { id: "0.5", label: "0.5 GB" },
          { id: "1", label: "1 GB" },
          { id: "1.5", label: "1.5 GB" },
          { id: "2", label: "2 GB" },
          { id: "4", label: "4 GB" },
          { id: "8", label: "8 GB" },
        ],
      },
      {
        key: "port",
        label: "Port",
        kind: "text",
        required: false,
        defaultValue: "80",
        description: "Container port to expose",
      },
      {
        key: "restartPolicy",
        label: "Restart Policy",
        kind: "select",
        required: true,
        defaultValue: "Always",
        options: [
          { id: "Always", label: "Always" },
          { id: "OnFailure", label: "On Failure" },
          { id: "Never", label: "Never" },
        ],
      },
    ],
  };
}

export async function createContainerInstance(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const image = fields["image"]!;
  const osType = fields["osType"] ?? "Linux";
  const cpu = Number(fields["cpu"] ?? "1");
  const memoryGb = Number(fields["memoryGb"] ?? "1.5");
  const port = Number(fields["port"] ?? "80");
  const restartPolicy = fields["restartPolicy"] ?? "Always";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerInstance/containerGroups/${name}?api-version=2023-05-01`,
    {
      location,
      properties: {
        osType,
        restartPolicy,
        containers: [
          {
            name,
            properties: {
              image,
              resources: { requests: { cpu, memoryInGB: memoryGb } },
              ports: [{ port, protocol: "TCP" }],
            },
          },
        ],
        ipAddress: {
          type: "Public",
          ports: [{ port, protocol: "TCP" }],
        },
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  const ipAddr = props?.["ipAddress"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-container-instance", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-container-instance",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      osType,
      restartPolicy,
      containers: 1,
      ipAddress: String(ipAddr?.["ip"] ?? ""),
      fqdn: String(ipAddr?.["fqdn"] ?? ""),
    },
    resolvedOutputs: {
      ipAddress: String(ipAddr?.["ip"] ?? ""),
      fqdn: String(ipAddr?.["fqdn"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
