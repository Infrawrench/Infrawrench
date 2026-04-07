import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const IngressResourceType: ResourceTypeDefinition = {
  id: "k8s-ingress",
  displayName: "Ingress",
  pluralDisplayName: "Ingresses",
  description: "A Kubernetes Ingress — HTTP/HTTPS routing to services",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "ingressClassName", label: "Ingress Class", kind: "string", required: false },
    { key: "hosts", label: "Hosts", kind: "string", required: false },
    { key: "address", label: "Address", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
};
