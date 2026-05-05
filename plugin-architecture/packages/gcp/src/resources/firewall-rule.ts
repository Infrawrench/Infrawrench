import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FirewallRuleResourceType: ResourceTypeDefinition = {
  id: "firewall-rule",
  displayName: "Firewall Rule",
  pluralDisplayName: "Firewall Rules",
  description: "A Google Cloud VPC firewall rule",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "network", label: "Network", kind: "string", required: true },
    { key: "direction", label: "Direction", kind: "string", required: false },
    { key: "priority", label: "Priority", kind: "number", required: false },
    { key: "action", label: "Action", kind: "string", required: false },
    { key: "sourceRanges", label: "Source Ranges", kind: "string", required: false },
    { key: "destinationRanges", label: "Destination Ranges", kind: "string", required: false },
    { key: "allowed", label: "Allowed", kind: "string", required: false },
    { key: "denied", label: "Denied", kind: "string", required: false },
    { key: "disabled", label: "Disabled", kind: "boolean", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  iconKey: "shield",
  supportsCreate: true,
  attachTargets: [{ pluginId: "gcp", resourceTypeId: "gce-instance", verb: "Apply firewall" }],
};
