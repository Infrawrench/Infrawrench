import { f, rt } from "@infrawrench/plugin-base";

export const DaemonSetResourceType = rt({
  name: "DaemonSet",
  pinnable: false,
  id: "k8s-daemonset",
  description: "A Kubernetes DaemonSet — runs a pod on every (or selected) node(s)",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("desiredNumberScheduled", "Desired", { kind: "number", required: false }),
    f("numberReady", "Ready", { kind: "number", required: false }),
    f("image", "Image", { required: false }),
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
