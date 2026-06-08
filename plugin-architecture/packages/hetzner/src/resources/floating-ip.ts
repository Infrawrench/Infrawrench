import { f, o, rt } from "@infrawrench/plugin-base";

export const FloatingIpResourceType = rt({
  name: "Floating IP",
  id: "floating-ip",
  description: "A Hetzner Cloud floating IP address",
  fields: [
    f("name", "Name", { required: false }),
    f("ip", "IP Address"),
    f("type", "Type", { kind: "enum", enumValues: ["ipv4", "ipv6"] }),
    f("location", "Location", {
      kind: "enum",
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
    }),
    f("serverId", "Assigned Server", {
      required: false,
      description: "ID of the server this floating IP is assigned to, if any",
    }),
    f("blocked", "Blocked", { kind: "boolean", required: false }),
  ],
  outputs: [o("ip", "IP Address")],
  supportsCreate: true,
  iconKey: "network",
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Assign" }],
});
