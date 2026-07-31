import { f, o, rt } from "@infrawrench/plugin-base";

export const ForwardingRuleResourceType = rt({
  name: "Forwarding Rule",
  id: "forwarding-rule",
  description: "A Google Cloud Load Balancing forwarding rule",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("IPAddress", "IP Address", { required: false }),
    f("IPProtocol", "Protocol", { required: false }),
    f("portRange", "Port Range", { required: false }),
    f("target", "Target", { required: false }),
    f("loadBalancingScheme", "LB Scheme", { required: false }),
    f("networkTier", "Network Tier", { required: false }),
  ],
  outputs: [o("IPAddress", "IP Address")],
  // Only reserved addresses match — an ephemeral IP names no static-ip resource.
  dependsOn: [
    { fieldKey: "IPAddress", targetTypeId: "static-ip", targetKey: "address", label: "uses ip" },
  ],
  supportsCreate: true,
});
