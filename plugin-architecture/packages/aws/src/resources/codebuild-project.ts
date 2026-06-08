import { f, o, rt } from "@infrawrench/plugin-base";

export const CodeBuildProjectResourceType = rt({
  name: "CodeBuild Project",
  id: "codebuild-project",
  description: "An AWS CodeBuild build project",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("sourceType", "Source Type", { required: false }),
    f("environment", "Environment", { required: false }),
    f("computeType", "Compute Type", { required: false }),
    f("lastBuildStatus", "Last Build", { required: false }),
    f("badge", "Badge Enabled", { kind: "boolean", required: false }),
  ],
  outputs: [o("projectArn", "Project ARN")],
  iconKey: "build",
  supportsCreate: true,
  supportsMetrics: true,
});
