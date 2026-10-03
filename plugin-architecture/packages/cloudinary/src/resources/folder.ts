import { f, o, rt } from "@infrawrench/plugin-base";

export const FolderResourceType = rt({
  name: "Folder",
  id: "folder",
  description: "An organizational folder in the Cloudinary media library",
  fields: [
    f("name", "Name", { editable: false }),
    f("path", "Path", {
      description:
        "Full folder path. Changing it renames or moves the folder (dynamic folder mode only).",
    }),
    f("externalId", "External ID", { required: false, editable: false }),
  ],
  outputs: [o("path", "Folder Path"), o("name", "Folder Name")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "folder",
});
