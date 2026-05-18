import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AKSClusterResourceType: ResourceTypeDefinition = {
  id: "azure-aks-cluster",
  displayName: "AKS Cluster",
  pluralDisplayName: "AKS Clusters",
  description: "An Azure Kubernetes Service cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "kubernetesVersion", label: "Kubernetes Version", kind: "string", required: true },
    {
      key: "provisioningState",
      label: "Provisioning State",
      kind: "enum",
      required: true,
      enumValues: ["Succeeded", "Creating", "Updating", "Deleting", "Failed", "Upgrading"],
    },
    { key: "powerState", label: "Power State", kind: "string", required: false },
    { key: "nodeCount", label: "Node Count", kind: "number", required: false },
    { key: "nodePoolCount", label: "Node Pool Count", kind: "number", required: false },
    {
      key: "vmSize",
      label: "VM Size",
      kind: "string",
      required: false,
      description: "VM size used by the first node pool",
    },
    {
      key: "osDiskSizeGb",
      label: "OS Disk Size (GB)",
      kind: "number",
      required: false,
      description: "OS disk size of the first node pool",
    },
    { key: "networkPlugin", label: "Network Plugin", kind: "string", required: false },
    { key: "tier", label: "Tier", kind: "string", required: false },
  ],
  outputs: [
    {
      key: "fqdn",
      label: "FQDN",
      sensitive: false,
      hidden: true,
      description: "API server FQDN",
    },
    {
      key: "kubeconfig",
      label: "Kubeconfig",
      sensitive: true,
      hidden: true,
      description: "Cluster kubeconfig for kubectl access",
    },
  ],
  dashboardPinnable: true,
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
    },
  ],
};
