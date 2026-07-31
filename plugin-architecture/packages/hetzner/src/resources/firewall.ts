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
    f("appliedToServerIds", "Applied To Servers", {
      required: false,
      description:
        "Comma-separated IDs of the servers this firewall is applied to, including those resolved from label selectors",
    }),
    f("appliedToLabelSelectors", "Label Selectors", {
      required: false,
      description: "Comma-separated label selectors this firewall is applied through",
    }),
  ],
  outputs: [o("id", "Firewall ID")],
  // Server ids off the firewall's own `applied_to` block; a server's
  // externalId is that same numeric id stringified.
  dependsOn: [{ fieldKey: "appliedToServerIds", targetTypeId: "server", label: "applied to" }],
  supportsCreate: true,
  iconKey: "firewall",
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Apply firewall" }],
});
