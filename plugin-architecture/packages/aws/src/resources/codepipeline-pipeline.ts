import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CodePipelinePipelineResourceType: ResourceTypeDefinition = {
  id: "codepipeline-pipeline",
  displayName: "CodePipeline",
  pluralDisplayName: "CodePipelines",
  description: "An AWS CodePipeline CI/CD pipeline",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "stageCount", label: "Stages", kind: "number", required: false },
    { key: "version", label: "Version", kind: "number", required: false },
    { key: "createdAt", label: "Created", kind: "string", required: false },
    { key: "updatedAt", label: "Updated", kind: "string", required: false },
    { key: "pipelineType", label: "Type", kind: "string", required: false },
  ],
  outputs: [{ key: "pipelineArn", label: "Pipeline ARN", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "pipeline",
};
