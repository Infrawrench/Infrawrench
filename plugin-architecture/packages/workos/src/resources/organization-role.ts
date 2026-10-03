import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A custom role defined for one organization through the Authorization API.
 * Unlike environment roles these can be deleted. Slugs start with `org-`.
 * Docs: https://workos.com/docs/reference/roles/organization-role
 */
export const OrganizationRoleResourceType = rt({
  name: "Organization Role",
  id: "organization-role",
  description:
    "A custom role scoped to a single organization. Assign it to that organization's memberships; delete it when it is no longer used.",
  fields: [
    f("slug", "Slug", { editable: false }),
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("permissions", "Permissions", {
      required: false,
      editable: false,
      description: "Permission slugs assigned to the role, comma-separated.",
    }),
    f("resourceTypeSlug", "Resource type", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("roleSlug", "Role Slug")],
  principalRole: {
    role: "role",
    createdKey: "createdAt",
    adminIndicatorKey: "permissions",
    adminValues: ["*"],
  },
  parentTypeId: "organization",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "role",
});
