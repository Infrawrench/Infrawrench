import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ForwardingRuleResourceType: ResourceTypeDefinition = {
  id: "forwarding-rule",
  displayName: "Forwarding Rule",
  pluralDisplayName: "Forwarding Rules",
  description: "A Google Cloud Load Balancing forwarding rule",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "IPAddress", label: "IP Address", kind: "string", required: false },
    { key: "IPProtocol", label: "Protocol", kind: "string", required: false },
    { key: "portRange", label: "Port Range", kind: "string", required: false },
    { key: "target", label: "Target", kind: "string", required: false },
    { key: "loadBalancingScheme", label: "LB Scheme", kind: "string", required: false },
    { key: "networkTier", label: "Network Tier", kind: "string", required: false },
  ],
  outputs: [{ key: "IPAddress", label: "IP Address", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
};
