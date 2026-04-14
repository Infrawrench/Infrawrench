import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VolumeResourceType: ResourceTypeDefinition = {
  id: "volume",
  displayName: "Volume",
  pluralDisplayName: "Volumes",
  description: "A Hetzner Cloud block storage volume",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "sizeGb",
      label: "Size (GB)",
      kind: "number",
      required: true,
    },
    {
      key: "location",
      label: "Location",
      kind: "enum",
      required: true,
      enumValues: ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"],
    },
    {
      key: "format",
      label: "Filesystem",
      kind: "enum",
      required: false,
      enumValues: ["ext4", "xfs"],
    },
    {
      key: "serverId",
      label: "Attached Server",
      kind: "string",
      required: false,
      description: "ID of the server this volume is attached to, if any",
    },
    {
      key: "linuxDevice",
      label: "Linux Device",
      kind: "string",
      required: false,
      description: "Device path on the server, e.g. /dev/disk/by-id/scsi-0HC_Volume_12345",
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "volume",
};
