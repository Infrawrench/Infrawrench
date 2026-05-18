import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const WAFWebACLResourceType: ResourceTypeDefinition = {
  id: "waf-web-acl",
  displayName: "WAF Web ACL",
  pluralDisplayName: "WAF Web ACLs",
  description: "An AWS WAFv2 web access control list",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "scope",
      label: "Scope",
      kind: "enum",
      required: true,
      enumValues: ["REGIONAL", "CLOUDFRONT"],
    },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "ruleCount", label: "Rules", kind: "number", required: false },
    {
      key: "defaultAction",
      label: "Default Action",
      kind: "enum",
      required: false,
      enumValues: ["ALLOW", "BLOCK"],
    },
    { key: "capacity", label: "Capacity (WCU)", kind: "number", required: false },
  ],
  outputs: [
    { key: "webAclArn", label: "Web ACL ARN", sensitive: false },
    { key: "webAclId", label: "Web ACL ID", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "firewall",
  supportsCreate: true,
  supportsMetrics: true,
};
