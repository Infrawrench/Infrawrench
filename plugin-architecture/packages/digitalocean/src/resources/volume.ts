import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VolumeResourceType: ResourceTypeDefinition = {
  id: "volume",
  displayName: "Volume",
  pluralDisplayName: "Volumes",
  description: "A DigitalOcean Block Storage volume",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "sizeGb", label: "Size (GB)", kind: "number", required: true },
    {
      key: "filesystemType",
      label: "Filesystem",
      kind: "enum",
      required: false,
      enumValues: ["ext4", "xfs", ""],
    },
    {
      key: "dropletIds",
      label: "Attached Droplet IDs",
      kind: "string",
      required: false,
      description: "Comma-separated droplet IDs this volume is attached to",
    },
  ],
  outputs: [],
  parentTypeId: "project",
  showInSidebar: true,
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    {
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      matchField: "region",
      verb: "Attach",
    },
  ],
};
