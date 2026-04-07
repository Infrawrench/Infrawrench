import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ConfigMapResourceType: ResourceTypeDefinition = {
  id: "k8s-configmap",
  displayName: "ConfigMap",
  pluralDisplayName: "ConfigMaps",
  description: "A Kubernetes ConfigMap — stores non-sensitive configuration data",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "keys", label: "Keys", kind: "string", required: false },
    { key: "dataCount", label: "Data Entries", kind: "number", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
  supportsCreate: true,
};
