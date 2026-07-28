import { f, o, rt } from "@infrawrench/plugin-base";

export const ModelResourceType = rt({
  name: "Model",
  id: "model",
  description:
    "A model this account runs — owned, deployed, trained into, or invoked by a recent prediction",
  fields: [
    f("owner", "Owner"),
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("visibility", "Visibility", { required: false }),
    f("isOfficial", "Official", { kind: "boolean", required: false }),
    f("runCount", "Run Count", { kind: "number", required: false }),
    f("latestVersion", "Latest Version", { required: false }),
    f("cogVersion", "Cog Version", { required: false }),
    f("githubUrl", "GitHub", { required: false }),
    f("paperUrl", "Paper", { required: false }),
    f("licenseUrl", "License", { required: false }),
    f("coverImageUrl", "Cover Image", { required: false }),
    f("modelUrl", "Model URL", { required: false }),
  ],
  outputs: [
    o("modelRef", "Model Reference", { description: "`owner/name`, what you pass as `model`" }),
    o("latestVersion", "Latest Version ID"),
    o("modelUrl", "Model URL"),
  ],
  supportsDelete: false,
  iconKey: "model",
});
