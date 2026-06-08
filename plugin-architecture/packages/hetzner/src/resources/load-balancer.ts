import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType: ResourceTypeDefinition = {
  id: "load-balancer",
  displayName: "Load Balancer",
  pluralDisplayName: "Load Balancers",
  description: "A Hetzner Cloud Load Balancer with services, targets, and public IPs",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: ["running", "initializing", "unknown"],
    },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "location", label: "Location", kind: "string", required: false },
    { key: "ipv4", label: "IPv4", kind: "string", required: false },
    { key: "ipv6", label: "IPv6", kind: "string", required: false },
    { key: "targetCount", label: "Targets", kind: "number", required: false },
    { key: "serviceCount", label: "Services", kind: "number", required: false },
  ],
  outputs: [
    { key: "ipv4", label: "IPv4", sensitive: false },
    { key: "ipv6", label: "IPv6", sensitive: false },
    { key: "loadBalancerId", label: "Load Balancer ID", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "load-balancer",
  supportsMetrics: true,
  attachTargets: [
    { pluginId: "hetzner", resourceTypeId: "server", matchField: "location", verb: "Add target" },
  ],
};
