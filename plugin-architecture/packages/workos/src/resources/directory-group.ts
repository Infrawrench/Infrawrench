import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A group synced from a Directory Sync directory. Read-only mirror of the
 * IdP's group.
 * Docs: https://workos.com/docs/reference/directory-sync/directory-group
 */
export const DirectoryGroupResourceType = rt({
  name: "Directory Group",
  id: "directory-group",
  description:
    "A group synced from a directory provider. Read-only — the IdP owns the group and Directory Sync mirrors it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("idpId", "IdP ID", { required: false, editable: false }),
    f("directoryId", "Directory ID", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("directoryGroupId", "Directory Group ID")],
  parentTypeId: "directory",
  supportsDelete: false,
  iconKey: "group",
});
