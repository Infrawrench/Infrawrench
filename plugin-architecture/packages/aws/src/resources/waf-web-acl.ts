import { f, o, rt } from "@infrawrench/plugin-base";

export const WAFWebACLResourceType = rt({
  name: "WAF Web ACL",
  id: "waf-web-acl",
  description: "An AWS WAFv2 web access control list",
  fields: [
    f("name", "Name"),
    f("scope", "Scope", { kind: "enum", enumValues: ["REGIONAL", "CLOUDFRONT"] }),
    f("description", "Description", { required: false }),
    f("ruleCount", "Rules", { showcase: true, kind: "number", required: false }),
    f("defaultAction", "Default Action", {
      kind: "enum",
      required: false,
      enumValues: ["ALLOW", "BLOCK"],
    }),
    // A web ACL holds at most 5,000 WCUs, a fixed quota (past 1,500 costs
    // extra): https://docs.aws.amazon.com/waf/latest/developerguide/limits.html
    // (read 2026-11-23).
    f("capacity", "Capacity (WCU)", {
      kind: "number",
      required: false,
      usage: { limit: { constant: 5_000 }, unit: "WCU", label: "Rule Capacity" },
    }),
  ],
  outputs: [o("webAclArn", "Web ACL ARN"), o("webAclId", "Web ACL ID")],
  iconKey: "firewall",
  supportsCreate: true,
  supportsMetrics: true,
});
