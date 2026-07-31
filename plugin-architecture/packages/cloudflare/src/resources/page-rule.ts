import { f, rt } from "@infrawrench/plugin-base";

export const PageRuleResourceType = rt({
  name: "Page Rule",
  pinnable: false,
  id: "page-rule",
  description: "A Cloudflare Page Rule for URL-based settings",
  fields: [
    f("targets", "URL Pattern", { editable: false }),
    f("actions", "Actions", { required: false, editable: false }),
    f("status", "Status"),
    f("priority", "Priority", { kind: "number", required: false }),
    f("createdOn", "Created", { required: false, editable: false }),
    f("modifiedOn", "Modified", { required: false, editable: false }),
    f("zoneName", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" }],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "rule",
});
