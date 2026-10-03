import { f, o, rt } from "@infrawrench/plugin-base";

export const BasinStreamResourceType = rt({
  name: "Basin Stream",
  id: "basin-stream",
  description:
    "A Cloudflare Basin Pipelines stream: a durable buffer that ingests events over HTTP or a Worker binding",
  fields: [
    f("name", "Name", { editable: false }),
    f("endpoint", "HTTP Endpoint", { required: false, editable: false }),
    f("httpEnabled", "HTTP Ingest", { kind: "boolean", required: false }),
    f("httpAuthentication", "Require Token on HTTP Ingest", {
      kind: "boolean",
      required: false,
    }),
    f("corsOrigins", "CORS Origins", {
      required: false,
      description: "Comma-separated browser origins allowed to POST to the endpoint",
    }),
    f("workerBinding", "Worker Binding", { kind: "boolean", required: false }),
    f("format", "Format", { required: false, editable: false }),
    f("schema", "Schema", { required: false, editable: false }),
    f("schemaFieldCount", "Schema Fields", { kind: "number", required: false, editable: false }),
    f("version", "Version", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("modifiedAt", "Modified", { required: false, editable: false }),
  ],
  outputs: [
    o("streamId", "Stream ID"),
    o("streamName", "Stream Name"),
    o("endpoint", "HTTP Endpoint", { description: "POST JSON events here" }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "queue",
  secretExportTemplates: [
    {
      id: "pipeline-stream-binding",
      displayName: "Stream Binding",
      description: "Stream ID for a wrangler `[[pipelines]]` binding (`stream = ...`)",
      entries: [{ envKey: "PIPELINE_STREAM_ID", outputKey: "streamId" }],
    },
    {
      id: "pipeline-stream-endpoint",
      displayName: "HTTP Ingest Endpoint",
      description: "The stream's HTTP endpoint for posting events",
      entries: [{ envKey: "PIPELINE_ENDPOINT", outputKey: "endpoint" }],
    },
  ],
});
