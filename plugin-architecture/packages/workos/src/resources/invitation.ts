import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An email invitation into an organization. Invitations expire (1–30 days,
 * default 7) and can be resent while pending or revoked.
 * Docs: https://workos.com/docs/reference/user-management/invitation
 */
export const InvitationResourceType = rt({
  name: "Invitation",
  id: "invitation",
  description:
    "An email invitation into an organization. Pending invitations can be resent or revoked; deleting one revokes it.",
  fields: [
    f("email", "Email", { editable: false }),
    f("state", "State", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["pending", "accepted", "expired", "revoked"],
    }),
    f("roleSlug", "Role", { required: false, editable: false }),
    f("expiresAt", "Expires", { required: false, editable: false }),
    f("acceptedAt", "Accepted", { required: false, editable: false }),
    f("revokedAt", "Revoked", { required: false, editable: false }),
    f("inviterUserId", "Invited By", { required: false, editable: false }),
    f("organizationId", "Organization ID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("invitationId", "Invitation ID"),
    o("acceptInvitationUrl", "Accept URL", {
      sensitive: true,
      description:
        "The URL the recipient accepts through. Contains the invitation token — treat it like a credential.",
    }),
  ],
  dependsOn: [{ fieldKey: "inviterUserId", targetTypeId: "user", label: "invited by" }],
  expiryFields: [
    { fieldKey: "expiresAt", from: "expiry", kind: "other", label: "Invitation expires" },
  ],
  parentTypeId: "organization",
  showInSidebar: true,
  supportsCreate: true,
  supportsDelete: true,
  iconKey: "invite",
});
