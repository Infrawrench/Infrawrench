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
          { id: "1.35", label: "1.35" },
          { id: "1.34", label: "1.34" },
          { id: "1.33", label: "1.33" },
          { id: "1.32", label: "1.32" },
          { id: "1.31", label: "1.31" },
        ],
        defaultValue: "1.34",
      },
      {
        key: "nodeSize",
        label: "Node VM Size",
        kind: "size-picker",
        required: true,
        sizes: [
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
        defaultValue: "Standard_D2s_v5",
      },
      {
        key: "nodeCount",
        label: "Node Count",
        kind: "number",
        required: true,
        defaultValue: "2",
        minValue: 1,
        stepValue: 1,
      },
      {
        key: "osDiskSizeGb",
        label: "OS Disk Size",
        kind: "disk-slider",
        required: false,
        minGb: 30,
        maxGb: 1024,
        defaultGb: 100,
        stepGb: 10,
      },
      {
        key: "networkPlugin",
        label: "Network Plugin",
        kind: "select",
        required: false,
        defaultValue: "azure",
        options: [
          { id: "kubenet", label: "kubenet" },
          { id: "azure", label: "azure" },
          { id: "azure-cni", label: "azure-cni" },
        ],
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
  const nodeCount = Number(fields["nodeCount"] ?? "2");
  const osDiskSizeGb = fields["osDiskSizeGb"] ? Number(fields["osDiskSizeGb"]) : undefined;
  const networkPlugin = fields["networkPlugin"] ?? "azure";

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
            ...(osDiskSizeGb != null ? { osDiskSizeGB: osDiskSizeGb } : {}),
          },
        ],
        networkProfile: {
          networkPlugin,
        },
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
      networkPlugin,
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
