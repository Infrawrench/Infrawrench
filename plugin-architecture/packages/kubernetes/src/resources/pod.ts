import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PodResourceType: ResourceTypeDefinition = {
  id: "k8s-pod",
  displayName: "Pod",
  pluralDisplayName: "Pods",
  description: "A Kubernetes pod",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "image", label: "Image", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
  supportsCreate: true,
};
