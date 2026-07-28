import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A person who has accepted membership of a Deepgram project.
 *
 * Docs: https://developers.deepgram.com/reference/management-api/members/list
 */
export const MemberResourceType = rt({
  name: "Member",
  id: "member",
  description:
    "A user with access to a Deepgram project. Deleting a member removes them from the project and revokes every API key they own within it.",
  fields: [
    f("email", "Email", { editable: false }),
    f("firstName", "First Name", { required: false, editable: false }),
    f("lastName", "Last Name", { required: false, editable: false }),
    f("memberId", "Member ID", { required: false, editable: false }),
    // The only editable attribute: PUT /members/{id}/scopes changes the role.
    f("scopes", "Role", {
      kind: "enum",
      required: false,
      enumValues: ["member", "admin", "owner"],
    }),
  ],
  outputs: [o("memberId", "Member ID"), o("email", "Email")],
  parentTypeId: "project",
  showInSidebar: true,
  supportsUpdate: true,
  iconKey: "user",
});
