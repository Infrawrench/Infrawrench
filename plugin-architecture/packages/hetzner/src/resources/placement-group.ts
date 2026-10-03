import { f, o, rt } from "@infrawrench/plugin-base";

export const PlacementGroupResourceType = rt({
  name: "Placement Group",
  id: "placement-group",
  description: "A Hetzner Cloud placement group for spreading servers across hosts",
  fields: [
    f("name", "Name"),
    f("type", "Type", { editable: false }),
    f("serverCount", "Servers", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("placementGroupId", "Placement Group ID")],
  supportsCreate: true,
  // Edit = `PUT` on the object itself (name, plus the fields left editable).
  supportsUpdate: true,
  iconKey: "group",
  attachTargets: [{ pluginId: "hetzner", resourceTypeId: "server", verb: "Add server" }],
});
