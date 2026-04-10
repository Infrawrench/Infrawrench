import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudRouterResourceType: ResourceTypeDefinition = {
  id: "cloud-router",
  displayName: "Cloud Router",
  pluralDisplayName: "Cloud Routers",
  description: "A Google Cloud Router for dynamic routing and Cloud NAT",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "network", label: "Network", kind: "string", required: false },
    { key: "bgpAsn", label: "BGP ASN", kind: "number", required: false },
    { key: "natCount", label: "NAT Configs", kind: "number", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};
