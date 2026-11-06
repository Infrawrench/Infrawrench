import { f, rt } from "@infrawrench/plugin-base";

export const CloudDeployPipelineResourceType = rt({
  name: "Cloud Deploy Pipeline",
  id: "cloud-deploy-pipeline",
  iconKey: "pipeline",
  description: "A Google Cloud Deploy continuous delivery pipeline",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true, required: false }),
    f("description", "Description", { required: false }),
    f("stageCount", "Stages", { showcase: true, kind: "number", required: false }),
    f("stages", "Stage Names", { required: false }),
  ],
  outputs: [],
});
