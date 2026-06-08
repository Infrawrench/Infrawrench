import { f, o, rt } from "@infrawrench/plugin-base";

export const WAFWebACLResourceType = rt({
  name: "WAF Web ACL",
  id: "waf-web-acl",
  description: "An AWS WAFv2 web access control list",
  fields: [
    f("name", "Name"),
    f("scope", "Scope", { kind: "enum", enumValues: ["REGIONAL", "CLOUDFRONT"] }),
    f("description", "Description", { required: false }),
    f("ruleCount", "Rules", { kind: "number", required: false }),
    f("defaultAction", "Default Action", {
      kind: "enum",
      required: false,
      enumValues: ["ALLOW", "BLOCK"],
    }),
    f("capacity", "Capacity (WCU)", { kind: "number", required: false }),
  ],
  outputs: [o("webAclArn", "Web ACL ARN"), o("webAclId", "Web ACL ID")],
  iconKey: "firewall",
  supportsCreate: true,
  supportsMetrics: true,
});
