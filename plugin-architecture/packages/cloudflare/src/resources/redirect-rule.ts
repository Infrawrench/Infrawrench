import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RedirectRuleResourceType: ResourceTypeDefinition = {
  id: "redirect-rule",
  displayName: "Redirect Rule",
  pluralDisplayName: "Redirect Rules",
  description: "A Cloudflare single redirect rule (rulesets http_request_dynamic_redirect phase)",
  fields: [
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "expression", label: "Expression", kind: "string", required: true },
    { key: "target", label: "Target URL", kind: "string", required: true },
    { key: "statusCode", label: "Status", kind: "number", required: true },
    { key: "preserveQuery", label: "Preserve Query", kind: "boolean", required: false },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns",
};
