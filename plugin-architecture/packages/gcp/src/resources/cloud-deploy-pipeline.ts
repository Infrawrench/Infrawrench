import { f, rt } from "@infrawrench/plugin-base";

export const CloudDeployPipelineResourceType = rt({
  name: "Cloud Deploy Pipeline",
  id: "cloud-deploy-pipeline",
  description: "A Google Cloud Deploy continuous delivery pipeline",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("description", "Description", { required: false }),
    f("stageCount", "Stages", { kind: "number", required: false }),
    f("stages", "Stage Names", { required: false }),
  ],
  outputs: [],
});
