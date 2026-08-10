import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelEnvironmentVariableResourceType = rt({
  name: "Environment Variable",
  pinnable: false,
  id: "vercel-env-var",
  description: "An environment variable configured on a Vercel project",
  fields: [
    f("key", "Key"),
    f("value", "Value", { kind: "secret", required: false }),
    f("type", "Type", { required: false }),
    f("target", "Target", { required: false }),
    f("projectName", "Project", { required: false }),
    f("gitBranch", "Git Branch", { required: false }),
    f("createdAt", "Created At", { required: false }),
    f("updatedAt", "Updated At", { required: false }),
  ],
  outputs: [o("envKey", "Variable Key"), o("envValue", "Variable Value", { sensitive: true })],
  // The lister stores the project's name, not its id — match on the project's
  // `name` field rather than the `prj_…` external id.
  dependsOn: [
    {
      fieldKey: "projectName",
      targetTypeId: "vercel-project",
      targetKey: "name",
      label: "in project",
    },
  ],
  supportsCreate: true,
  iconKey: "env",
});
