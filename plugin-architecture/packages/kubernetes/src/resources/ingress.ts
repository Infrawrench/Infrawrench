import { f, rt } from "@infrawrench/plugin-base";

export const IngressResourceType = rt({
  name: "Ingress",
  plural: "Ingresses",
  pinnable: false,
  id: "k8s-ingress",
  description: "A Kubernetes Ingress — HTTP/HTTPS routing to services",
  fields: [
    f("name", "Name"),
    f("namespace", "Namespace"),
    f("ingressClassName", "Ingress Class", { required: false }),
    f("hosts", "Hosts", { required: false }),
    f("address", "Address", { required: false }),
    f("services", "Backend Services", {
      required: false,
      description: "namespace/name of every Service the rules route to",
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
    // An Ingress can only name Services in its own namespace, and a Service
    // name is only unique within one — both sides store `namespace/name`.
    {
      fieldKey: "services",
      targetTypeId: "k8s-service",
      targetKey: "qualifiedName",
      label: "routes to",
    },
  ],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
