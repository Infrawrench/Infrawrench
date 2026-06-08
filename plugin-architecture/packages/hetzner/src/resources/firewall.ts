import { f, o, rt } from "@infrawrench/plugin-base";

export const FirewallResourceType = rt({
  name: "Firewall",
  id: "firewall",
  description: "A Hetzner Cloud firewall with inbound/outbound rules",
  fields: [
    f("name", "Name"),
    f("rulesCount", "Rules", { kind: "number", required: false }),
    f("appliedToCount", "Applied To", {
      kind: "number",
      required: false,
      description: "Number of servers/label selectors this firewall is applied to",
    }),
  ],
  outputs: [o("id", "Firewall ID")],
  supportsCreate: true,
  iconKey: "firewall",
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Apply firewall" }],
});
