import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PipelineResourceType: ResourceTypeDefinition = {
  id: "databricks-pipeline",
  displayName: "Pipeline",
  pluralDisplayName: "Pipelines",
  description: "A Databricks Delta Live Tables pipeline",
  fields: [
    { key: "pipelineId", label: "Pipeline ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["IDLE", "RUNNING", "STOPPING", "FAILED", "DELETED", "RESETTING"],
    },
    { key: "creatorUserName", label: "Creator", kind: "string", required: false },
    { key: "target", label: "Target Schema", kind: "string", required: false },
    { key: "catalog", label: "Catalog", kind: "string", required: false },
    { key: "channel", label: "Channel", kind: "string", required: false },
    { key: "continuous", label: "Continuous", kind: "boolean", required: false },
    { key: "photon", label: "Photon", kind: "boolean", required: false },
    { key: "lastUpdateState", label: "Last Update", kind: "string", required: false },
  ],
  outputs: [
    { key: "pipelineId", label: "Pipeline ID", sensitive: false },
    { key: "pipelineUrl", label: "Pipeline URL", sensitive: false },
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
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "pipeline",
};
