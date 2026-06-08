import { f, o, rt } from "@infrawrench/plugin-base";

export const SecretResourceType = rt({
  name: "Secret",
  pinnable: false,
  id: "k8s-secret",
  description: "A Kubernetes Secret — stores sensitive data like passwords and tokens",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("type", "Type", { required: false }),
    f("keys", "Keys", { required: false }),
    f("dataCount", "Data Entries", { kind: "number", required: false }),
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
