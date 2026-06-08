import { f, o, rt } from "@infrawrench/plugin-base";

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Hetzner Cloud block storage volume",
  fields: [
    f("name", "Name"),
    f("sizeGb", "Size (GB)", { kind: "number" }),
    f("location", "Location", {
      kind: "enum",
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
    }),
    f("format", "Filesystem", { kind: "enum", required: false, enumValues: ["ext4", "xfs"] }),
    f("serverId", "Attached Server", {
      required: false,
      description: "ID of the server this volume is attached to, if any",
    }),
    f("linuxDevice", "Linux Device", {
      required: false,
      description: "Device path on the server, e.g. /dev/disk/by-id/scsi-0HC_Volume_12345",
    }),
  ],
  outputs: [],
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    {
      pluginId: "hetzner",
      resourceTypeId: "server",
      matchField: "location",
      verb: "Attach",
    },
  ],
});
