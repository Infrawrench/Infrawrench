import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TursoGroupResourceType: ResourceTypeDefinition = {
  id: "turso-group",
  displayName: "Group",
  pluralDisplayName: "Groups",
  description: "A Turso placement group — defines where database replicas are located",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "primaryLocation", label: "Primary Location", kind: "string", required: false },
    { key: "locations", label: "Locations", kind: "string", required: false },
    { key: "version", label: "Version", kind: "string", required: false },
  ],
  outputs: [
    { key: "groupName", label: "Group Name", sensitive: false },
    { key: "primaryLocation", label: "Primary Location", sensitive: false },
  ],
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "turso",
};
