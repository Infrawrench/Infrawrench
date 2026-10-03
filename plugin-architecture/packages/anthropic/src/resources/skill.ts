import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An Agent Skill visible to the API key's workspace: custom Skills uploaded
 * through the Skills API, plus Anthropic's pre-built ones (pptx, xlsx, docx,
 * pdf). Skills load into a Messages request through the `container`
 * parameter alongside the code execution tool.
 *
 * Deleting a custom Skill removes every version with it. Anthropic-published
 * Skills are read-only.
 *
 * Docs: https://platform.claude.com/docs/en/api/skills/list
 */
export const SkillResourceType = rt({
  name: "Skill",
  id: "skill",
  description:
    "An Agent Skill: a packaged folder of instructions and scripts Claude loads on demand. Lists custom Skills and Anthropic's pre-built ones; custom Skills can be deleted along with all their versions.",
  fields: [
    f("displayName", "Display Name", { editable: false }),
    f("source", "Source", {
      kind: "enum",
      editable: false,
      enumValues: ["custom", "anthropic", "anthropic_example", "plugin"],
    }),
    f("latestVersionId", "Latest Version", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("skillId", "Skill ID", {
      description:
        'Value to pass as `skill_id` in a Messages request\'s `container.skills`, e.g. `{"type":"custom","skill_id":…,"version":"latest"}`.',
    }),
    o("latestVersionId", "Latest Version ID"),
  ],
  supportsCreate: false,
  supportsDelete: true,
  iconKey: "function",
});
