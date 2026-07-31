import { f, o, rt } from "@infrawrench/plugin-base";

export const MediaAssetResourceType = rt({
  name: "Media Asset",
  pinnable: false,
  id: "media-asset",
  description: "An image, video, or raw file stored in Cloudinary",
  fields: [
    f("publicId", "Public ID"),
    f("displayName", "Display Name", { required: false }),
    f("resourceType", "Resource Type", { kind: "enum", enumValues: ["image", "video", "raw"] }),
    f("format", "Format", { required: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false }),
    f("width", "Width", { kind: "number", required: false }),
    f("height", "Height", { kind: "number", required: false }),
    f("folder", "Folder", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("secureUrl", "Secure URL"), o("url", "URL"), o("publicId", "Public ID")],
  dependsOn: [{ fieldKey: "folder", targetTypeId: "folder", label: "in folder" }],
  parentTypeId: "folder",
  iconKey: "media",
});
