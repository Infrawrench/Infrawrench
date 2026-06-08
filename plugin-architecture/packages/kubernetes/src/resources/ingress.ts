import { f, o, rt } from "@infrawrench/plugin-base";

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
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  supportsCreate: true,
});
