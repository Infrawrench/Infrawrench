import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoApiTokenResourceType = rt({
  name: "API Token",
  pinnable: false,
  id: "turso-api-token",
  description: "A Turso platform API token entry. Token secret values are not returned by the API.",
  fields: [f("id", "ID", { required: false }), f("name", "Name")],
  outputs: [o("tokenName", "Token Name")],
  // Turso returns an id and a name and nothing else, so the review can only
  // inventory these tokens and ask who owns them — which for a platform token
  // that never expires is worth asking on its own.
  principalRole: { role: "key" },
  iconKey: "turso",
});
