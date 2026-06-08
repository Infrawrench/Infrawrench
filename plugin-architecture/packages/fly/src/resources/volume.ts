import { f, o, rt } from "@infrawrench/plugin-base";

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Fly.io persistent storage volume",
  parentTypeId: "app",
  fields: [
    f("name", "Name"),
    f("state", "State", { kind: "enum", enumValues: ["created", "destroyed", "restoring"] }),
    f("sizeGb", "Size (GB)", { kind: "number" }),
    f("region", "Region", { description: "Fly.io region code" }),
    f("encrypted", "Encrypted", { kind: "boolean", required: false }),
    f("attachedMachineId", "Attached Machine", {
      required: false,
      description: "ID of the machine this volume is attached to",
    }),
    f("appName", "App", { description: "Name of the parent app" }),
  ],
  outputs: [],
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    {
      pluginId: "fly",
      resourceTypeId: "machine",
      matchField: "region",
      verb: "Mount",
    },
  ],
});
