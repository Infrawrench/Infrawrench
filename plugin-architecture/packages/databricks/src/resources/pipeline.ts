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
    f("schema", "Schema", {
      required: false,
      description: "Unity Catalog schema this pipeline publishes to (spec.schema)",
    }),
    f("catalog", "Catalog", { required: false }),
    f("channel", "Channel", { required: false }),
    f("continuous", "Continuous", { kind: "boolean", required: false }),
    f("photon", "Photon", { kind: "boolean", required: false }),
    f("lastUpdateState", "Last Update", { required: false }),
  ],
  outputs: [o("pipelineId", "Pipeline ID"), o("pipelineUrl", "Pipeline URL")],
  // `target` and `schema` both hold a bare schema name while a schema's
  // external id is `catalog.schema`; composing with the pipeline's own
  // `catalog` makes each exact. Only one of the two is ever set, and the
  // template yields nothing for the empty one.
  dependsOn: [
    { fieldKey: "catalog", targetTypeId: "databricks-catalog", label: "publishes to catalog" },
    {
      fieldKey: "target",
      targetTypeId: "databricks-schema",
      matchTemplate: "{catalog}.{target}",
      label: "publishes to schema",
    },
    {
      fieldKey: "schema",
      targetTypeId: "databricks-schema",
      matchTemplate: "{catalog}.{schema}",
      label: "publishes to schema",
    },
  ],
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
