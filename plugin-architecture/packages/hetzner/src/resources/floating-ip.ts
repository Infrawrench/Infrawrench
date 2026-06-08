import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FloatingIpResourceType: ResourceTypeDefinition = {
  id: "floating-ip",
  displayName: "Floating IP",
  pluralDisplayName: "Floating IPs",
  description: "A Hetzner Cloud floating IP address",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    {
      key: "ip",
      label: "IP Address",
      kind: "string",
      required: true,
    },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: true,
      enumValues: ["ipv4", "ipv6"],
    },
    {
      key: "location",
      label: "Location",
      kind: "enum",
      required: true,
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
    },
    {
      key: "serverId",
      label: "Assigned Server",
      kind: "string",
      required: false,
      description: "ID of the server this floating IP is assigned to, if any",
    },
    {
      key: "blocked",
      label: "Blocked",
      kind: "boolean",
      required: false,
    },
  ],
  outputs: [{ key: "ip", label: "IP Address", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "network",
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Assign" }],
};
