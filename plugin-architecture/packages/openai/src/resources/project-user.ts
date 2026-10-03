import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/organization/projects/{project_id}/users`,
 * `POST/DELETE …/users/{user_id}`: verified 2026-10-03 against openapi.yaml
 * (`list-project-users`, `create-project-user`, `modify-project-user`,
 * `delete-project-user`). Admin key only.
 *
 * Only existing organization members can be added; the project role is
 * `owner` or `member`, independent of the organization role.
 */
export const ProjectUserResourceType = rt({
  name: "Project Member",
  plural: "Project Members",
  id: "project-user",
  description:
    "A person with access to a project, and their project role (owner or member). Requires an Admin API key.",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("userId", "User ID", { editable: false }),
    f("projectId", "Project ID", { editable: false }),
    f("projectName", "Project", { required: false, editable: false }),
    f("role", "Project Role", { kind: "enum", enumValues: ["member", "owner"] }),
    f("addedAt", "Added", { required: false, editable: false }),
  ],
  outputs: [o("userId", "User ID"), o("projectId", "Project ID"), o("email", "Email")],
  dependsOn: [{ fieldKey: "userId", targetTypeId: "organization-user", label: "member" }],
  principalRole: {
    role: "binding",
    createdKey: "addedAt",
    parentKey: "email",
    adminIndicatorKey: "role",
    adminValues: ["owner"],
  },
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "user",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
});
