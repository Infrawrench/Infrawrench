import { f, o, rt } from "@infrawrench/plugin-base";

export const UploadPresetResourceType = rt({
  name: "Upload Preset",
  id: "upload-preset",
  description: "A reusable upload configuration preset in Cloudinary",
  fields: [
    f("name", "Name"),
    f("mode", "Mode", { kind: "enum", required: false, enumValues: ["signed", "unsigned"] }),
    f("folder", "Target Folder", { required: false }),
    f("tags", "Tags", { required: false }),
    f("allowedFormats", "Allowed Formats", { required: false }),
    f("transformation", "Transformation", { required: false }),
  ],
  outputs: [o("presetName", "Preset Name"), o("mode", "Mode")],
  dependsOn: [{ fieldKey: "folder", targetTypeId: "folder", label: "uploads to" }],
  supportsCreate: true,
  iconKey: "preset",
});
