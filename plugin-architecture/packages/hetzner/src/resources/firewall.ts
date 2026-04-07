import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FirewallResourceType: ResourceTypeDefinition = {
  id: "firewall",
  displayName: "Firewall",
  pluralDisplayName: "Firewalls",
  description: "A Hetzner Cloud firewall with inbound/outbound rules",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "rulesCount",
      label: "Rules",
      kind: "number",
      required: false,
    },
    {
      key: "appliedToCount",
      label: "Applied To",
      kind: "number",
      required: false,
      description: "Number of servers/label selectors this firewall is applied to",
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  iconKey: "firewall",
};
