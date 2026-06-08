import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const InstanceGroupResourceType: ResourceTypeDefinition = {
  id: "instance-group",
  displayName: "Instance Group",
  pluralDisplayName: "Instance Groups",
  description: "A Google Compute Engine managed or unmanaged instance group",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "zone", label: "Zone", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "size", label: "Size", kind: "number", required: false },
    { key: "isManaged", label: "Managed", kind: "boolean", required: false },
    { key: "targetSize", label: "Target Size", kind: "number", required: false },
    { key: "instanceTemplate", label: "Instance Template", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  attachTargets: [
    {
      pluginId: "gcp",
      resourceTypeId: "backend-service",
      verb: "Add backend",
    },
  ],
};
