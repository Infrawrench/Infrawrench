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
  // AKS has no node pool type here: the cluster carries its first pool's VM
  // size and the node count across every pool.
  equivalence: "kubernetes-cluster",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location", { showcase: true, sizing: "region" }),
    f("kubernetesVersion", "Kubernetes Version"),
    f("provisioningState", "Provisioning State", {
      showcase: true,
      kind: "enum",
      enumValues: ["Succeeded", "Creating", "Updating", "Deleting", "Failed", "Upgrading"],
    }),
    f("powerState", "Power State", { required: false }),
    f("nodeCount", "Node Count", {
      showcase: true,
      kind: "number",
      required: false,
      sizing: "node-count",
    }),
    f("nodePoolCount", "Node Pool Count", { showcase: true, kind: "number", required: false }),
    // The stored spelling; the create form calls it `nodeSize`, and the
    // estimator accepts both.
    f("vmSize", "VM Size", {
      required: false,
      sizing: "instance-type",
      description: "VM size used by the first node pool",
    }),
    f("osDiskSizeGb", "OS Disk Size (GB)", {
      kind: "number",
      required: false,
      sizing: "disk-gb",
      description: "OS disk size of the first node pool",
    }),
    f("networkPlugin", "Network Plugin", { required: false }),
    f("entraId", "Entra ID Sign-in", {
      required: false,
      kind: "boolean",
      description:
        "Whether users sign in to the cluster with Microsoft Entra ID (AKS-managed Entra integration), rather than only the cluster's local accounts",
    }),
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
      ci: {
        lends:
          "A kubeconfig with a Microsoft Entra ID token for the Azure connection's service principal, minted for the run.",
        reach:
          "Only this cluster: the token is for the AKS API (its audience) and can do what the service principal's Azure RBAC or Kubernetes RBAC on the cluster allows.",
        lifetime: "About an hour from when the run starts, as Entra ID issues it.",
        // Never the local account's client certificate (`ciKubeconfig`).
        credentialMappings: [{ outputKey: "ciKubeconfig", credentialKey: "kubeconfig" }],
        availableWhen: {
          fieldKey: "entraId",
          equals: "true",
          reason:
            "This cluster signs in only with local accounts, whose credential is a long-lived client certificate, often with admin rights, that cannot be revoked without rotating the cluster's certificates. Turn on Microsoft Entra ID integration to lend it.",
        },
      },
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
