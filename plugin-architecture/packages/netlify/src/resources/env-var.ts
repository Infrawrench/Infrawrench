import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyEnvVarResourceType = rt({
  name: "Environment Variable",
  pinnable: false,
  id: "netlify-env-var",
  description: "An environment variable set on a Netlify site, scoped to deployment contexts",
  fields: [
    f("key", "Key", { editable: false }),
    f("scopes", "Scopes", { required: false, editable: false }),
    f("contexts", "Contexts", { required: false, editable: false }),
    f("isSecret", "Secret", { kind: "boolean", required: false, editable: false }),
    f("newValue", "New Value", {
      kind: "password",
      required: false,
      description: "Set the value for the context below. Leave blank to keep the current values.",
    }),
    f("valueContext", "Context", {
      kind: "enum",
      enumValues: ["all", "production", "deploy-preview", "branch-deploy", "dev"],
      required: false,
      description: "Which deploy context the new value applies to",
    }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
    f("siteId", "Site", { required: false, editable: false }),
  ],
  outputs: [o("envKey", "Variable Key")],
  dependsOn: [{ fieldKey: "siteId", targetTypeId: "netlify-site", label: "set on" }],
  parentTypeId: "netlify-site",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "env",
});
