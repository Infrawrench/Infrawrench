import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoLocationResourceType = rt({
  name: "Location",
  pinnable: false,
  id: "turso-location",
  description: "A Turso platform location available for groups and database instances",
  fields: [f("code", "Code"), f("description", "Description", { required: false })],
  outputs: [o("locationCode", "Location Code")],
  iconKey: "turso",
});
