import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType: ResourceTypeDefinition = {
  id: "load-balancer",
  displayName: "Load Balancer",
  pluralDisplayName: "Load Balancers",
  description: "A Cloudflare Load Balancer",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "fallbackPool", label: "Fallback Pool", kind: "string", required: false },
    { key: "defaultPools", label: "Default Pools", kind: "string", required: false },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
    { key: "proxied", label: "Proxied", kind: "boolean", required: false },
    { key: "ttl", label: "TTL", kind: "number", required: false },
    { key: "steeringPolicy", label: "Steering Policy", kind: "string", required: false },
    { key: "createdOn", label: "Created", kind: "string", required: false },
    { key: "modifiedOn", label: "Modified", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "load-balancer",
};
