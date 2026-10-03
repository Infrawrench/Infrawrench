import { f, o, rt } from "@infrawrench/plugin-base";

export const WAREHOUSE_SIZES = [
  "2X-Small",
  "X-Small",
  "Small",
  "Medium",
  "Large",
  "X-Large",
  "2X-Large",
  "3X-Large",
  "4X-Large",
  "5X-Large",
];

export const SqlWarehouseResourceType = rt({
  name: "SQL Warehouse",
  id: "databricks-sql-warehouse",
  description: "A Databricks SQL compute endpoint for running SQL queries",
  fields: [
    f("warehouseId", "Warehouse ID", { editable: false }),
    f("name", "Name"),
    f("state", "State", {
      kind: "enum",
      editable: false,
      enumValues: ["STARTING", "RUNNING", "STOPPING", "STOPPED", "DELETING", "DELETED"],
    }),
    f("clusterSize", "Cluster Size", {
      kind: "enum",
      enumValues: WAREHOUSE_SIZES,
      required: false,
    }),
    f("minNumClusters", "Min Clusters", {
      kind: "number",
      required: false,
      description: "At least 1 and no more than Max Clusters (up to 30).",
    }),
    f("maxNumClusters", "Max Clusters", {
      kind: "number",
      required: false,
      description: "Upper bound for scaling out under concurrency, up to 40.",
    }),
    f("autoStopMinutes", "Auto-stop (min)", {
      kind: "number",
      required: false,
      description:
        "Idle minutes before the warehouse stops. 0 disables; otherwise at least 10 (serverless allows 5).",
    }),
    f("warehouseType", "Type", { required: false, editable: false }),
    f("enableServerlessCompute", "Serverless", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("enablePhoton", "Photon Enabled", { kind: "boolean", required: false }),
    f("spotInstancePolicy", "Spot Policy", {
      kind: "enum",
      enumValues: ["COST_OPTIMIZED", "RELIABILITY_OPTIMIZED"],
      required: false,
      description: "Classic and pro warehouses only.",
    }),
    f("channel", "Channel", { required: false, editable: false }),
    f("health", "Health", { required: false, editable: false }),
    f("numActiveSessions", "Active Sessions", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("numClusters", "Running Clusters", { kind: "number", required: false, editable: false }),
    f("creatorName", "Creator", { required: false, editable: false }),
  ],
  outputs: [
    o("warehouseId", "Warehouse ID"),
    o("jdbcUrl", "JDBC URL"),
    o("odbcUrl", "ODBC URL"),
    o("httpPath", "HTTP Path", { description: "HTTP path for the SQL Connector / JDBC driver" }),
    o("serverHostname", "Server Hostname", {
      description: "Workspace hostname for the SQL Connector",
    }),
  ],
  // Sleep/wake schedules: POST /api/2.0/sql/warehouses/{id}/start and /stop.
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["RUNNING", "STARTING"],
    stoppedValues: ["STOPPED", "STOPPING"],
  },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "database",
  resourceSqlDriver: {
    driver: "databricks",
    connectionStringOutputKey: "warehouseId",
  },
  secretExportTemplates: [
    {
      id: "databricks-sql",
      displayName: "Databricks SQL Connector",
      description:
        "Environment variables for databricks-sql-connector / JDBC. Pair with a Databricks PAT.",
      entries: [
        { envKey: "DATABRICKS_HOST", outputKey: "serverHostname" },
        { envKey: "DATABRICKS_HTTP_PATH", outputKey: "httpPath" },
        { envKey: "DATABRICKS_WAREHOUSE_ID", outputKey: "warehouseId" },
      ],
    },
  ],
});
