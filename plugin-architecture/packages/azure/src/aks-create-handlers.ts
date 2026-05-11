import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getAKSCreateConfig(ctx: AzureCreateContext): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Cluster Name",
        kind: "text",
        required: true,
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
        key: "kubernetesVersion",
        label: "Kubernetes Version",
        kind: "select",
        required: true,
        options: [
          { id: "1.30", label: "1.30" },
          { id: "1.29", label: "1.29" },
          { id: "1.28", label: "1.28" },
        ],
        defaultValue: "1.30",
      },
      {
        key: "nodeSize",
        label: "Node VM Size",
        kind: "size-picker",
        required: true,
        sizes: [
          {
            id: "Standard_B2s",
            label: "B2s",
            vcpus: 2,
            memoryMb: 4096,
            category: "Burstable",
          },
          {
            id: "Standard_D2s_v5",
            label: "D2s v5",
            vcpus: 2,
            memoryMb: 8192,
            category: "General purpose",
          },
          {
            id: "Standard_D4s_v5",
            label: "D4s v5",
            vcpus: 4,
            memoryMb: 16384,
            category: "General purpose",
          },
          {
            id: "Standard_D8s_v5",
            label: "D8s v5",
            vcpus: 8,
            memoryMb: 32768,
            category: "General purpose",
          },
          {
            id: "Standard_E2s_v5",
            label: "E2s v5",
            vcpus: 2,
            memoryMb: 16384,
            category: "Memory optimized",
          },
          {
            id: "Standard_E4s_v5",
            label: "E4s v5",
            vcpus: 4,
            memoryMb: 32768,
            category: "Memory optimized",
          },
        ],
      },
      {
        key: "nodeCount",
        label: "Node Count",
        kind: "number",
        required: true,
        defaultValue: "3",
        minValue: 1,
        maxValue: 100,
      },
    ],
  };
}

export async function createAKSCluster(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const k8sVersion = fields["kubernetesVersion"]!;
  const nodeSize = fields["nodeSize"]!;
  const nodeCount = Number(fields["nodeCount"] ?? "3");

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerService/managedClusters/${name}?api-version=2024-01-01`,
    {
      location,
      properties: {
        kubernetesVersion: k8sVersion,
        dnsPrefix: `${name}-dns`,
        agentPoolProfiles: [
          {
            name: "nodepool1",
            count: nodeCount,
            vmSize: nodeSize,
            osType: "Linux",
            mode: "System",
          },
        ],
        servicePrincipalProfile: {
          clientId: ctx.clientId,
          secret: ctx.clientSecret,
        },
      },
      identity: { type: "SystemAssigned" },
    },
  );

  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-aks-cluster", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-aks-cluster",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      kubernetesVersion: k8sVersion,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      powerState: "Running",
      nodeCount,
      nodePoolCount: 1,
      networkPlugin: "",
      tier: "Free",
    },
    resolvedOutputs: {
      fqdn: String(props?.["fqdn"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
