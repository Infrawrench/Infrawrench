import { f, o, rt } from "@infrawrench/plugin-base";

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
  iconKey: "shield",
  supportsCreate: true,
  attachTargets: [{ pluginId: "gcp", resourceTypeId: "gce-instance", verb: "Apply firewall" }],
});
