import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoGroupResourceType = rt({
  name: "Group",
  pinnable: false,
  id: "turso-group",
  description: "A Turso placement group — defines where database replicas are located",
  fields: [
    f("name", "Name"),
    f("primaryLocation", "Primary Location", { required: false }),
    f("locations", "Locations", { required: false }),
    f("version", "Version", { required: false }),
  ],
  outputs: [o("groupName", "Group Name"), o("primaryLocation", "Primary Location")],
  supportsCreate: true,
  iconKey: "turso",
});
