import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Deepgram API key scoped to one project.
 *
 * Docs: https://developers.deepgram.com/reference/management-api/keys/list
 */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "An API key belonging to a Deepgram project. The secret is returned once at creation and never again — Deepgram only stores the key id and a truncated prefix.",
  fields: [
    f("comment", "Comment", { required: false }),
    f("scopes", "Scopes", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
    f("apiKeyId", "Key ID", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
    f("expirationDate", "Expires", { required: false, editable: false }),
    f("memberEmail", "Owner", { required: false, editable: false }),
  ],
  outputs: [
    o("apiKeyId", "Key ID"),
    o("apiKey", "API Key", {
      sensitive: true,
      description: "The secret key. Only available on the response that created it.",
    }),
  ],
  // The list endpoint returns the owning member alongside each key, and members
  // are addressed by email rather than by their composite external id. (The
  // owning project is already the parent link.)
  dependsOn: [
    { fieldKey: "memberEmail", targetTypeId: "member", targetKey: "email", label: "owned by" },
  ],
  expiryFields: [
    { fieldKey: "expirationDate", from: "expiry", kind: "api-token", label: "Key expires" },
  ],
  // `scopes` is a joined list, so the whole-value match only flags a key whose
  // sole scope is admin or owner — deliberately narrow, for the reason the
  // WorkOS role declaration gives. No last-used: Deepgram reports none.
  principalRole: {
    role: "key",
    createdKey: "created",
    adminIndicatorKey: "scopes",
    adminValues: ["admin", "owner"],
    parentKey: "memberEmail",
  },
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  iconKey: "key",
});
