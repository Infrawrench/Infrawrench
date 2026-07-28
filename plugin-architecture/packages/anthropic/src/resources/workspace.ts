import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A Console workspace — the unit API keys, files, batches and rate limits are
 * scoped to. Admin-key only.
 *
 * ⚠️ Archiving is destructive and one-way: it immediately revokes every API
 * key in the workspace and there is no unarchive endpoint. That is why this
 * type sets `supportsDelete: false` — the client exposes archiving as an
 * explicit, confirm-guarded header action instead of a plain delete button.
 * The Default Workspace has no ID and never appears in the list response.
 *
 * Docs: https://platform.claude.com/docs/en/api/admin-api/workspaces/list-workspaces
 */
export const WorkspaceResourceType = rt({
  name: "Workspace",
  id: "workspace",
  description:
    "A Console workspace that scopes API keys, files, batches and rate limits. Requires an Admin API key. Archiving is irreversible and revokes every key in the workspace.",
  fields: [
    f("name", "Name"),
    f("displayColor", "Display Color", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("archivedAt", "Archived", { required: false, editable: false }),
    f("workspaceGeo", "Workspace Geo", { required: false, editable: false }),
    f("defaultInferenceGeo", "Default Inference Geo", { required: false, editable: false }),
    f("allowedInferenceGeos", "Allowed Inference Geos", { required: false, editable: false }),
    f("externalKeyId", "CMEK Key ID", { required: false, editable: false }),
    f("tags", "Tags", { required: false, editable: false }),
  ],
  outputs: [o("workspaceId", "Workspace ID"), o("workspaceName", "Workspace Name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "project",
});
