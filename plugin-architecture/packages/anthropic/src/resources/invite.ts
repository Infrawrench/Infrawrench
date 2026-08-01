import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A pending invitation to the Console organization. Admin-key only.
 *
 * Invites expire after 21 days and the expiry cannot be changed. On seat-based
 * plans, creating an invite consumes a seat from the lowest tier with
 * availability and fails with a 400 when none is free.
 *
 * Docs: https://platform.claude.com/docs/en/api/admin-api/invites/list-invites
 */
export const InviteResourceType = rt({
  name: "Invite",
  id: "invite",
  description:
    "A pending invitation to the Console organization. Requires an Admin API key. Invites expire 21 days after creation and consume a seat on seat-based plans.",
  fields: [
    f("email", "Email", { editable: false }),
    f("role", "Role", {
      kind: "enum",
      editable: false,
      enumValues: [
        "user",
        "developer",
        "billing",
        "claude_code_user",
        "managed",
        "admin",
        "membership_admin",
        "owner",
        "primary_owner",
      ],
    }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["pending", "accepted", "expired", "deleted"],
    }),
    f("invitedAt", "Invited", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("acceptedAt", "Accepted", { required: false, editable: false }),
  ],
  outputs: [o("inviteId", "Invite ID"), o("email", "Email")],
  expiryFields: [{ fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Invite expires" }],
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "email",
});
