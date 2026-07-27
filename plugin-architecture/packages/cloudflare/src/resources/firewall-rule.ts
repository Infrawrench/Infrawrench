import { f, rt } from "@infrawrench/plugin-base";

export const FirewallRuleResourceType = rt({
  name: "WAF Custom Rule",
  pinnable: false,
  id: "firewall-rule",
  description: "A Cloudflare WAF custom rule (firewall rule)",
  fields: [
    f("description", "Description", { required: false }),
    f("expression", "Expression"),
    f("action", "Action"),
    f("enabled", "Enabled", { kind: "boolean" }),
    f("priority", "Priority", { kind: "number", required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "firewall",
});
