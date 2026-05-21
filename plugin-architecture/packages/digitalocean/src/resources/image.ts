import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ImageResourceType: ResourceTypeDefinition = {
  id: "image",
  displayName: "Image",
  pluralDisplayName: "Images",
  description: "A custom Droplet image (uploaded image, backup, or snapshot promoted to an image)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "type",
      label: "Type",
      kind: "enum",
      required: false,
      enumValues: ["snapshot", "backup", "custom", "distribution", "application"],
    },
    { key: "distribution", label: "Distribution", kind: "string", required: false },
    { key: "slug", label: "Slug", kind: "string", required: false },
    { key: "regions", label: "Regions", kind: "string", required: false },
    { key: "sizeGb", label: "Size (GB)", kind: "number", required: false },
    { key: "minDiskSize", label: "Min Disk (GB)", kind: "number", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "project",
  showInSidebar: true,
  dashboardPinnable: true,
  iconKey: "image",
};
