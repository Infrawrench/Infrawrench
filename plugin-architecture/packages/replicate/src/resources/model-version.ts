import { f, o, rt } from "@infrawrench/plugin-base";

export const ModelVersionResourceType = rt({
  name: "Model Version",
  id: "model-version",
  description:
    "One pushed version of a model this account owns, with the Cog version it was built with",
  fields: [
    f("versionId", "Version ID", { editable: false }),
    f("model", "Model", { editable: false }),
    f("cogVersion", "Cog Version", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("isLatest", "Latest", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [
    o("versionId", "Version ID", { description: "What you pass as `version` to a deployment" }),
    o("versionRef", "Version Reference", { description: "`owner/name:version`" }),
  ],
  dependsOn: [{ fieldKey: "model", targetTypeId: "model", label: "version of" }],
  parentTypeId: "model",
  showInSidebar: true,
  // `DELETE /v1/models/{owner}/{name}/versions/{id}`: private models only,
  // and Replicate refuses while a deployment, training or someone else's
  // prediction still uses the version.
  supportsDelete: true,
  pinnable: false,
  iconKey: "model",
});
