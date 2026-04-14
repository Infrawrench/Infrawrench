import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SecretResourceType: ResourceTypeDefinition = {
  id: "k8s-secret",
  displayName: "Secret",
  pluralDisplayName: "Secrets",
  description: "A Kubernetes Secret — stores sensitive data like passwords and tokens",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "keys", label: "Keys", kind: "string", required: false },
    { key: "dataCount", label: "Data Entries", kind: "number", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
  supportsCreate: true,
};
