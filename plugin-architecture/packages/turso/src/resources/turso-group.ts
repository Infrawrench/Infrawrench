import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoGroupResourceType = rt({
  name: "Group",
  pinnable: false,
  id: "turso-group",
  description: "A Turso placement group — defines where database replicas are located",
  fields: [
    f("name", "Name", { editable: false }),
    f("uuid", "UUID", { required: false, editable: false }),
    f("primaryLocation", "Primary Location", { required: false, editable: false }),
    f("locations", "Locations", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("archived", "Archived", { kind: "boolean", required: false, editable: false }),
    f("deleteProtection", "Delete Protection", {
      kind: "boolean",
      required: false,
      description: "Refuse deletion of the group until protection is turned off again.",
    }),
  ],
  outputs: [o("groupName", "Group Name"), o("primaryLocation", "Primary Location")],
  dependsOn: [
    { fieldKey: "primaryLocation", targetTypeId: "turso-location", label: "primary in" },
    { fieldKey: "locations", targetTypeId: "turso-location", label: "spans" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "turso",
});
