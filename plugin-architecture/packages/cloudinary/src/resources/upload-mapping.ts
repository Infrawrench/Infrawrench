import { f, o, rt } from "@infrawrench/plugin-base";

export const UploadMappingResourceType = rt({
  name: "Upload Mapping",
  id: "upload-mapping",
  description:
    "An auto-upload mapping: a folder name whose delivery URLs fetch and store files from a remote URL prefix",
  fields: [
    f("folder", "Folder", { editable: false }),
    f("template", "Remote URL Prefix", {
      description: "The URL prefix files are fetched from, e.g. https://images.example.com/assets/",
    }),
    f("externalId", "External ID", { required: false, editable: false }),
  ],
  outputs: [o("folder", "Mapped Folder"), o("template", "Remote URL Prefix")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "link",
});
