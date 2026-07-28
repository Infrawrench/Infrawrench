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
  parentTypeId: "project",
  showInSidebar: true,
  supportsCreate: true,
  iconKey: "key",
});
