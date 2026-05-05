import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const StatefulSetResourceType: ResourceTypeDefinition = {
  id: "k8s-statefulset",
  displayName: "StatefulSet",
  pluralDisplayName: "StatefulSets",
  description: "A Kubernetes StatefulSet — manages stateful workloads with stable identities",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "replicas", label: "Desired Replicas", kind: "number", required: false },
    { key: "readyReplicas", label: "Ready Replicas", kind: "number", required: false },
    { key: "image", label: "Image", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: true,
  supportsCreate: true,
};
