import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A user's membership of one workspace, with its workspace-level role.
 * Admin-key only.
 *
 * Workspace roles are separate from the organization role: an organization
 * `user` can be a `workspace_admin` of one workspace and a `workspace_user`
 * of another. `workspace_billing` can be read and set on an existing member
 * but not assigned when adding one.
 *
 * Docs: https://platform.claude.com/docs/en/api/organization/workspaces/members/list
 */
export const WorkspaceMemberResourceType = rt({
  name: "Workspace Member",
  plural: "Workspace Members",
  id: "workspace-member",
  description:
    "A member of a Console workspace and their workspace role (admin, developer, restricted developer, user or billing). Requires an Admin API key.",
  fields: [
    f("email", "Email", { required: false, editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("userId", "User ID", { editable: false }),
    f("workspaceId", "Workspace ID", { editable: false }),
    f("workspaceName", "Workspace", { required: false, editable: false }),
    f("workspaceRole", "Workspace Role", {
      kind: "enum",
      enumValues: [
        "workspace_user",
        "workspace_restricted_developer",
        "workspace_developer",
        "workspace_admin",
        "workspace_billing",
      ],
    }),
  ],
  outputs: [o("userId", "User ID"), o("workspaceId", "Workspace ID"), o("email", "Email")],
  dependsOn: [{ fieldKey: "userId", targetTypeId: "organization-user", label: "member" }],
  principalRole: {
    role: "binding",
    parentKey: "userId",
    adminIndicatorKey: "workspaceRole",
    adminValues: ["workspace_admin"],
  },
  parentTypeId: "workspace",
  showInSidebar: true,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});
