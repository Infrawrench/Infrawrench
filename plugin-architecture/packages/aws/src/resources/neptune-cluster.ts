import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NeptuneClusterResourceType: ResourceTypeDefinition = {
  id: "neptune-cluster",
  displayName: "Neptune Cluster",
  pluralDisplayName: "Neptune Clusters",
  description: "An Amazon Neptune graph database cluster",
  fields: [
    { key: "clusterIdentifier", label: "Cluster ID", kind: "string", required: true },
    { key: "engine", label: "Engine", kind: "string", required: true },
    { key: "engineVersion", label: "Engine Version", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "storageEncrypted", label: "Encrypted", kind: "boolean", required: false },
    { key: "multiAZ", label: "Multi-AZ", kind: "boolean", required: false },
    { key: "dbClusterMembers", label: "Members", kind: "number", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Writer Endpoint", sensitive: false },
    { key: "readerEndpoint", label: "Reader Endpoint", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "clusterArn", label: "Cluster ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "neptune-connection",
      displayName: "Neptune Connection",
      description: "Connection details for this Neptune cluster",
      entries: [
        { envKey: "NEPTUNE_ENDPOINT", outputKey: "endpoint" },
        { envKey: "NEPTUNE_READER_ENDPOINT", outputKey: "readerEndpoint" },
        { envKey: "NEPTUNE_PORT", outputKey: "port" },
      ],
    },
  ],
};
