import { f, rt } from "@infrawrench/plugin-base";

export const WaitingRoomResourceType = rt({
  name: "Waiting Room",
  pinnable: false,
  id: "waiting-room",
  description: "A Cloudflare Waiting Room for managing traffic surges",
  fields: [
    f("name", "Name"),
    f("host", "Host"),
    f("path", "Path", { required: false }),
    f("totalActiveUsers", "Total Active Users", { kind: "number", required: false }),
    f("newUsersPerMinute", "New Users/Minute", { kind: "number", required: false }),
    f("queueingMethod", "Queueing Method", { required: false }),
    f("sessionDuration", "Session Duration", { kind: "number", required: false }),
    f("suspended", "Suspended", { kind: "boolean", required: false }),
  ],
  outputs: [],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "waiting-room",
});
