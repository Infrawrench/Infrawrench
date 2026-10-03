import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A group of organization memberships, managed through the Groups API. Roles
 * can be assigned to a group so every member inherits them.
 * Docs: https://workos.com/docs/reference/groups
 */
export const GroupResourceType = rt({
  name: "Group",
  id: "group",
  description:
    "A named set of an organization's memberships. Add and remove members here; roles assigned to the group apply to every member.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID")],
  principalRole: { role: "group", createdKey: "createdAt", parentKey: "organizationId" },
  parentTypeId: "organization",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "group",
});
