import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MediaAssetResourceType: ResourceTypeDefinition = {
  id: "media-asset",
  displayName: "Media Asset",
  pluralDisplayName: "Media Assets",
  description: "An image, video, or raw file stored in Cloudinary",
  fields: [
    { key: "publicId", label: "Public ID", kind: "string", required: true },
    { key: "displayName", label: "Display Name", kind: "string", required: false },
    {
      key: "resourceType",
      label: "Resource Type",
      kind: "enum",
      required: true,
      enumValues: ["image", "video", "raw"],
    },
    { key: "format", label: "Format", kind: "string", required: false },
    { key: "bytes", label: "Size (bytes)", kind: "number", required: false },
    { key: "width", label: "Width", kind: "number", required: false },
    { key: "height", label: "Height", kind: "number", required: false },
    { key: "folder", label: "Folder", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
  ],
  outputs: [
    { key: "secureUrl", label: "Secure URL", sensitive: false },
    { key: "url", label: "URL", sensitive: false },
    { key: "publicId", label: "Public ID", sensitive: false },
  ],
  parentTypeId: "folder",
  dashboardPinnable: false,
  iconKey: "media",
};
