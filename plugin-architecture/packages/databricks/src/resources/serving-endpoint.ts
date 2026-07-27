import { f, rt } from "@infrawrench/plugin-base";

export const ServingEndpointResourceType = rt({
  name: "Model Serving Endpoint",
  id: "databricks-serving-endpoint",
  description: "A Databricks Model Serving endpoint for real-time model inference",
  fields: [
    f("name", "Name"),
    f("state", "State", { kind: "enum", enumValues: ["READY", "NOT_READY", "UNKNOWN"] }),
    f("task", "Task", { required: false }),
    f("creator", "Creator", { required: false }),
  ],
  outputs: [],
  attachTargets: [
    {
      pluginId: "databricks",
      resourceTypeId: "databricks-model-version",
      verb: "Serve model version",
    },
  ],
  iconKey: "compute",
});
