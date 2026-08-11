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
  // `apiKeyLastUsedAt` is deliberately NOT declared as `lastUsedKey`: it is
  // when this member's *API key* last made a request, not when the person last
  // signed in. A console-only member would read as never-used, and a departed
  // member whose key a cron still exercises would read as active — both the
  // wrong way round for a review.
  principalRole: {
    role: "user",
    createdKey: "addedAt",
    adminIndicatorKey: "role",
    adminValues: ["owner"],
  },
  iconKey: "user",
  supportsUpdate: true,
  supportsDelete: true,
});
