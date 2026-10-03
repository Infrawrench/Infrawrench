import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A ClickPipe: managed ingestion into a ClickHouse Cloud service from Kafka,
 * object storage, Kinesis, Pub/Sub, or CDC from Postgres / MySQL / MongoDB /
 * BigQuery. Creating one needs source credentials and a column mapping, which
 * the ClickHouse console walks through; Infrawrench lists, scales, starts,
 * stops, resyncs and deletes them.
 */
export const ClickPipeResourceType = rt({
  name: "ClickPipe",
  id: "ch-clickpipe",
  description: "A ClickPipes ingestion pipeline feeding a ClickHouse Cloud service",
  fields: [
    f("clickPipeId", "ClickPipe ID", { editable: false }),
    f("serviceId", "Service ID", { editable: false }),
    f("name", "Name"),
    f("state", "State", {
      kind: "enum",
      editable: false,
      enumValues: [
        "Unknown",
        "Provisioning",
        "Running",
        "Degraded",
        "Stopping",
        "Stopped",
        "Failed",
        "Completed",
        "InternalError",
        "Setup",
        "Snapshot",
        "Paused",
        "Pausing",
        "Modifying",
        "Resync",
      ],
    }),
    f("sourceType", "Source", { required: false, editable: false }),
    f("destinationDatabase", "Destination Database", { required: false, editable: false }),
    f("destinationTable", "Destination Table", { required: false, editable: false }),
    f("replicas", "Replicas", {
      kind: "number",
      required: false,
      description: "Ingestion replicas. Applies to streaming pipes (Kafka, Kinesis, Pub/Sub).",
    }),
    f("concurrency", "Concurrency", {
      kind: "number",
      required: false,
      description: "Parallel file loads for object storage pipes. 0 auto-scales with the service.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("clickPipeId", "ClickPipe ID")],
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "ch-service", label: "ingests into" }],
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["Running", "Provisioning", "Setup", "Snapshot", "Degraded", "Resync"],
    stoppedValues: ["Stopped", "Stopping", "Paused", "Pausing"],
  },
  parentTypeId: "ch-service",
  showInSidebar: true,
  supportsUpdate: true,
  iconKey: "pipeline",
});
