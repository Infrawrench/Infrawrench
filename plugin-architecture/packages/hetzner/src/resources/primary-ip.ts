import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PrimaryIpResourceType: ResourceTypeDefinition = {
  id: "primary-ip",
  displayName: "Primary IP",
  pluralDisplayName: "Primary IPs",
  description: "A Hetzner Cloud primary IP address assignable to servers",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "ip", label: "IP Address", kind: "string", required: true },
    { key: "type", label: "Type", kind: "enum", required: true, enumValues: ["ipv4", "ipv6"] },
    { key: "datacenter", label: "Datacenter", kind: "string", required: false },
    { key: "assigneeId", label: "Assigned Resource", kind: "string", required: false },
    { key: "assigneeType", label: "Assigned Type", kind: "string", required: false },
    { key: "blocked", label: "Blocked", kind: "boolean", required: false },
    { key: "autoDelete", label: "Auto Delete", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "ip", label: "IP Address", sensitive: false },
    { key: "primaryIpId", label: "Primary IP ID", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "network",
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Assign" }],
};
