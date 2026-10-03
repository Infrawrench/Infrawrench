import { f, rt } from "@infrawrench/plugin-base";

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Hetzner Cloud block storage volume",
  fields: [
    f("name", "Name"),
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "Volume size. Hetzner can only grow a volume, never shrink it",
    }),
    f("location", "Location", {
      kind: "enum",
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
      editable: false,
    }),
    f("format", "Filesystem", {
      kind: "enum",
      required: false,
      enumValues: ["ext4", "xfs"],
      editable: false,
    }),
    f("serverId", "Attached Server", {
      required: false,
      description: "ID of the server this volume is attached to, if any",
      editable: false,
    }),
    f("linuxDevice", "Linux Device", {
      required: false,
      description: "Device path on the server, e.g. /dev/disk/by-id/scsi-0HC_Volume_12345",
      editable: false,
    }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "serverId", targetTypeId: "server", label: "attached to" }],
  supportsCreate: true,
  // Edit = rename + grow (`actions/resize`).
  supportsUpdate: true,
  iconKey: "volume",
  // The lister always sets serverId ("" when the volume is detached).
  orphanRule: {
    conditions: [{ fieldKey: "serverId", when: "empty" }],
    reason: "Volume is not attached to any server",
  },
  attachTargets: [
    {
      pluginId: "hetzner",
      resourceTypeId: "server",
      matchField: "location",
      verb: "Attach",
    },
  ],
});
