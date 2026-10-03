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
    f("description", "Description", { required: false }),
    f("region", "Region", { editable: false }),
    f("availabilityZone", "Availability Zone", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "Volume size. OVH can only grow a volume (upsize), never shrink it",
    }),
    f("type", "Type", { kind: "enum", enumValues: TYPES, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("bootable", "Bootable", { kind: "boolean", required: false, editable: false }),
    f("attachedTo", "Attached Instance IDs", {
      required: false,
      description: "Comma-separated instance IDs this volume is attached to",
      editable: false,
    }),
  ],
  // Comma-joined `attachedTo`: one edge per instance (multiattach volumes
  // can hold several).
  dependsOn: [{ fieldKey: "attachedTo", targetTypeId: "instance", label: "attached to" }],
  supportsCreate: true,
  // Edit = name/description (`PUT /volume/{id}`) and grow (`POST /upsize`).
  supportsUpdate: true,
  iconKey: "volume",
  backupPolicy: { protectedBy: ["volume-snapshot"] },
  orphanRule: {
    conditions: [{ fieldKey: "attachedTo", when: "empty" }],
    reason: "Volume is not attached to any instance",
  },
  attachTargets: [
    { pluginId: "ovh", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
});
