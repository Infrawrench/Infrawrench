import { f, o, rt } from "@infrawrench/plugin-base";
import { AKS_EXTENDED_SUPPORT } from "../extended-support.js";

export const AKSClusterResourceType = rt({
  name: "AKS Cluster",
  id: "azure-aks-cluster",
  // Node pools are scale sets the Kubernetes plugin lists as nodes; shown here,
  // never summed twice.
  carbon: {
    role: "aggregate",
    regionFieldKey: "location",
    vcpus: { from: "size", sizeFieldKey: "vmSize", catalogueFieldKey: "nodeSize" },
    countFieldKey: "nodeCount",
  },
  description:
    "An Azure Kubernetes Service cluster. Pulling images from an Azure Container Registry requires an AcrPull role assignment for the cluster's kubelet identity (az aks update --attach-acr <registry>), or use a dockerConfigJson pull secret from the registry resource.",
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
    f("supportPlan", "Support Plan", {
      required: false,
      description:
        "AKSLongTermSupport keeps a version patched past community support (Premium tier); KubernetesOfficial does not",
    }),
    f("nodeResourceGroup", "Node Resource Group", {
      required: false,
      description: "Managed resource group AKS creates the node VMSS and disks in",
    }),
    f("subnetRefs", "Node Subnets", {
      required: false,
      description: "Subnets the agent pools are placed in",
    }),
    f("logAnalyticsWorkspace", "Log Analytics Workspace", { required: false }),
    f("managedIdentities", "Managed Identities", { required: false }),
  ],
  outputs: [
    o("fqdn", "FQDN", { hidden: true, description: "API server FQDN" }),
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Cluster kubeconfig for kubectl access",
    }),
    o("nodeHourlyRates", "Node Hourly Rates", {
      hidden: true,
      description:
        "JSON map of node instance type to hourly price, handed to the Kubernetes peer so it can derive per-namespace and per-workload cost. Empty when no price is available.",
    }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    {
      fieldKey: "nodeResourceGroup",
      targetTypeId: "azure-resource-group",
      label: "node resources in",
    },
    { fieldKey: "subnetRefs", targetTypeId: "azure-subnet", label: "nodes in subnet" },
    {
      fieldKey: "logAnalyticsWorkspace",
      targetTypeId: "azure-log-analytics",
      targetKey: "name",
      label: "logs to",
    },
    {
      fieldKey: "managedIdentities",
      targetTypeId: "azure-managed-identity",
      targetKey: "name",
      label: "runs as",
    },
  ],
  extendedSupport: AKS_EXTENDED_SUPPORT,
  iconKey: "kubernetes",
  // Sleep/wake schedules: managedClusters start / stop. Stop deallocates the
  // control plane and every node pool, so compute billing stops; state is kept.
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "powerState",
    runningValues: ["Running"],
    stoppedValues: ["Stopped"],
  },
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [
        { outputKey: "kubeconfig", credentialKey: "kubeconfig" },
        // What this cluster's nodes cost per hour. The kubernetes plugin has
        // no way to know (the money is on THIS account) so it arrives the
        // same way the kubeconfig does. Resolves to "" when we have no price,
        // which the peer reads as "show capacity without money".
        { outputKey: "nodeHourlyRates", credentialKey: "nodeHourlyRates" },
      ],
      tabLabel: "Kubernetes",
      // Merge the peer's derived cost/efficiency series into THIS resource's
      // own Metrics tab, so cluster spend sits next to the provider's node
      // metrics instead of being buried one tab deeper.
      exposeMetricsToParent: true,
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
