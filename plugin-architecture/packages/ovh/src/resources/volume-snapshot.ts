import { f, rt } from "@infrawrench/plugin-base";

export const VolumeSnapshotResourceType = rt({
  id: "volume-snapshot",
  name: "Volume Snapshot",
  pinnable: false,
  description: "A point-in-time snapshot of an OVHcloud Public Cloud block volume",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("region", "Region"),
    f("sizeGb", "Size (GB)", { kind: "number", required: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      enumValues: ["available", "creating", "deleting", "error", "error_deleting"],
    }),
    f("volumeId", "Source Volume", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "volumeId", targetTypeId: "volume", label: "snapshot of" }],
  backupRole: {
    role: "snapshot",
    sourceKey: "volumeId",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
  iconKey: "snapshot",
});
