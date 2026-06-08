import { f, rt } from "@infrawrench/plugin-base";

const TYPES = [
  "classic",
  "high-speed",
  "high-speed-gen2",
  "classic-luks",
  "high-speed-luks",
  "high-speed-gen2-luks",
  "classic-multiattach",
];

export const VolumeResourceType = rt({
  id: "volume",
  name: "Volume",
  plural: "Volumes",
  description: "An OVHcloud Public Cloud block storage volume",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("sizeGb", "Size (GB)", { kind: "number" }),
    f("type", "Type", { kind: "enum", enumValues: TYPES }),
    f("status", "Status", { required: false }),
    f("bootable", "Bootable", { kind: "boolean", required: false }),
    f("attachedTo", "Attached Instance IDs", {
      required: false,
      description: "Comma-separated instance IDs this volume is attached to",
    }),
  ],
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    { pluginId: "ovh", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
});
