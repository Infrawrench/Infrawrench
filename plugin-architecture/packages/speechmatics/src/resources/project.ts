import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Speechmatics workspace project.
 *
 * Verified against the Management API reference
 * (https://docs.speechmatics.com/api-ref/management/get-all-projects) — the
 * embedded OpenAPI operation declares `GET /projects` on server
 * `https://mp.api.speechmatics.com/v1`, returning an array of
 * `{project_id, name, description, is_default, is_active, created_at, deleted_at}`.
 */
export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A project in your Speechmatics workspace — the isolation boundary for API keys, transcripts and usage. Listed through the Management API, which lives on a different host (https://mp.api.speechmatics.com/v1) and needs a management token rather than the batch API key.",
  fields: [
    f("projectId", "Project ID"),
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("isDefault", "Default Project", { kind: "boolean", required: false }),
    f("isActive", "Active", { kind: "boolean", required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("projectId", "Project ID"), o("projectName", "Project Name")],
  iconKey: "project",
});
