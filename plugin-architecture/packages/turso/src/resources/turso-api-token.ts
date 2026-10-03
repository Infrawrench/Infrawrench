import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoApiTokenResourceType = rt({
  name: "API Token",
  pinnable: false,
  id: "turso-api-token",
  description: "A Turso platform API token entry. Token secret values are not returned by the API.",
  fields: [
    f("id", "ID", { required: false }),
    f("name", "Name"),
    f("group", "Group", { required: false }),
    f("scopes", "Scopes", { required: false }),
    f("ownerUsername", "Owner", { required: false }),
    f("ownerEmail", "Owner Email", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [o("tokenName", "Token Name")],
  dependsOn: [
    { fieldKey: "group", targetTypeId: "turso-group", label: "scoped to" },
    { fieldKey: "ownerUsername", targetTypeId: "turso-organization-member", label: "owned by" },
  ],
  // Turso reports no last-used time, so the review can only inventory these
  // tokens, their owner and their age. An unscoped platform token never
  // expires, which is worth asking about on its own.
  principalRole: { role: "key", createdKey: "createdAt" },
  iconKey: "turso",
});
