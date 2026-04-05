import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DeploymentResourceType: ResourceTypeDefinition = {
  id: "k8s-deployment",
  displayName: "Deployment",
  pluralDisplayName: "Deployments",
  description: "A Kubernetes Deployment",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "replicas", label: "Desired Replicas", kind: "number", required: false },
  ],
  outputs: [
    { key: "readyReplicas", label: "Ready Replicas", sensitive: false },
    { key: "image", label: "Container Image", sensitive: false },
  ],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: true,
  iconKey: "deployment",
};
