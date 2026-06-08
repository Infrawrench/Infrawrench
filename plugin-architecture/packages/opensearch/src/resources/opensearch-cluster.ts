import { f, o, rt } from "@infrawrench/plugin-base";

export const OpenSearchClusterResourceType = rt({
  name: "OpenSearch Cluster",
  id: "opensearch-cluster",
  description:
    "An OpenSearch (or Elasticsearch-compatible) cluster — browse indices, run searches, manage snapshots",
  fields: [
    f("endpoint", "Endpoint"),
    f("version", "Version", { required: false }),
    f("clusterName", "Cluster Name", { required: false }),
    f("distribution", "Distribution", { required: false }),
    f("status", "Health", { required: false }),
  ],
  outputs: [o("endpoint", "Endpoint"), o("clusterName", "Cluster Name"), o("version", "Version")],
  supportsMetrics: true,
  iconKey: "search",
  secretExportTemplates: [
    {
      id: "opensearch-endpoint",
      displayName: "OpenSearch Endpoint + Basic Auth",
      description:
        "Endpoint URL plus basic-auth credentials for clients that prefer separate env vars.",
      entries: [{ envKey: "OPENSEARCH_URL", outputKey: "endpoint" }],
    },
  ],
});
