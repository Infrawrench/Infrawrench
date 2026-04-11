import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FilestoreInstanceResourceType: ResourceTypeDefinition = {
  id: "filestore-instance",
  displayName: "Filestore Instance",
  pluralDisplayName: "Filestore Instances",
  description: "A Google Cloud Filestore managed NFS file server",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "tier", label: "Tier", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "capacityGb", label: "Capacity (GB)", kind: "number", required: false },
    { key: "network", label: "Network", kind: "string", required: false },
    { key: "fileShareName", label: "File Share Name", kind: "string", required: false },
    { key: "ipAddress", label: "IP Address", kind: "string", required: false },
  ],
  outputs: [{ key: "ipAddress", label: "IP Address", sensitive: false }],
  dashboardPinnable: true,
};
