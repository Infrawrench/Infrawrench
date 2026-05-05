import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FirewallRuleResourceType: ResourceTypeDefinition = {
  id: "firewall-rule",
  displayName: "WAF Custom Rule",
  pluralDisplayName: "WAF Custom Rules",
  description: "A Cloudflare WAF custom rule (firewall rule)",
  fields: [
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "expression", label: "Expression", kind: "string", required: true },
    { key: "action", label: "Action", kind: "string", required: true },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
    { key: "priority", label: "Priority", kind: "number", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "firewall",
};
