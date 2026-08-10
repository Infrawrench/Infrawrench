import { f, rt } from "@infrawrench/plugin-base";

export const FirewallRuleResourceType = rt({
  name: "Firewall Rule",
  pinnable: false,
  id: "firewall-rule",
  description: "A Google Cloud VPC firewall rule",
  fields: [
    f("name", "Name"),
    f("network", "Network"),
    f("direction", "Direction", { required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("action", "Action", { required: false }),
    f("sourceRanges", "Source Ranges", { required: false }),
    f("destinationRanges", "Destination Ranges", { required: false }),
    f("allowed", "Allowed", { required: false }),
    f("denied", "Denied", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "network", targetTypeId: "vpc-network", targetKey: "name", label: "in network" },
  ],
  iconKey: "shield",
  supportsCreate: true,
  attachTargets: [{ pluginId: "gcp", resourceTypeId: "gce-instance", verb: "Apply firewall" }],
  // `sourceRanges` is a ", "-joined list; a single world-open range stores
  // exactly "0.0.0.0/0" (multi-range rules are not matchable with equals).
  postureChecks: [
    {
      id: "gcp-firewall-world-open-ingress",
      title: "Ingress allowed from 0.0.0.0/0",
      severity: "critical",
      category: "public-exposure",
      conditions: [
        { fieldKey: "sourceRanges", when: "equals", value: "0.0.0.0/0" },
        { fieldKey: "action", when: "equals", value: "ALLOW" },
        { fieldKey: "direction", when: "equals", value: "INGRESS" },
        { fieldKey: "disabled", when: "falsy" },
      ],
      reason:
        "This enabled ingress rule allows traffic from 0.0.0.0/0 — the entire internet — to every target it applies to.",
    },
  ],
});
