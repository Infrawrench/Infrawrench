import { f, o, rt } from "@infrawrench/plugin-base";

export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A model this account runs: owned, deployed, trained into, or invoked by a recent prediction",
  // `PATCH /v1/models/{owner}/{name}` accepts description, github_url,
  // paper_url, license_url, weights_url and readme; everything else is
  // identity or server-computed.
  fields: [
    f("owner", "Owner", { editable: false }),
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("visibility", "Visibility", { required: false, editable: false }),
    f("isOfficial", "Official", { kind: "boolean", required: false, editable: false }),
    f("runCount", "Run Count", { kind: "number", required: false, editable: false }),
    f("latestVersion", "Latest Version", { required: false, editable: false }),
    f("cogVersion", "Cog Version", { required: false, editable: false }),
    f("githubUrl", "GitHub", { required: false }),
    f("paperUrl", "Paper", { required: false }),
    f("licenseUrl", "License", { required: false }),
    f("weightsUrl", "Weights", {
      required: false,
      description:
        "Where the model's weights are published. Write-only: Replicate accepts it but does not return it on the model object.",
    }),
    f("coverImageUrl", "Cover Image", { required: false, editable: false }),
    f("modelUrl", "Model URL", { required: false, editable: false }),
  ],
  outputs: [
    o("modelRef", "Model Reference", { description: "`owner/name`, what you pass as `model`" }),
    o("latestVersion", "Latest Version ID"),
    o("modelUrl", "Model URL"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  // Replicate only deletes private models you own that have no versions left.
  supportsDelete: true,
  iconKey: "model",
});
