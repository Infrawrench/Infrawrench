import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A hosted skill: a `SKILL.md` bundle uploaded once and attached to requests
 * by id. Name and description come from the bundle's frontmatter, so there is
 * nothing to edit in place; a new version means a new upload.
 *
 * Upload is a multipart zip (`POST /v1/skills`), which the create form cannot
 * carry, so this type lists and deletes.
 *
 * Docs: https://docs.x.ai/openapi.json
 * (GET /v1/skills with `limit`/`after`/`order`, GET/DELETE /v1/skills/{skill_id})
 */
export const SkillResourceType = rt({
  name: "Skill",
  id: "skill",
  description:
    "A hosted skill bundle (SKILL.md plus files) that requests can reference by id. Uploaded from your own code; listed and deleted here.",
  fields: [
    f("skillId", "Skill ID", { editable: false }),
    f("name", "Name", { required: false, editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("defaultVersion", "Default Version", { required: false, editable: false }),
    f("latestVersion", "Latest Version", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("skillId", "Skill ID"), o("name", "Skill Name")],
  supportsDelete: true,
  iconKey: "code",
});
