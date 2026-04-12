import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ServiceResourceType: ResourceTypeDefinition = {
  id: "ch-service",
  displayName: "Service",
  pluralDisplayName: "Services",
  description: "A ClickHouse Cloud service — a managed ClickHouse database instance",
  fields: [
    { key: "serviceId", label: "Service ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["running", "idle", "stopped", "starting", "stopping", "provisioning"],
    },
    { key: "provider", label: "Cloud Provider", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "clickhouseVersion", label: "ClickHouse Version", kind: "string", required: false },
    { key: "tier", label: "Tier", kind: "string", required: false },
    {
      key: "minReplicaMemoryGb",
      label: "Min Replica Memory (GB)",
      kind: "number",
      required: false,
    },
    {
      key: "maxReplicaMemoryGb",
      label: "Max Replica Memory (GB)",
      kind: "number",
      required: false,
    },
    { key: "numReplicas", label: "Replicas", kind: "number", required: false },
    { key: "idleScaling", label: "Idle Scaling", kind: "boolean", required: false },
    { key: "idleTimeoutMinutes", label: "Idle Timeout (min)", kind: "number", required: false },
    { key: "isPrimary", label: "Primary", kind: "boolean", required: false },
    { key: "isReadonly", label: "Read-only", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "serviceId", label: "Service ID", sensitive: false },
    { key: "host", label: "Host", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "nativePort", label: "Native Port", sensitive: false },
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "httpUrl", label: "HTTP URL", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  resourceSqlDriver: {
    driver: "clickhouse",
    connectionStringOutputKey: "connectionString",
  },
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "HTTP Connection URL",
      description: "ClickHouse HTTPS endpoint for HTTP interface queries",
      entries: [{ envKey: "CLICKHOUSE_URL", outputKey: "httpUrl" }],
    },
    {
      id: "host-port",
      displayName: "Host + Port",
      description: "ClickHouse host and native protocol port",
      entries: [
        { envKey: "CLICKHOUSE_HOST", outputKey: "host" },
        { envKey: "CLICKHOUSE_PORT", outputKey: "nativePort" },
      ],
    },
  ],
};
