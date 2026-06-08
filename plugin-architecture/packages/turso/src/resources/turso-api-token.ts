import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TursoApiTokenResourceType: ResourceTypeDefinition = {
  id: "turso-api-token",
  displayName: "API Token",
  pluralDisplayName: "API Tokens",
  description: "A Turso platform API token entry. Token secret values are not returned by the API.",
  fields: [
    { key: "id", label: "ID", kind: "string", required: false },
    { key: "name", label: "Name", kind: "string", required: true },
  ],
  outputs: [{ key: "tokenName", label: "Token Name", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "turso",
};
