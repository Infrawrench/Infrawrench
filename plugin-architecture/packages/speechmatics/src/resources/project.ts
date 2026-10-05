import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Speechmatics workspace project.
 *
 * Verified against the Management API reference
 * (https://docs.speechmatics.com/api-ref/management/get-all-projects): the
 * embedded OpenAPI operations declare `GET/POST /projects` and
 * `GET/PUT/DELETE /projects/{project_id}` on server
 * `https://mp.speechmatics.com/v1`, returning
 * `{project_id, name, description, is_default, is_active, created_at, deleted_at}`.
 * `PUT` accepts only `name`, so that is the one editable field.
 */
export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "A project in your Speechmatics workspace: the boundary for API keys, transcripts and usage. Managed with a management token, not the batch API key.",
  fields: [
    f("projectId", "Project ID", { editable: false }),
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false, editable: false }),
    f("isDefault", "Default Project", { kind: "boolean", required: false, editable: false }),
    f("isActive", "Active", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("projectId", "Project ID"), o("projectName", "Project Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "project",
});
