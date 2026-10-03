import { f, o, rt } from "@infrawrench/plugin-base";

export const UploadPresetResourceType = rt({
  name: "Upload Preset",
  id: "upload-preset",
  description: "A reusable upload configuration preset in Cloudinary",
  fields: [
    f("name", "Name", { editable: false }),
    f("mode", "Mode", { kind: "enum", required: false, enumValues: ["signed", "unsigned"] }),
    f("folder", "Target Folder", { required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated tags added on upload" }),
    f("allowedFormats", "Allowed Formats", {
      required: false,
      description: "Comma-separated file extensions, e.g. jpg,png",
    }),
    f("transformation", "Transformation", {
      required: false,
      description: "Incoming transformation, e.g. t_thumb or w_1000,c_limit",
    }),
    f("disallowPublicId", "Disallow Public ID", { kind: "boolean", required: false }),
    f("externalId", "External ID", { required: false, editable: false }),
  ],
  outputs: [o("presetName", "Preset Name"), o("mode", "Mode")],
  dependsOn: [{ fieldKey: "folder", targetTypeId: "folder", label: "uploads to" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "preset",
});
