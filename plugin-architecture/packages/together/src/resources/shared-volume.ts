import { f, o, rt } from "@infrawrench/plugin-base";

export const SharedVolumeResourceType = rt({
  name: "Shared Volume",
  id: "shared-volume",
  description:
    "Resizable, high-throughput shared storage for GPU clusters in one region. It outlives the clusters it is attached to.",
  fields: [
    f("volumeName", "Name", { editable: false }),
    f("volumeId", "Volume ID", { editable: false }),
    f("sizeTib", "Size (TiB)", {
      kind: "number",
      description: "Whole tebibytes. Volumes can grow; Together does not document shrinking.",
    }),
    f("status", "Status", { required: false, editable: false }),
  ],
  outputs: [o("volumeId", "Volume ID"), o("volumeName", "Volume Name")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "volume",
});
