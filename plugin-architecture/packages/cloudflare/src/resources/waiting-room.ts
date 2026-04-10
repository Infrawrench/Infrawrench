import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const WaitingRoomResourceType: ResourceTypeDefinition = {
  id: "waiting-room",
  displayName: "Waiting Room",
  pluralDisplayName: "Waiting Rooms",
  description: "A Cloudflare Waiting Room for managing traffic surges",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "host", label: "Host", kind: "string", required: true },
    { key: "path", label: "Path", kind: "string", required: false },
    { key: "totalActiveUsers", label: "Total Active Users", kind: "number", required: false },
    { key: "newUsersPerMinute", label: "New Users/Minute", kind: "number", required: false },
    { key: "queueingMethod", label: "Queueing Method", kind: "string", required: false },
    { key: "sessionDuration", label: "Session Duration", kind: "number", required: false },
    { key: "suspended", label: "Suspended", kind: "boolean", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  iconKey: "waiting-room",
};
