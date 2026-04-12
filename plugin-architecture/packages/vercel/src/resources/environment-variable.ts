import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VercelEnvironmentVariableResourceType: ResourceTypeDefinition = {
  id: "vercel-env-var",
  displayName: "Environment Variable",
  pluralDisplayName: "Environment Variables",
  description: "An environment variable configured on a Vercel project",
  fields: [
    { key: "key", label: "Key", kind: "string", required: true },
    { key: "value", label: "Value", kind: "secret", required: false },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "target", label: "Target", kind: "string", required: false },
    { key: "projectName", label: "Project", kind: "string", required: false },
    { key: "gitBranch", label: "Git Branch", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "updatedAt", label: "Updated At", kind: "string", required: false },
  ],
  outputs: [
    { key: "envKey", label: "Variable Key", sensitive: false },
    { key: "envValue", label: "Variable Value", sensitive: true },
  ],
  dashboardPinnable: false,
  iconKey: "env",
};
