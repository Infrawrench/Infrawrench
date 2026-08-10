import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * The link between a user and an organization, carrying the user's role.
 * Docs: https://workos.com/docs/reference/user-management/organization-membership
 */
export const OrganizationMembershipResourceType = rt({
  name: "Membership",
  id: "organization-membership",
  plural: "Memberships",
  description:
    "An organization membership — the link between a user and an organization, carrying the user's role. Can be deactivated and reactivated without losing role assignments.",
  fields: [
    f("userEmail", "User", { required: false, editable: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("role", "Role", {
      required: false,
      description: "Role slug, e.g. `member` or `admin`. Edit to reassign the role.",
    }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["active", "inactive", "pending"],
    }),
    f("directoryManaged", "Directory Managed", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "True when Directory Sync owns this membership.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("membershipId", "Membership ID")],
  dependsOn: [{ fieldKey: "userId", targetTypeId: "user", label: "member" }],
  parentTypeId: "organization",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "member",
});
