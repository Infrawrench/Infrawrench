import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GkeClusterResourceType: ResourceTypeDefinition = {
  id: "gke-cluster",
  displayName: "GKE Cluster",
  pluralDisplayName: "GKE Clusters",
  description: "A Google Kubernetes Engine cluster",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "version", label: "Kubernetes Version", kind: "string", required: false },
    { key: "nodeCount", label: "Node Count", kind: "number", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
  ],
  outputs: [
    { key: "clusterEndpoint", label: "Cluster Endpoint", sensitive: false },
    { key: "kubeconfig", label: "Kubeconfig", sensitive: true, description: "Full kubeconfig YAML for kubectl access" },
  ],
  dashboardPinnable: true,
};
