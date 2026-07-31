import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyEnvVarResourceType = rt({
  name: "Environment Variable",
  pinnable: false,
  id: "netlify-env-var",
  description: "An environment variable set on a Netlify site, scoped to deployment contexts",
  fields: [
    f("key", "Key"),
    f("scopes", "Scopes", { required: false }),
    f("contexts", "Contexts", { required: false }),
    f("isSecret", "Secret", { kind: "boolean", required: false }),
    f("updatedAt", "Updated At", { required: false }),
    f("siteId", "Site", { required: false }),
  ],
  outputs: [o("envKey", "Variable Key")],
  dependsOn: [{ fieldKey: "siteId", targetTypeId: "netlify-site", label: "set on" }],
  parentTypeId: "netlify-site",
  supportsCreate: true,
  iconKey: "env",
});
