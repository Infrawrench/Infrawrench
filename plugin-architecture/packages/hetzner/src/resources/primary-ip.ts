import { f, o, rt } from "@infrawrench/plugin-base";

export const PrimaryIpResourceType = rt({
  name: "Primary IP",
  id: "primary-ip",
  description: "A Hetzner Cloud primary IP address assignable to servers",
  fields: [
    f("name", "Name", { required: false }),
    f("ip", "IP Address", { editable: false }),
    f("type", "Type", { kind: "enum", enumValues: ["ipv4", "ipv6"], editable: false }),
    f("location", "Location", {
      kind: "enum",
      required: false,
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
      editable: false,
    }),
    f("assigneeId", "Assigned Resource", { required: false, editable: false }),
    f("assigneeType", "Assigned Type", { required: false, editable: false }),
    f("blocked", "Blocked", { kind: "boolean", required: false, editable: false }),
    f("autoDelete", "Auto Delete", { kind: "boolean", required: false }),
  ],
  outputs: [o("ip", "IP Address"), o("primaryIpId", "Primary IP ID")],
  // `assignee_type` is server-only in the Cloud API today, so `assigneeId`
  // always holds a server id when it holds anything.
  dependsOn: [{ fieldKey: "assigneeId", targetTypeId: "server", label: "assigned to" }],
  supportsCreate: true,
  // Edit = `PUT` on the object itself (name, plus the fields left editable).
  supportsUpdate: true,
  iconKey: "network",
  // Unassigned primary IPs cost money. autoDelete=true ones vanish with their
  // server, so only flag the ones that will linger (autoDelete stringifies to
  // "false" in evaluateOrphanRule's comparison).
  orphanRule: {
    conditions: [
      { fieldKey: "assigneeId", when: "empty" },
      { fieldKey: "autoDelete", when: "equals", value: "false" },
    ],
    reason: "Primary IP is not assigned to any server and won't auto-delete",
  },
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Assign" }],
});
