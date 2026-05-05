import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DocumentDBClusterResourceType: ResourceTypeDefinition = {
  id: "documentdb-cluster",
  displayName: "DocumentDB Cluster",
  pluralDisplayName: "DocumentDB Clusters",
  description: "An Amazon DocumentDB MongoDB-compatible database cluster",
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
    { key: "masterUsername", label: "Master Username", sensitive: false },
    { key: "clusterArn", label: "Cluster ARN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  secretExportTemplates: [
    {
      id: "documentdb-connection",
      displayName: "DocumentDB Connection",
      description: "Connection details for this DocumentDB cluster",
      entries: [
        { envKey: "DOCDB_HOST", outputKey: "endpoint" },
        { envKey: "DOCDB_READER_HOST", outputKey: "readerEndpoint" },
        { envKey: "DOCDB_PORT", outputKey: "port" },
        { envKey: "DOCDB_USER", outputKey: "masterUsername" },
      ],
    },
  ],
};
