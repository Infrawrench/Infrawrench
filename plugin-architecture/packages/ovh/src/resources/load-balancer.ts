import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType: ResourceTypeDefinition = {
  id: "load-balancer",
  displayName: "Load Balancer",
  pluralDisplayName: "Load Balancers",
  description: "An OVHcloud Public Cloud load balancer",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    {
      key: "size",
      label: "Size",
      kind: "enum",
      required: false,
      enumValues: ["SMALL", "MEDIUM", "LARGE"],
    },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "address", label: "Address", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [{ key: "address", label: "Address", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "load-balancer",
};
