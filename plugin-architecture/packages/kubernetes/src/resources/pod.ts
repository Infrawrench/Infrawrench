import { f, rt } from "@infrawrench/plugin-base";

export const PodResourceType = rt({
  name: "Pod",
  pinnable: false,
  id: "k8s-pod",
  description: "A Kubernetes pod",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("image", "Image"),
    f("status", "Status", { required: false }),
    f("statusReason", "Status Reason", {
      required: false,
      description: "Why a Pending pod is pending — the scheduler's own words",
    }),
    f("nodeName", "Node", {
      required: false,
      description: "The node the scheduler placed this pod on — empty while unscheduled",
    }),
    f("configMaps", "ConfigMaps", {
      required: false,
      description: "namespace/name of every ConfigMap this pod mounts or reads env from",
    }),
    f("secrets", "Secrets", {
      required: false,
      description:
        "namespace/name of every Secret this pod mounts, reads env from, or pulls images with",
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
    // Nodes are cluster-scoped, so the bare name the scheduler writes is
    // already unambiguous against the node lister's `name` field.
    { fieldKey: "nodeName", targetTypeId: "k8s-node", targetKey: "name", label: "runs on" },
    // ConfigMaps and Secrets are not: `config` exists in every namespace. Both
    // sides store `namespace/name` so the match can't cross a namespace.
    {
      fieldKey: "configMaps",
      targetTypeId: "k8s-configmap",
      targetKey: "qualifiedName",
      label: "reads",
    },
    {
      fieldKey: "secrets",
      targetTypeId: "k8s-secret",
      targetKey: "qualifiedName",
      label: "reads",
    },
  ],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
