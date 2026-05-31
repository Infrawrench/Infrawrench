import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RateLimitRuleResourceType: ResourceTypeDefinition = {
  id: "rate-limit-rule",
  displayName: "Rate Limiting Rule",
  pluralDisplayName: "Rate Limiting Rules",
  description: "A Cloudflare rate limiting rule (rulesets http_ratelimit phase)",
  fields: [
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "expression", label: "Expression", kind: "string", required: true },
    { key: "requestsPerPeriod", label: "Requests", kind: "number", required: true },
    { key: "period", label: "Period (s)", kind: "number", required: true },
    { key: "characteristics", label: "Characteristics", kind: "string", required: false },
    { key: "action", label: "Action", kind: "string", required: true },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "firewall",
};
