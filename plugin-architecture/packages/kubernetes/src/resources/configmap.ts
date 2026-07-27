import { f, rt } from "@infrawrench/plugin-base";

export const ConfigMapResourceType = rt({
  name: "ConfigMap",
  pinnable: false,
  id: "k8s-configmap",
  description: "A Kubernetes ConfigMap — stores non-sensitive configuration data",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("keys", "Keys", { required: false }),
    f("dataCount", "Data Entries", { kind: "number", required: false }),
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
