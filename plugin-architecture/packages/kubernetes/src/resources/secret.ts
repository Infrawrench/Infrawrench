import { f, rt } from "@infrawrench/plugin-base";

export const SecretResourceType = rt({
  name: "Secret",
  pinnable: false,
  id: "k8s-secret",
  description: "A Kubernetes Secret — stores sensitive data like passwords and tokens",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("qualifiedName", "Qualified Name", {
      required: false,
      description: "namespace/name — how objects in this namespace reference this Secret",
    }),
    f("type", "Type", { required: false }),
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
