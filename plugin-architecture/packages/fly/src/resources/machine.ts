import { f, o, rt } from "@infrawrench/plugin-base";

export const MachineResourceType = rt({
  name: "Machine",
  id: "machine",
  description: "A Fly Machine — a fast-launching microVM",
  parentTypeId: "app",
  fields: [
    f("name", "Name", { required: false }),
    f("state", "State", {
      kind: "enum",
      enumValues: [
        "created",
        "started",
        "stopped",
        "suspended",
        "destroyed",
        "starting",
        "stopping",
        "replacing",
      ],
    }),
    f("region", "Region", { description: "Fly.io region code (e.g. iad, cdg, nrt)" }),
    f("image", "Image", { required: false, description: "Container image used by this machine" }),
    f("appName", "App", { description: "Name of the parent app" }),
    f("instanceId", "Instance ID", {
      required: false,
      description: "Current instance version identifier",
    }),
  ],
  outputs: [o("privateIp", "Private IPv6 (6PN)")],
  iconKey: "server",
  supportsCreate: true,
  supportsMetrics: true,
});
