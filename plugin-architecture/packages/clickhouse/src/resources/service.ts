import { f, o, rt } from "@infrawrench/plugin-base";

export const ServiceResourceType = rt({
  name: "Service",
  id: "ch-service",
  description: "A ClickHouse Cloud service — a managed ClickHouse database instance",
  fields: [
    f("serviceId", "Service ID"),
    f("name", "Name"),
    f("state", "State", {
      kind: "enum",
      enumValues: ["running", "idle", "stopped", "starting", "stopping", "provisioning"],
    }),
    f("provider", "Cloud Provider", { required: false }),
    f("region", "Region", { required: false }),
    f("clickhouseVersion", "ClickHouse Version", { required: false }),
    f("tier", "Tier", { required: false }),
    f("minReplicaMemoryGb", "Min Replica Memory (GB)", { kind: "number", required: false }),
    f("maxReplicaMemoryGb", "Max Replica Memory (GB)", { kind: "number", required: false }),
    f("numReplicas", "Replicas", { kind: "number", required: false }),
    f("idleScaling", "Idle Scaling", { kind: "boolean", required: false }),
    f("idleTimeoutMinutes", "Idle Timeout (min)", { kind: "number", required: false }),
    f("isPrimary", "Primary", { kind: "boolean", required: false }),
    f("isReadonly", "Read-only", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("serviceId", "Service ID"),
    o("host", "Host"),
    o("port", "Port"),
    o("nativePort", "Native Port"),
    o("connectionString", "Connection String", { sensitive: true }),
    o("httpUrl", "HTTP URL"),
  ],
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
});
