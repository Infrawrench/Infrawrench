import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ImageResourceType: ResourceTypeDefinition = {
  id: "image",
  displayName: "Image",
  pluralDisplayName: "Images",
  description: "A Hetzner Cloud system image, snapshot, backup, or custom image",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "type", label: "Type", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "osFlavor", label: "OS", kind: "string", required: false },
    { key: "osVersion", label: "OS Version", kind: "string", required: false },
    { key: "imageSizeGb", label: "Image Size GB", kind: "number", required: false },
    { key: "diskSizeGb", label: "Disk Size GB", kind: "number", required: false },
    { key: "boundTo", label: "Bound To", kind: "string", required: false },
  ],
  outputs: [{ key: "imageId", label: "Image ID", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "image",
};
