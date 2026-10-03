import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A permission from the Authorization API. Roles and API keys are granted
 * permissions by slug. System permissions are managed by WorkOS.
 * Docs: https://workos.com/docs/reference/roles/permission
 */
export const PermissionResourceType = rt({
  name: "Permission",
  id: "permission",
  description:
    "A permission that roles and API keys grant by slug, such as `widgets:read`. System permissions are managed by WorkOS and cannot be deleted.",
  fields: [
    f("slug", "Slug", { editable: false }),
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("system", "System", { kind: "boolean", required: false, editable: false }),
    f("resourceTypeSlug", "Resource type", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("permissionSlug", "Permission Slug")],
  pinnable: false,
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});
