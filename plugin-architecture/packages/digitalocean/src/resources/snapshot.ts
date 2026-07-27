import { f, rt } from "@infrawrench/plugin-base";

export const SnapshotResourceType = rt({
  name: "Snapshot",
  id: "snapshot",
  description: "A point-in-time snapshot of a Droplet or Block Storage volume",
  fields: [
    f("name", "Name"),
    f("resourceType", "Source Type", {
      kind: "enum",
      required: false,
      enumValues: ["droplet", "volume"],
      description: "What the snapshot was captured from",
    }),
    f("resourceId", "Source ID", { required: false }),
    f("regions", "Regions", { required: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false }),
    f("minDiskSize", "Min Disk (GB)", { kind: "number", required: false }),
  ],
  outputs: [],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "snapshot",
});
