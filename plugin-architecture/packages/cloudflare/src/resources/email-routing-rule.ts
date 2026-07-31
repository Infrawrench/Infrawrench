import { f, rt } from "@infrawrench/plugin-base";

export const EmailRoutingRuleResourceType = rt({
  name: "Email Routing Rule",
  pinnable: false,
  id: "email-routing-rule",
  description: "A Cloudflare Email Routing rule",
  fields: [
    f("name", "Name", { required: false }),
    f("enabled", "Enabled", { kind: "boolean" }),
    f("matchers", "Matchers", { required: false, editable: false }),
    f("actions", "Actions", { required: false, editable: false }),
    f("priority", "Priority", { kind: "number", required: false, editable: false }),
    f("zoneName", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" }],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "email",
});
