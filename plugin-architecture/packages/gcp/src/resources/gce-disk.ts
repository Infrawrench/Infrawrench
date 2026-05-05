import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GceDiskResourceType: ResourceTypeDefinition = {
  id: "gce-disk",
  displayName: "Persistent Disk",
  pluralDisplayName: "Persistent Disks",
  description: "A Google Compute Engine persistent disk",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "zone", label: "Zone", kind: "string", required: true },
    { key: "sizeGb", label: "Size (GB)", kind: "number", required: true },
    { key: "type", label: "Disk Type", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  supportsCreate: true,
  attachTargets: [
    { pluginId: "gcp", resourceTypeId: "gce-instance", matchField: "zone", verb: "Attach" },
  ],
};
