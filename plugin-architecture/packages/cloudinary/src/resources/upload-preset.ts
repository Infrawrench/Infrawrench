import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const UploadPresetResourceType: ResourceTypeDefinition = {
  id: "upload-preset",
  displayName: "Upload Preset",
  pluralDisplayName: "Upload Presets",
  description: "A reusable upload configuration preset in Cloudinary",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "mode",
      label: "Mode",
      kind: "enum",
      required: false,
      enumValues: ["signed", "unsigned"],
    },
    { key: "folder", label: "Target Folder", kind: "string", required: false },
    { key: "tags", label: "Tags", kind: "string", required: false },
    { key: "allowedFormats", label: "Allowed Formats", kind: "string", required: false },
    { key: "transformation", label: "Transformation", kind: "string", required: false },
  ],
  outputs: [
    { key: "presetName", label: "Preset Name", sensitive: false },
    { key: "mode", label: "Mode", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "preset",
};
