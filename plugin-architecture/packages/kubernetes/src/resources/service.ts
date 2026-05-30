import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ServiceResourceType: ResourceTypeDefinition = {
  id: "k8s-service",
  displayName: "Service",
  pluralDisplayName: "Services",
  description: "A Kubernetes Service — exposes pods via a stable endpoint",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "namespace", label: "Namespace", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "clusterIP", label: "Cluster IP", kind: "string", required: false },
    { key: "ports", label: "Ports", kind: "string", required: false },
  ],
  outputs: [
    {
      key: "serviceName",
      label: "Service Name",
      sensitive: false,
      description:
        "The Service's name — used by Ingresses and StatefulSets to reference this Service",
    },
  ],
  parentTypeId: "k8s-namespace",
  dashboardPinnable: false,
  supportsCreate: true,
};
