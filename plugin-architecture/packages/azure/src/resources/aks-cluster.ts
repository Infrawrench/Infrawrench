import { f, o, rt } from "@infrawrench/plugin-base";

export const AKSClusterResourceType = rt({
  name: "AKS Cluster",
  id: "azure-aks-cluster",
  description: "An Azure Kubernetes Service cluster",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("kubernetesVersion", "Kubernetes Version"),
    f("provisioningState", "Provisioning State", {
      kind: "enum",
      enumValues: ["Succeeded", "Creating", "Updating", "Deleting", "Failed", "Upgrading"],
    }),
    f("powerState", "Power State", { required: false }),
    f("nodeCount", "Node Count", { kind: "number", required: false }),
    f("nodePoolCount", "Node Pool Count", { kind: "number", required: false }),
    f("vmSize", "VM Size", { required: false, description: "VM size used by the first node pool" }),
    f("osDiskSizeGb", "OS Disk Size (GB)", {
      kind: "number",
      required: false,
      description: "OS disk size of the first node pool",
    }),
    f("networkPlugin", "Network Plugin", { required: false }),
    f("tier", "Tier", { required: false }),
  ],
  outputs: [
    o("fqdn", "FQDN", { hidden: true, description: "API server FQDN" }),
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Cluster kubeconfig for kubectl access",
    }),
  ],
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
  secretExportTemplates: [
    {
      id: "aks-kubeconfig",
      displayName: "AKS Kubeconfig",
      description: "Kubeconfig YAML for connecting kubectl to this AKS cluster",
      entries: [
        {
          envKey: "KUBECONFIG_DATA",
          outputKey: "kubeconfig",
          description: "Generated kubeconfig YAML",
        },
        { envKey: "KUBE_API_FQDN", outputKey: "fqdn", description: "Kubernetes API server FQDN" },
      ],
    },
  ],
});
