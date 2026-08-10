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
    f("zoneName", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" }],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "firewall",
  postureChecks: [
    {
      id: "cloudflare-firewall-rule-disabled",
      title: "Firewall rule disabled",
      severity: "low",
      category: "other",
      conditions: [{ fieldKey: "enabled", when: "falsy" }],
      reason:
        "This custom firewall rule is disabled and filters no traffic; re-enable it or delete it so the zone's protections match what is actually configured.",
    },
  ],
});
