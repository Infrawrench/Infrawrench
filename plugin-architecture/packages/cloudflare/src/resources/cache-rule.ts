import { f, rt } from "@infrawrench/plugin-base";

export const CacheRuleResourceType = rt({
  name: "Cache Rule",
  pinnable: false,
  id: "cache-rule",
  description: "A Cloudflare cache rule (rulesets http_request_cache_settings phase)",
  fields: [
    f("description", "Description", { required: false }),
    f("expression", "Expression"),
    f("cache", "Cache", { kind: "boolean" }),
    f("edgeTtl", "Edge TTL (s)", { kind: "number", required: false }),
    f("enabled", "Enabled", { kind: "boolean" }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "cache",
});
