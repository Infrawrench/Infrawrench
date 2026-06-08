import { f, o, rt } from "@infrawrench/plugin-base";

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "k8s-deployment",
  description: "A Kubernetes Deployment",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("replicas", "Desired Replicas", { kind: "number", required: false }),
  ],
  outputs: [o("readyReplicas", "Ready Replicas"), o("image", "Container Image")],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
  iconKey: "deployment",
});
