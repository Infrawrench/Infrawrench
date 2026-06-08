import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PlacementGroupResourceType: ResourceTypeDefinition = {
  id: "placement-group",
  displayName: "Placement Group",
  pluralDisplayName: "Placement Groups",
  description: "A Hetzner Cloud placement group for spreading servers across hosts",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: true },
    { key: "serverCount", label: "Servers", kind: "number", required: false },
  ],
  outputs: [{ key: "placementGroupId", label: "Placement Group ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "group",
};
