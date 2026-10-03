import { f, o, rt } from "@infrawrench/plugin-base";

export const FloatingIpResourceType = rt({
  name: "Floating IP",
  id: "floating-ip",
  description: "A Hetzner Cloud floating IP address",
  fields: [
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("ip", "IP Address", { editable: false }),
    f("type", "Type", { kind: "enum", enumValues: ["ipv4", "ipv6"], editable: false }),
    f("location", "Location", {
      kind: "enum",
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
      editable: false,
    }),
    f("serverId", "Assigned Server", {
      required: false,
      description: "ID of the server this floating IP is assigned to, if any",
      editable: false,
    }),
    f("blocked", "Blocked", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [o("ip", "IP Address")],
  dependsOn: [{ fieldKey: "serverId", targetTypeId: "server", label: "assigned to" }],
  supportsCreate: true,
  // Edit = `PUT` on the object itself (name, plus the fields left editable).
  supportsUpdate: true,
  iconKey: "network",
  // Hetzner bills floating IPs whether or not they're assigned; the lister
  // always sets serverId ("" when unassigned).
  orphanRule: {
    conditions: [{ fieldKey: "serverId", when: "empty" }],
    reason: "Floating IP is not assigned to any server",
  },
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Assign" }],
});
