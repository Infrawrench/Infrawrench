import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const OpenSearchClusterResourceType: ResourceTypeDefinition = {
  id: "opensearch-cluster",
  displayName: "OpenSearch Cluster",
  pluralDisplayName: "OpenSearch Clusters",
  description:
    "An OpenSearch (or Elasticsearch-compatible) cluster — browse indices, run searches, manage snapshots",
  fields: [
    { key: "endpoint", label: "Endpoint", kind: "string", required: true },
    { key: "version", label: "Version", kind: "string", required: false },
    { key: "clusterName", label: "Cluster Name", kind: "string", required: false },
    { key: "distribution", label: "Distribution", kind: "string", required: false },
    { key: "status", label: "Health", kind: "string", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint", sensitive: false },
    { key: "clusterName", label: "Cluster Name", sensitive: false },
    { key: "version", label: "Version", sensitive: false },
  ],
  dashboardPinnable: true,
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
};
