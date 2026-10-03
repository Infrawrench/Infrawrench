import { f, o, rt } from "@infrawrench/plugin-base";

export const MediaAssetResourceType = rt({
  name: "Media Asset",
  pinnable: false,
  id: "media-asset",
  description: "An image, video, or raw file stored in Cloudinary",
  fields: [
    f("publicId", "Public ID", { editable: false }),
    f("displayName", "Display Name", {
      required: false,
      description: "Name shown in the Media Library. Can't contain `/`; doesn't change the URL.",
    }),
    f("resourceType", "Resource Type", {
      kind: "enum",
      enumValues: ["image", "video", "raw"],
      editable: false,
    }),
    f("deliveryType", "Delivery Type", { required: false, editable: false }),
    f("format", "Format", { required: false, editable: false }),
    f("bytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
    f("width", "Width", { kind: "number", required: false, editable: false }),
    f("height", "Height", { kind: "number", required: false, editable: false }),
    f("folder", "Folder", {
      required: false,
      description: "Asset folder. Changing it moves the asset without changing its public ID.",
    }),
    f("tags", "Tags", { required: false, description: "Comma-separated tag names" }),
    f("accessMode", "Access Mode", { required: false, editable: false }),
    f("assetId", "Asset ID", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [o("secureUrl", "Secure URL"), o("url", "URL"), o("publicId", "Public ID")],
  dependsOn: [{ fieldKey: "folder", targetTypeId: "folder", label: "in folder" }],
  parentTypeId: "folder",
  supportsUpdate: true,
  iconKey: "media",
});
