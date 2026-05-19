import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KapsuleClusterResourceType: ResourceTypeDefinition = {
  id: "kapsule-cluster",
  displayName: "Kapsule Cluster",
  pluralDisplayName: "Kapsule Clusters",
  description: "A managed Kubernetes cluster on Scaleway",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: ["fr-par", "nl-ams", "pl-waw"],
    },
    {
      key: "version",
      label: "Kubernetes Version",
      kind: "string",
      required: true,
      description: "e.g. 1.30.2",
    },
    {
      key: "nodeType",
      label: "Node Type",
      kind: "string",
      required: true,
      description: "Node commercial type, e.g. DEV1-M, GP1-S",
    },
    {
      key: "nodeCount",
      label: "Node Count",
      kind: "number",
      required: true,
    },
    {
      key: "diskSizeGb",
      label: "Disk Size (GB)",
      kind: "number",
      required: false,
      description: "Root volume size of the first node pool",
    },
    {
      key: "status",
      label: "Status",
      kind: "string",
      required: false,
    },
  ],
  outputs: [
    {
      key: "kubeconfig",
      label: "Kubeconfig",
      sensitive: true,
      hidden: true,
      description: "Full kubeconfig YAML for connecting to this cluster",
    },
    {
      key: "clusterUrl",
      label: "Cluster URL",
      sensitive: false,
      hidden: true,
      description: "HTTPS endpoint for the Kubernetes API server",
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
  secretExportTemplates: [
    {
      id: "kapsule-kubeconfig",
      displayName: "Kapsule Kubeconfig",
      description: "Kubeconfig for kubectl access to this Kapsule cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "clusterUrl" },
      ],
    },
  ],
};
