import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BlockVolumeResourceType: ResourceTypeDefinition = {
  id: "block-volume",
  displayName: "Block Volume",
  pluralDisplayName: "Block Volumes",
  description: "A Scaleway Block Storage volume (sbs_volume)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "zone",
      label: "Zone",
      kind: "enum",
      required: true,
      enumValues: [
        "fr-par-1",
        "fr-par-2",
        "fr-par-3",
        "nl-ams-1",
        "nl-ams-2",
        "nl-ams-3",
        "pl-waw-1",
        "pl-waw-2",
        "pl-waw-3",
      ],
    },
    { key: "sizeGb", label: "Size (GB)", kind: "number", required: true },
    {
      key: "perfIops",
      label: "IOPS",
      kind: "enum",
      required: false,
      enumValues: ["5000", "15000"],
    },
    { key: "status", label: "Status", kind: "string", required: false },
    {
      key: "attachedInstanceId",
      label: "Attached Instance ID",
      kind: "string",
      required: false,
      description: "ID of the instance this volume is attached to, if any",
    },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "volume",
  attachTargets: [
    {
      pluginId: "scaleway",
      resourceTypeId: "instance",
      matchField: "zone",
      verb: "Attach",
    },
  ],
};
