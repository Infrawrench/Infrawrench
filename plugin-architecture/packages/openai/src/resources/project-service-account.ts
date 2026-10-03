import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET/POST /v1/organization/projects/{project_id}/service_accounts`,
 * `POST/DELETE …/service_accounts/{id}` and
 * `POST …/service_accounts/{id}/api_keys`: verified 2026-10-03 against
 * openapi.yaml (`list-project-service-accounts`,
 * `update-project-service-account`, `delete-project-service-account`,
 * `CreateanAPIkeyforaserviceaccount`). Admin key only.
 *
 * Creating one hands back its first API key exactly once, so creation stays
 * on the project's "Get credentials" action. Further keys are minted from
 * the service account's own "Get credentials".
 */
export const ProjectServiceAccountResourceType = rt({
  name: "Project Service Account",
  plural: "Project Service Accounts",
  id: "project-service-account",
  description:
    "A non-human identity inside a project that owns its own API keys. Rename it, change its role, mint another key, or delete it (which revokes its keys). Requires an Admin API key.",
  fields: [
    f("name", "Name"),
    f("role", "Project Role", { kind: "enum", enumValues: ["member", "owner", "none"] }),
    f("projectId", "Project ID", { editable: false }),
    f("projectName", "Project", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("serviceAccountId", "Service Account ID"), o("projectId", "Project ID")],
  principalRole: {
    role: "service-account",
    createdKey: "createdAt",
    adminIndicatorKey: "role",
    adminValues: ["owner"],
  },
  parentTypeId: "project",
  showInSidebar: true,
  iconKey: "account",
  supportsCreate: false,
  supportsUpdate: true,
  supportsDelete: true,
  credentialFormats: [
    {
      id: "service-account-api-key",
      label: "New API Key",
      description:
        "Mints another API key for this service account. The secret is shown once and cannot be read back.",
      mediaType: "text",
      filenameTemplate: "openai-{resource}-api-key.txt",
    },
  ],
});
