import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const EmailRoutingRuleResourceType: ResourceTypeDefinition = {
  id: "email-routing-rule",
  displayName: "Email Routing Rule",
  pluralDisplayName: "Email Routing Rules",
  description: "A Cloudflare Email Routing rule",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
    { key: "matchers", label: "Matchers", kind: "string", required: false },
    { key: "actions", label: "Actions", kind: "string", required: false },
    { key: "priority", label: "Priority", kind: "number", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "email",
};
