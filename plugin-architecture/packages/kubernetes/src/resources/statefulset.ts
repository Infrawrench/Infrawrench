import { f, o, rt } from "@infrawrench/plugin-base";

export const StatefulSetResourceType = rt({
  name: "StatefulSet",
  id: "k8s-statefulset",
  description: "A Kubernetes StatefulSet — manages stateful workloads with stable identities",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("replicas", "Desired Replicas", { kind: "number", required: false }),
    f("readyReplicas", "Ready Replicas", { kind: "number", required: false }),
    f("image", "Image", { required: false }),
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
