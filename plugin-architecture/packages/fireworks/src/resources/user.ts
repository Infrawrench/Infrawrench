import { f, o, rt } from "@infrawrench/plugin-base";

/** Roles documented on `gatewayUser.role`. */
export const USER_ROLES = ["admin", "user", "contributor", "inference-user", "custom"];

export const UserResourceType = rt({
  name: "User",
  id: "user",
  description: "A member or service account of this Fireworks account, with its role",
  fields: [
    f("displayName", "Display Name", { required: false }),
    f("userId", "User ID", { editable: false }),
    f("email", "Email", { required: false, editable: false }),
    f("role", "Role", {
      kind: "enum",
      enumValues: USER_ROLES,
      required: false,
      description:
        "admin, user, contributor or inference-user; custom defers to the permission preset.",
    }),
    f("permissionPreset", "Permission Preset", {
      required: false,
      description: "Only used when the role is custom.",
    }),
    f("serviceAccount", "Service Account", { kind: "boolean", required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("createTime", "Created", { required: false, editable: false }),
    f("updateTime", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("userName", "User Resource Name"), o("email", "Email")],
  supportsCreate: true,
  supportsUpdate: true,
  // The API has no delete-user route; members are removed in the dashboard.
  supportsDelete: false,
  iconKey: "user",
});
