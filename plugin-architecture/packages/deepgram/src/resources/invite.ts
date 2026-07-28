import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A pending invitation to join a Deepgram project. Identified by email address —
 * Deepgram has no invite id.
 *
 * Docs: https://developers.deepgram.com/reference/management-api/invitations/list
 */
export const InviteResourceType = rt({
  name: "Invite",
  id: "invite",
  description:
    "A pending invitation to a Deepgram project. Invites are keyed by email address; deleting one revokes the invitation.",
  fields: [
    f("email", "Email", { editable: false }),
    f("scope", "Scope", { required: false, editable: false }),
  ],
  outputs: [o("email", "Email"), o("scope", "Scope")],
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  iconKey: "email",
});
