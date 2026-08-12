import { f, o, rt } from "@infrawrench/plugin-base";

export const ImageResourceType = rt({
  name: "Image",
  pinnable: false,
  id: "image",
  description: "A Hetzner Cloud system image, snapshot, backup, or custom image",
  fields: [
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("type", "Type"),
    f("status", "Status"),
    f("osFlavor", "OS", { required: false }),
    f("osVersion", "OS Version", { required: false }),
    f("imageSizeGb", "Image Size GB", { kind: "number", required: false }),
    f("diskSizeGb", "Disk Size GB", { kind: "number", required: false }),
    f("boundTo", "Bound To", { required: false }),
  ],
  outputs: [o("imageId", "Image ID")],
  // Only backups carry `bound_to`; it is the id of the server they were taken from.
  dependsOn: [{ fieldKey: "boundTo", targetTypeId: "server", label: "bound to" }],
  // `/images` is unfiltered — it returns every public distribution image
  // alongside the account's own snapshots and backups — so the narrowing is
  // load-bearing here, not decoration: without it every Ubuntu image in the
  // catalog would be counted as a backup of nothing. `created` never lands in
  // `fields`, so there is no `createdKey`: these prove a restore point exists
  // without dating it. A user snapshot has `boundTo: ""` and is reported as
  // unattributable — never as an orphan, which would invite deleting it.
  backupRole: {
    role: "snapshot",
    backupTypeKey: "type",
    backupTypeValues: ["backup", "snapshot"],
    sourceKey: "boundTo",
    sizeKey: "imageSizeGb",
  },
  iconKey: "image",
});
