import { f, rt } from "@infrawrench/plugin-base";

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Fly.io persistent storage volume",
  parentTypeId: "app",
  fields: [
    f("name", "Name", { editable: false }),
    f("state", "State", {
      kind: "enum",
      enumValues: ["created", "destroyed", "restoring"],
      editable: false,
    }),
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description:
        "Volumes can only grow. The attached machine may need a restart to see the new size.",
    }),
    f("region", "Region", { description: "Fly.io region code", editable: false }),
    f("zone", "Zone", { required: false, editable: false }),
    f("encrypted", "Encrypted", { kind: "boolean", required: false, editable: false }),
    f("autoBackupEnabled", "Automatic Snapshots", {
      kind: "boolean",
      required: false,
      description: "Take a daily snapshot of this volume",
    }),
    f("snapshotRetention", "Snapshot Retention (days)", {
      kind: "number",
      required: false,
      description: "How many days snapshots are kept (1 to 60)",
    }),
    f("bytesUsed", "Used (bytes)", { kind: "number", required: false, editable: false }),
    f("bytesTotal", "Capacity (bytes)", { kind: "number", required: false, editable: false }),
    f("hostStatus", "Host Status", { required: false, editable: false }),
    f("attachedMachineId", "Attached Machine", {
      required: false,
      editable: false,
      description: "ID of the machine this volume is attached to",
    }),
    f("appName", "App", { description: "Name of the parent app", editable: false }),
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
  supportsUpdate: true,
  // `fly_volume_used_pct` / `fly_volume_size_bytes` from the org's Prometheus.
  supportsMetrics: true,
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
