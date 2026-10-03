import { f, o, rt } from "@infrawrench/plugin-base";
import { SCW_ZONES } from "../locations.js";

export const FlexibleIpResourceType = rt({
  id: "flexible-ip",
  name: "Flexible IP",
  plural: "Flexible IPs",
  description: "A Scaleway Instance flexible (routed) public IP",
  fields: [
    f("address", "Address", { editable: false }),
    f("zone", "Zone", { kind: "enum", enumValues: SCW_ZONES, editable: false }),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["routed_ipv4", "routed_ipv6"],
      editable: false,
    }),
    f("state", "State", {
      kind: "enum",
      required: false,
      enumValues: ["detached", "attached", "pending", "error"],
      editable: false,
    }),
    f("serverId", "Attached Instance", { required: false, editable: false }),
    f("reverse", "Reverse DNS", { required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated" }),
  ],
  outputs: [o("address", "Address")],
  // `serverId` is a bare server uuid; an instance's externalId is
  // `{zone}/{id}`, and IPs only attach within their own zone.
  dependsOn: [
    {
      fieldKey: "serverId",
      targetTypeId: "instance",
      matchTemplate: "{zone}/{serverId}",
      label: "attached to",
    },
  ],
  // Flexible IPs bill whether or not they are attached.
  orphanRule: {
    conditions: [{ fieldKey: "serverId", when: "empty" }],
    reason: "Flexible IP is not attached to any instance",
  },
  supportsCreate: true,
  // Edit = reverse DNS and tags (`PATCH /ips/{id}`).
  supportsUpdate: true,
  iconKey: "network",
  attachTargets: [
    { pluginId: "scaleway", resourceTypeId: "instance", matchField: "zone", verb: "Attach" },
  ],
});
