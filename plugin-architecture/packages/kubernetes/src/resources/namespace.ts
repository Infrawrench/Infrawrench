import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NamespaceResourceType: ResourceTypeDefinition = {
  id: "k8s-namespace",
  displayName: "Namespace",
  pluralDisplayName: "Namespaces",
  description: "A Kubernetes namespace",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
  ],
  outputs: [],
  parentTypeId: "k8s-cluster",
  dashboardPinnable: false,
};
