import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A user synced from a Directory Sync directory. Read-only — the identity
 * provider owns these; WorkOS mirrors them.
 * Docs: https://workos.com/docs/reference/directory-sync/directory-user
 */
export const DirectoryUserResourceType = rt({
  name: "Directory User",
  id: "directory-user",
  description:
    "A user synced from a directory provider. Read-only — the IdP owns the record and Directory Sync mirrors it.",
  fields: [
    f("email", "Email", { required: false, editable: false }),
    f("firstName", "First Name", { required: false, editable: false }),
    f("lastName", "Last Name", { required: false, editable: false }),
    f("idpId", "IdP ID", { required: false, editable: false }),
    f("directoryId", "Directory ID", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("directoryUserId", "Directory User ID")],
  parentTypeId: "directory",
  supportsDelete: false,
  iconKey: "user",
});
