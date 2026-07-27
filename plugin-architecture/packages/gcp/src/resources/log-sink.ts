import { f, rt } from "@infrawrench/plugin-base";

export const LogSinkResourceType = rt({
  name: "Log Sink",
  pinnable: false,
  id: "log-sink",
  description: "A Google Cloud Logging sink (log router)",
  fields: [
    f("name", "Name"),
    f("destination", "Destination", { required: false }),
    f("filter", "Filter", { required: false }),
    f("disabled", "Disabled", { kind: "boolean", required: false }),
    f("writerIdentity", "Writer Identity", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
