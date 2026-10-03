import { f, o, rt } from "@infrawrench/plugin-base";

export const AppSecretResourceType = rt({
  name: "Secret",
  pinnable: false,
  id: "app-secret",
  description: "An app secret, exposed to the app's Machines as an environment variable",
  parentTypeId: "app",
  fields: [
    f("name", "Name", { editable: false }),
    f("appName", "App", { editable: false }),
    f("value", "Value", {
      kind: "password",
      required: false,
      description:
        "New secret value. Leave blank to keep the current one. Machines pick it up on their next restart or deploy.",
    }),
    f("digest", "Digest", { required: false, editable: false }),
    f("createdAt", "Created At", { required: false, editable: false }),
    f("updatedAt", "Updated At", { required: false, editable: false }),
  ],
  outputs: [o("secretName", "Secret Name")],
  dependsOn: [{ fieldKey: "appName", targetTypeId: "app", label: "in app" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "secret",
});
