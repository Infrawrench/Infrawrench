import { f, o, rt } from "@infrawrench/plugin-base";

export const PipelineResourceType = rt({
  name: "Pipeline",
  id: "databricks-pipeline",
  description: "A Databricks Delta Live Tables pipeline",
  fields: [
    f("pipelineId", "Pipeline ID"),
    f("name", "Name"),
    f("state", "State", {
      kind: "enum",
      enumValues: ["IDLE", "RUNNING", "STOPPING", "FAILED", "DELETED", "RESETTING"],
    }),
    f("creatorUserName", "Creator", { required: false }),
    f("target", "Target Schema", { required: false }),
    f("catalog", "Catalog", { required: false }),
    f("channel", "Channel", { required: false }),
    f("continuous", "Continuous", { kind: "boolean", required: false }),
    f("photon", "Photon", { kind: "boolean", required: false }),
    f("lastUpdateState", "Last Update", { required: false }),
  ],
  outputs: [o("pipelineId", "Pipeline ID"), o("pipelineUrl", "Pipeline URL")],
  attachTargets: [
    {
      pluginId: "databricks",
      resourceTypeId: "databricks-catalog",
      verb: "Publish to catalog",
    },
    {
      pluginId: "databricks",
      resourceTypeId: "databricks-schema",
      verb: "Publish to schema",
    },
  ],
  supportsCreate: true,
  iconKey: "pipeline",
});
