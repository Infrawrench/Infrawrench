import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET /v1/organization/projects/{project_id}/api_keys` and
 * `DELETE …/api_keys/{api_key_id}` — verified 2026-07-29 against openapi.yaml
 * v2.3.0 (`list-project-api-keys`, `delete-project-api-key`).
 *
 * There is deliberately no create path: the API exposes no way to mint a
 * user-owned project key. The only key the API will create is a service
 * account's, which is offered as a credential format on the Project itself.
 * Deleting a key that belongs to a service account is rejected with a 400 —
 * remove the service account instead.
 */
export const ProjectApiKeyResourceType = rt({
  name: "Project API Key",
  plural: "Project API Keys",
  id: "project-api-key",
  description:
    "An API key scoped to a project. Keys can be listed and revoked through the API but never created — see the project's 'Get credentials' action for service-account keys. Requires an Admin API key.",
  fields: [
    f("name", "Name", { required: false }),
    f("redactedValue", "Key", { required: false }),
    f("projectId", "Project ID"),
    f("projectName", "Project", { required: false }),
    f("ownerType", "Owner Type", {
      kind: "enum",
      enumValues: ["user", "service_account"],
      required: false,
    }),
    f("ownerName", "Owner", { required: false }),
    f("ownerProjectAccess", "Owner Access", {
      kind: "enum",
      enumValues: ["active", "inactive"],
      required: false,
    }),
    f("createdAt", "Created", { required: false }),
    f("lastUsedAt", "Last Used", { required: false }),
  ],
  outputs: [
    o("apiKeyId", "API Key ID"),
    o("redactedValue", "Redacted Value", {
      description: "Masked key value — the full secret is only ever shown at creation time",
    }),
    o("projectId", "Project ID"),
  ],
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "key",
  supportsCreate: false,
  supportsDelete: true,
});
