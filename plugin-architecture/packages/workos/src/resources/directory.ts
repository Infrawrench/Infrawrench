import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Directory Sync directory — the SCIM/HRIS link that streams an
 * organization's users and groups into WorkOS.
 * Docs: https://workos.com/docs/reference/directory-sync
 */
export const DirectoryResourceType = rt({
  name: "Directory",
  id: "directory",
  plural: "Directories",
  description:
    "A Directory Sync directory (Okta SCIM, Entra/Azure SCIM, Google Workspace, Workday, …). Owns the synced directory users and groups. Set up via the dashboard or Admin Portal; deletable here.",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Provider", { required: false, editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["linked", "validating", "invalid_credentials", "unlinked", "deleting"],
    }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("externalKey", "External Key", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("directoryId", "Directory ID")],
  parentTypeId: "organization",
  showInSidebar: true,
  supportsDelete: true,
  iconKey: "directory",
});
