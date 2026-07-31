import { f, rt } from "@infrawrench/plugin-base";

export const ConfigMapResourceType = rt({
  name: "ConfigMap",
  pinnable: false,
  id: "k8s-configmap",
  description: "A Kubernetes ConfigMap — stores non-sensitive configuration data",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("qualifiedName", "Qualified Name", {
      required: false,
      description: "namespace/name — how objects in this namespace reference this ConfigMap",
    }),
    f("keys", "Keys", { required: false }),
    f("dataCount", "Data Entries", { kind: "number", required: false }),
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
});
