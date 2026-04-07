import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const JobResourceType: ResourceTypeDefinition = {
  id: "k8s-job",
  displayName: "Job",
  pluralDisplayName: "Jobs",
  description: "A Kubernetes Job — runs a pod to completion",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "completions", label: "Completions", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "image", label: "Image", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
};
