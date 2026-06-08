import { f, o, rt } from "@infrawrench/plugin-base";

export const RateLimitRuleResourceType = rt({
  name: "Rate Limiting Rule",
  pinnable: false,
  id: "rate-limit-rule",
  description: "A Cloudflare rate limiting rule (rulesets http_ratelimit phase)",
  fields: [
    f("description", "Description", { required: false }),
    f("expression", "Expression"),
    f("requestsPerPeriod", "Requests", { kind: "number" }),
    f("period", "Period (s)", { kind: "number" }),
    f("characteristics", "Characteristics", { required: false }),
    f("action", "Action"),
    f("enabled", "Enabled", { kind: "boolean" }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "firewall",
});
