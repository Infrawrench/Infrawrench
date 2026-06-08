import { f, o, rt } from "@infrawrench/plugin-base";

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A DigitalOcean Block Storage volume",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("sizeGb", "Size (GB)", { kind: "number" }),
    f("filesystemType", "Filesystem", {
      kind: "enum",
      required: false,
      enumValues: ["ext4", "xfs", ""],
    }),
    f("dropletIds", "Attached Droplet IDs", {
      required: false,
      description: "Comma-separated droplet IDs this volume is attached to",
    }),
  ],
  outputs: [],
  parentTypeId: "project",
  showInSidebar: true,
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
});
