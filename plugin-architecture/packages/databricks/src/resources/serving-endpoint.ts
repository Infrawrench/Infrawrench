import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ServingEndpointResourceType: ResourceTypeDefinition = {
  id: "databricks-serving-endpoint",
  displayName: "Model Serving Endpoint",
  pluralDisplayName: "Model Serving Endpoints",
  description: "A Databricks Model Serving endpoint for real-time model inference",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["READY", "NOT_READY", "UNKNOWN"],
    },
    { key: "task", label: "Task", kind: "string", required: false },
    { key: "creator", label: "Creator", kind: "string", required: false },
  ],
  outputs: [],
  attachTargets: [
    {
      pluginId: "databricks",
      resourceTypeId: "databricks-model-version",
      verb: "Serve model version",
    },
  ],
  dashboardPinnable: true,
  iconKey: "compute",
};
