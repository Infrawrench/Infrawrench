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
  iconKey: "network",
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Assign" }],
});
