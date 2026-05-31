import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CacheRuleResourceType: ResourceTypeDefinition = {
  id: "cache-rule",
  displayName: "Cache Rule",
  pluralDisplayName: "Cache Rules",
  description: "A Cloudflare cache rule (rulesets http_request_cache_settings phase)",
  fields: [
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "expression", label: "Expression", kind: "string", required: true },
    { key: "cache", label: "Cache", kind: "boolean", required: true },
    { key: "edgeTtl", label: "Edge TTL (s)", kind: "number", required: false },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "cache",
};
