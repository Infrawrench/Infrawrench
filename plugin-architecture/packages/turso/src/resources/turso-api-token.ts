import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoApiTokenResourceType = rt({
  name: "API Token",
  pinnable: false,
  id: "turso-api-token",
  description: "A Turso platform API token entry. Token secret values are not returned by the API.",
  fields: [f("id", "ID", { required: false }), f("name", "Name")],
  outputs: [o("tokenName", "Token Name")],
  iconKey: "turso",
});
