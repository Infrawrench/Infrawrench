import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FolderResourceType: ResourceTypeDefinition = {
  id: "folder",
  displayName: "Folder",
  pluralDisplayName: "Folders",
  description: "An organizational folder in the Cloudinary media library",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "path", label: "Path", kind: "string", required: true },
    { key: "externalId", label: "External ID", kind: "string", required: false },
  ],
  outputs: [
    { key: "path", label: "Folder Path", sensitive: false },
    { key: "name", label: "Folder Name", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "folder",
};
