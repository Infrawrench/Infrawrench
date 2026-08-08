import { f, o, rt } from "@infrawrench/plugin-base";

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "k8s-deployment",
  description: "A Kubernetes Deployment",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("replicas", "Desired Replicas", { kind: "number", required: false }),
    f("serviceAccountName", "Service Account", {
      required: false,
      description: "The ServiceAccount the pod template runs as, when it names one",
    }),
  ],
  outputs: [o("readyReplicas", "Ready Replicas"), o("image", "Container Image")],
  dependsOn: [
    // Namespaces report no external id; their identity is the bare name.
    {
      fieldKey: "namespace",
      targetTypeId: "k8s-namespace",
      targetKey: "name",
      label: "in namespace",
    },
  ],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
  iconKey: "deployment",
  supportsMetrics: true,
});
