import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CodeBuildProjectResourceType: ResourceTypeDefinition = {
  id: "codebuild-project",
  displayName: "CodeBuild Project",
  pluralDisplayName: "CodeBuild Projects",
  description: "An AWS CodeBuild build project",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "sourceType", label: "Source Type", kind: "string", required: false },
    { key: "environment", label: "Environment", kind: "string", required: false },
    { key: "computeType", label: "Compute Type", kind: "string", required: false },
    { key: "lastBuildStatus", label: "Last Build", kind: "string", required: false },
    { key: "badge", label: "Badge Enabled", kind: "boolean", required: false },
  ],
  outputs: [{ key: "projectArn", label: "Project ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "build",
};
