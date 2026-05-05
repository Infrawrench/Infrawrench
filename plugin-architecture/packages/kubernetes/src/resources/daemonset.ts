import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DaemonSetResourceType: ResourceTypeDefinition = {
  id: "k8s-daemonset",
  displayName: "DaemonSet",
  pluralDisplayName: "DaemonSets",
  description: "A Kubernetes DaemonSet — runs a pod on every (or selected) node(s)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "desiredNumberScheduled", label: "Desired", kind: "number", required: false },
    { key: "numberReady", label: "Ready", kind: "number", required: false },
    { key: "image", label: "Image", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
  supportsCreate: true,
};
