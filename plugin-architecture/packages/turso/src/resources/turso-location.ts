import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TursoLocationResourceType: ResourceTypeDefinition = {
  id: "turso-location",
  displayName: "Location",
  pluralDisplayName: "Locations",
  description: "A Turso platform location available for groups and database instances",
  fields: [
    { key: "code", label: "Code", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
  ],
  outputs: [{ key: "locationCode", label: "Location Code", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "turso",
};
