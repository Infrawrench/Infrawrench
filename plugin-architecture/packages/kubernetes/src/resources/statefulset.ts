import { f, rt } from "@infrawrench/plugin-base";

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
    f("serviceAccountName", "Service Account", {
      required: false,
      description: "The ServiceAccount the pod template runs as, when it names one",
    }),
  ],
  outputs: [],
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
  supportsMetrics: true,
});
