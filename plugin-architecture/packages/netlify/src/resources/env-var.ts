import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NetlifyEnvVarResourceType: ResourceTypeDefinition = {
  id: "netlify-env-var",
  displayName: "Environment Variable",
  pluralDisplayName: "Environment Variables",
  description: "An environment variable set on a Netlify site, scoped to deployment contexts",
  fields: [
    { key: "key", label: "Key", kind: "string", required: true },
    { key: "scopes", label: "Scopes", kind: "string", required: false },
    { key: "contexts", label: "Contexts", kind: "string", required: false },
    { key: "isSecret", label: "Secret", kind: "boolean", required: false },
    { key: "updatedAt", label: "Updated At", kind: "string", required: false },
  ],
  outputs: [{ key: "envKey", label: "Variable Key", sensitive: false }],
  parentTypeId: "netlify-site",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "env",
};
