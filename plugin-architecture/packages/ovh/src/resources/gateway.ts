import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GatewayResourceType: ResourceTypeDefinition = {
  id: "gateway",
  displayName: "Gateway",
  pluralDisplayName: "Gateways",
  description: "An OVHcloud Public Cloud network gateway",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "model", label: "Model", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "interfaces", label: "Interfaces", kind: "number", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  iconKey: "gateway",
};
