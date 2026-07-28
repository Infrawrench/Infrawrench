import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET /v1/organization/users`, `POST/DELETE /v1/organization/users/{user_id}`
 * — verified 2026-07-29 against openapi.yaml v2.3.0 (`list-users`,
 * `modify-user`, `delete-user`). Admin key only.
 */
export const OrganizationUserResourceType = rt({
  name: "Organization Member",
  plural: "Organization Members",
  id: "organization-user",
  description:
    "A member of the OpenAI organization. Roles are `owner` or `reader`; deleting removes them from the organization. Requires an Admin API key.",
  fields: [
    f("name", "Name", { required: false }),
    f("email", "Email", { required: false }),
    f("role", "Role", { kind: "enum", enumValues: ["owner", "reader"], required: false }),
    f("addedAt", "Added", { required: false }),
    f("isServiceAccount", "Service Account", { kind: "boolean", required: false }),
    f("isScimManaged", "SCIM Managed", { kind: "boolean", required: false }),
    f("apiKeyLastUsedAt", "API Key Last Used", { required: false }),
  ],
  outputs: [o("userId", "User ID"), o("email", "Email")],
  iconKey: "user",
  supportsUpdate: true,
  supportsDelete: true,
});
