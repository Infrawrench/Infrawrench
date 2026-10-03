import { f, o, rt } from "@infrawrench/plugin-base";

export const AnalyticsEngineDatasetResourceType = rt({
  name: "Analytics Engine Dataset",
  id: "analytics-engine-dataset",
  description:
    "A Workers Analytics Engine dataset: time-series data points written by a Worker binding, queried with SQL",
  fields: [f("name", "Name")],
  outputs: [o("datasetName", "Dataset Name")],
  supportsDelete: false,
  supportsMetrics: true,
  supportsRestQuery: true,
  iconKey: "logs",
  secretExportTemplates: [
    {
      id: "analytics-engine-binding",
      displayName: "Analytics Engine Binding",
      description: "Dataset name for a wrangler `[[analytics_engine_datasets]]` binding",
      entries: [{ envKey: "ANALYTICS_ENGINE_DATASET", outputKey: "datasetName" }],
    },
  ],
});
