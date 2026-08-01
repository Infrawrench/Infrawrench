import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/organization/invites`, `DELETE /v1/organization/invites/{id}` —
 * verified 2026-07-29 against openapi.yaml v2.3.0 (`list-invites`,
 * `inviteUser`, `delete-invite`). Admin key only.
 *
 * An accepted invite cannot be deleted — the API rejects it.
 */
export const InviteResourceType = rt({
  name: "Invite",
  id: "invite",
  description:
    "A pending invitation to join the organization. Requires an Admin API key. Accepted invites can no longer be revoked.",
  fields: [
    f("email", "Email"),
    f("role", "Role", { kind: "enum", enumValues: ["owner", "reader"], required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["pending", "accepted", "expired"],
      required: false,
    }),
    f("projects", "Projects", { required: false }),
    f("createdAt", "Sent", { required: false }),
    f("expiresAt", "Expires", { required: false }),
    f("acceptedAt", "Accepted", { required: false }),
  ],
  outputs: [o("inviteId", "Invite ID"), o("email", "Email")],
  expiryFields: [{ fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Invite expires" }],
  iconKey: "email",
  supportsCreate: true,
  supportsDelete: true,
});
