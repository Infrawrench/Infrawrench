import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DOKSClusterResourceType: ResourceTypeDefinition = {
  id: "doks-cluster",
  displayName: "DOKS Cluster",
  pluralDisplayName: "DOKS Clusters",
  description: "A managed Kubernetes cluster on DigitalOcean",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: [
        "nyc1",
        "nyc3",
        "sfo2",
        "sfo3",
        "ams3",
        "fra1",
        "sgp1",
        "lon1",
        "tor1",
        "blr1",
        "syd1",
      ],
    },
    {
      key: "version",
      label: "Kubernetes Version",
      kind: "string",
      required: true,
      description: "e.g. 1.31.1-do.4",
    },
    {
      key: "nodePoolSize",
      label: "Node Pool Size",
      kind: "string",
      required: true,
      description: "Node size slug, e.g. s-2vcpu-4gb",
    },
    {
      key: "nodeCount",
      label: "Node Count",
      kind: "number",
      required: true,
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
      key: "clusterEndpoint",
      label: "Cluster Endpoint",
      sensitive: false,
      hidden: true,
      description: "HTTPS endpoint for the Kubernetes API server",
    },
  ],
  parentTypeId: "project",
  dashboardPinnable: true,
  iconKey: "kubernetes",
  supportsCreate: true,
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
    },
  ],
};
