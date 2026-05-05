import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VolumeResourceType: ResourceTypeDefinition = {
  id: "volume",
  displayName: "Volume",
  pluralDisplayName: "Volumes",
  description: "An OVHcloud Public Cloud block storage volume",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "sizeGb", label: "Size (GB)", kind: "number", required: true },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: true,
      enumValues: [
        "classic",
        "high-speed",
        "high-speed-gen2",
        "classic-luks",
        "high-speed-luks",
        "high-speed-gen2-luks",
        "classic-multiattach",
      ],
    },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "bootable", label: "Bootable", kind: "boolean", required: false },
    {
      key: "attachedTo",
      label: "Attached Instance IDs",
      kind: "string",
      required: false,
      description: "Comma-separated instance IDs this volume is attached to",
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    {
      pluginId: "ovh",
      resourceTypeId: "instance",
      matchField: "region",
      verb: "Attach",
    },
  ],
};
