import { f, rt } from "@infrawrench/plugin-base";

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
  // `attachedMachineId` is a bare machine id while a machine's external id is
  // `{appName}/{machineId}`. A volume only ever attaches within its own app, so
  // composing the qualified id is exact.
  dependsOn: [
    { fieldKey: "appName", targetTypeId: "app", label: "in app" },
    {
      fieldKey: "attachedMachineId",
      targetTypeId: "machine",
      matchTemplate: "{appName}/{attachedMachineId}",
      label: "attached to",
    },
  ],
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
