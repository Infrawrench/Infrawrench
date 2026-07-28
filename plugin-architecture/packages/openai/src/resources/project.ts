import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/organization/projects`, `POST /v1/organization/projects/{id}`,
 * `POST /v1/organization/projects/{id}/archive` — verified 2026-07-29 against
 * openapi.yaml v2.3.0 (`list-projects`, `create-project`, `modify-project`,
 * `archive-project`).
 *
 * Admin plane: every one of these is declared `security: AdminApiKeyAuth`, so a
 * project key (`sk-`/`sk-proj-`) gets a flat 403. Projects cannot be deleted,
 * only archived — hence `supportsDelete: false` plus an Archive header action.
 */
export const ProjectResourceType = rt({
  name: "Project",
  id: "project",
  description:
    "An organization project — the billing and rate-limit boundary that API keys, members and usage are attributed to. Requires an Admin API key.",
  fields: [
    f("name", "Name"),
    f("status", "Status", { kind: "enum", enumValues: ["active", "archived"], required: false }),
    f("createdAt", "Created", { required: false }),
    f("archivedAt", "Archived", { required: false }),
  ],
  outputs: [
    o("projectId", "Project ID", { description: "`proj_…` id used by the usage and cost APIs" }),
    o("projectName", "Project Name"),
  ],
  iconKey: "project",
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  credentialFormats: [
    {
      id: "service-account-key",
      label: "Service Account API Key",
      description:
        "Creates a service account in this project and returns its API key. Project keys owned by a user cannot be created through the API — only service-account keys can.",
      mediaType: "text",
      filenameTemplate: "openai-{resource}-service-account-key.txt",
    },
  ],
});
