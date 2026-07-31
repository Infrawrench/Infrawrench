import { f, o, rt } from "@infrawrench/plugin-base";

export const PrimaryIpResourceType = rt({
  name: "Primary IP",
  id: "primary-ip",
  description: "A Hetzner Cloud primary IP address assignable to servers",
  fields: [
    f("name", "Name", { required: false }),
    f("ip", "IP Address"),
    f("type", "Type", { kind: "enum", enumValues: ["ipv4", "ipv6"] }),
    f("datacenter", "Datacenter", { required: false }),
    f("assigneeId", "Assigned Resource", { required: false }),
    f("assigneeType", "Assigned Type", { required: false }),
    f("blocked", "Blocked", { kind: "boolean", required: false }),
    f("autoDelete", "Auto Delete", { kind: "boolean", required: false }),
  ],
  outputs: [o("ip", "IP Address"), o("primaryIpId", "Primary IP ID")],
  // `assignee_type` is server-only in the Cloud API today, so `assigneeId`
  // always holds a server id when it holds anything.
  dependsOn: [{ fieldKey: "assigneeId", targetTypeId: "server", label: "assigned to" }],
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
