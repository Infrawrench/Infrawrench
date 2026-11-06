import { f, o, rt } from "@infrawrench/plugin-base";

export const CodePipelinePipelineResourceType = rt({
  name: "CodePipeline",
  id: "codepipeline-pipeline",
  description: "An AWS CodePipeline CI/CD pipeline",
  fields: [
    f("name", "Name"),
    f("stageCount", "Stages", { showcase: true, kind: "number", required: false }),
    f("version", "Version", { showcase: true, kind: "number", required: false }),
    f("createdAt", "Created", { showcase: true, required: false }),
    f("updatedAt", "Updated", { required: false }),
    f("pipelineType", "Type", { required: false }),
  ],
  outputs: [o("pipelineArn", "Pipeline ARN")],
  iconKey: "pipeline",
});
