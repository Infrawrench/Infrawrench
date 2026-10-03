import { f, o, rt } from "@infrawrench/plugin-base";

export const VercelEnvironmentVariableResourceType = rt({
  name: "Environment Variable",
  pinnable: false,
  id: "vercel-env-var",
  description: "An environment variable configured on a Vercel project",
  fields: [
    f("key", "Key", { editable: false }),
    f("value", "Value", { kind: "secret", required: false }),
    f("newValue", "New Value", {
      kind: "password",
      required: false,
      description: "Replace the value. Leave blank to keep the current one.",
    }),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["encrypted", "sensitive", "plain"],
      required: false,
      description: "Sensitive values can never be read back, even by the owner",
    }),
    f("target", "Target", {
      required: false,
      description: "Comma-separated: production, preview, development",
    }),
    f("projectName", "Project", { required: false, editable: false }),
    f("gitBranch", "Git Branch", {
      required: false,
      description: "Limit a preview variable to one branch",
    }),
    f("comment", "Comment", { required: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [o("envKey", "Variable Key"), o("envValue", "Variable Value", { sensitive: true })],
  // The lister stores the project's name, not its id: match on the project's
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
  supportsUpdate: true,
  iconKey: "env",
});
