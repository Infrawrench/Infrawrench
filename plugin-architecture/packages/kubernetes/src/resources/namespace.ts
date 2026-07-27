import { f, rt } from "@infrawrench/plugin-base";

export const NamespaceResourceType = rt({
  name: "Namespace",
  pinnable: false,
  id: "k8s-namespace",
  description: "A Kubernetes namespace",
  fields: [f("name", "Name")],
  outputs: [],
  parentTypeId: "k8s-cluster",
  supportsCreate: true,
});
