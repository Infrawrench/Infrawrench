import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ManagedKubeResourceType: ResourceTypeDefinition = {
  id: "managed-kube",
  displayName: "Managed Kubernetes",
  pluralDisplayName: "Managed Kubernetes",
  description: "An OVHcloud Managed Kubernetes Service cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: [
        "GRA5",
        "GRA7",
        "GRA9",
        "GRA11",
        "SBG5",
        "BHS5",
        "WAW1",
        "DE1",
        "UK1",
        "SGP1",
        "SYD1",
      ],
    },
    {
      key: "version",
      label: "Kubernetes Version",
      kind: "string",
      required: true,
      description: "e.g. 1.30",
    },
    {
      key: "status",
      label: "Status",
      kind: "string",
      required: false,
    },
    {
      key: "nodesUrl",
      label: "Nodes URL",
      kind: "string",
      required: false,
    },
  ],
  outputs: [
    {
      key: "kubeconfig",
      label: "Kubeconfig",
      sensitive: true,
      description: "Full kubeconfig YAML for connecting to this cluster",
    },
    {
      key: "clusterUrl",
      label: "Cluster URL",
      sensitive: false,
      description: "HTTPS endpoint for the Kubernetes API server",
    },
  ],
  dashboardPinnable: true,
  iconKey: "kubernetes",
  supportsCreate: true,
};
