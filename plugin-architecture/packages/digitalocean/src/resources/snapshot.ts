import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SnapshotResourceType: ResourceTypeDefinition = {
  id: "snapshot",
  displayName: "Snapshot",
  pluralDisplayName: "Snapshots",
  description: "A point-in-time snapshot of a Droplet or Block Storage volume",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "resourceType",
      label: "Source Type",
      kind: "enum",
      required: false,
      enumValues: ["droplet", "volume"],
      description: "What the snapshot was captured from",
    },
    { key: "resourceId", label: "Source ID", kind: "string", required: false },
    { key: "regions", label: "Regions", kind: "string", required: false },
    { key: "sizeGb", label: "Size (GB)", kind: "number", required: false },
    { key: "minDiskSize", label: "Min Disk (GB)", kind: "number", required: false },
  ],
  outputs: [],
  parentTypeId: "project",
  showInSidebar: true,
  dashboardPinnable: true,
  iconKey: "snapshot",
};
