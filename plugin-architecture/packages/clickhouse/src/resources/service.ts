import { f, o, rt } from "@infrawrench/plugin-base";

export const ServiceResourceType = rt({
  name: "Service",
  id: "ch-service",
  description: "A managed ClickHouse Cloud service",
  fields: [
    f("serviceId", "Service ID", { editable: false }),
    f("name", "Name", { description: "Up to 50 characters, letters, digits and spaces." }),
    f("state", "State", {
      kind: "enum",
      editable: false,
      enumValues: [
        "running",
        "idle",
        "stopped",
        "starting",
        "stopping",
        "awaking",
        "partially_running",
        "provisioning",
        "degraded",
        "failed",
        "terminating",
        "terminated",
        "softdeleting",
        "softdeleted",
      ],
    }),
    f("provider", "Cloud Provider", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("clickhouseVersion", "ClickHouse Version", { required: false, editable: false }),
    f("tier", "Tier", { required: false, editable: false }),
    f("releaseChannel", "Release Channel", {
      kind: "enum",
      enumValues: ["slow", "default", "fast"],
      required: false,
      description:
        "fast gets new ClickHouse releases first; slow defers upgrades. Changing to or from slow is plan-dependent.",
    }),
    f("autoscalingMode", "Autoscaling Mode", {
      kind: "enum",
      enumValues: ["vertical", "horizontal"],
      required: false,
      description:
        "vertical keeps a fixed replica count and scales memory per replica; horizontal keeps memory fixed and scales the replica count between the min and max.",
    }),
    f("minReplicaMemoryGb", "Min Replica Memory (GB)", {
      kind: "number",
      required: false,
      description: "Multiple of 4, at least 8.",
    }),
    f("maxReplicaMemoryGb", "Max Replica Memory (GB)", {
      kind: "number",
      required: false,
      description: "Multiple of 4.",
    }),
    f("numReplicas", "Replicas", {
      kind: "number",
      required: false,
      description: "Fixed replica count, used in vertical autoscaling.",
    }),
    f("minReplicas", "Min Replicas", {
      kind: "number",
      required: false,
      description: "Lower bound of the replica band in horizontal autoscaling.",
    }),
    f("maxReplicas", "Max Replicas", {
      kind: "number",
      required: false,
      description: "Upper bound of the replica band in horizontal autoscaling.",
    }),
    f("idleScaling", "Idle Scaling", { kind: "boolean", required: false }),
    f("idleTimeoutMinutes", "Idle Timeout (min)", {
      kind: "number",
      required: false,
      description: "Minimum idle time before the service scales to zero. At least 5.",
    }),
    f("ipAccessList", "IP Access List", {
      required: false,
      description:
        "Comma-separated IPs or CIDRs allowed to connect, e.g. 203.0.113.0/24. 0.0.0.0/0 allows anywhere.",
    }),
    f("openToInternet", "Open to Internet", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "True when the IP access list contains 0.0.0.0/0.",
    }),
    f("isPrimary", "Primary", { kind: "boolean", required: false, editable: false }),
    f("isReadonly", "Read-only", { kind: "boolean", required: false, editable: false }),
    f("dataWarehouseId", "Warehouse ID", { required: false, editable: false }),
    f("complianceType", "Compliance", { required: false, editable: false }),
    f("profile", "Instance Profile", { required: false, editable: false }),
  ],
  outputs: [
    o("serviceId", "Service ID"),
    o("host", "Host"),
    o("port", "Port"),
    o("nativePort", "Native Port"),
    o("connectionString", "Connection String", { sensitive: true }),
    o("httpUrl", "HTTP URL"),
    o("mysqlHost", "MySQL Interface Host", {
      description: "Present only when the MySQL interface is enabled on the service.",
    }),
  ],
  iconKey: "database",
  // Sleep/wake schedules: PATCH …/services/{id}/state with command start /
  // stop. "idle" counts as running: it is auto-idled compute that wakes on
  // demand, and ClickHouse Cloud accepts a stop from it.
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["running", "idle", "partially_running", "awaking"],
    stoppedValues: ["stopped", "stopping"],
  },
  // ClickHouse Cloud always takes automated backups (the schedule is
  // configurable, not optional), and the listed backups attribute back here.
  backupPolicy: { protectedBy: ["ch-backup"] },
  postureChecks: [
    {
      id: "ch-service-open-to-internet",
      title: "Service accepts connections from any IP",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "openToInternet", when: "truthy" }],
      reason:
        "The IP access list contains 0.0.0.0/0, so the service endpoint is reachable from the whole internet and only the password stands in the way. Edit the service and list the addresses that need access instead.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
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
