import { f, o, rt } from "@infrawrench/plugin-base";

export const FolderResourceType = rt({
  name: "Folder",
  id: "folder",
  description: "An organizational folder in the Cloudinary media library",
  fields: [
    f("name", "Name"),
    f("path", "Path"),
    f("externalId", "External ID", { required: false }),
  ],
  outputs: [o("path", "Folder Path"), o("name", "Folder Name")],
  supportsCreate: true,
  iconKey: "folder",
});
