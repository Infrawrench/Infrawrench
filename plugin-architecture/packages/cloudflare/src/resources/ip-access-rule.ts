import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const IpAccessRuleResourceType: ResourceTypeDefinition = {
  id: "ip-access-rule",
  displayName: "IP Access Rule",
  pluralDisplayName: "IP Access Rules",
  description: "A Cloudflare IP Access Rule (allow/block/challenge by IP, CIDR, ASN, or country)",
  fields: [
    { key: "mode", label: "Mode", kind: "string", required: true },
    { key: "target", label: "Target", kind: "string", required: true },
    { key: "value", label: "Value", kind: "string", required: true },
    { key: "notes", label: "Notes", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "firewall",
};
