import { f, o, rt } from "@infrawrench/plugin-base";

export const BasinPipelineResourceType = rt({
  name: "Basin Pipeline",
  id: "basin-pipeline",
  description:
    "A Cloudflare Basin Pipelines SQL pipeline that reads a stream, transforms it with SQL, and writes to a sink",
  fields: [
    f("name", "Name"),
    f("status", "Status", { showcase: true, required: false }),
    f("streams", "Source Streams", { required: false }),
    f("sinks", "Destination Sinks", { required: false }),
    f("sql", "SQL", { required: false }),
    f("failureReason", "Failure Reason", { required: false }),
    f("createdAt", "Created", { showcase: true, required: false }),
    f("modifiedAt", "Modified", { showcase: true, required: false }),
  ],
  outputs: [o("pipelineId", "Pipeline ID"), o("pipelineName", "Pipeline Name")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "queue",
});
