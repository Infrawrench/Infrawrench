import { f, rt } from "@infrawrench/plugin-base";

export const LogpushJobResourceType = rt({
  name: "Logpush Job",
  pinnable: false,
  id: "logpush-job",
  description: "A Cloudflare Logpush job for streaming logs to a destination",
  fields: [
    f("name", "Name", { required: false, editable: false }),
    f("enabled", "Enabled", { kind: "boolean" }),
    f("dataset", "Dataset", { editable: false }),
    f("destinationType", "Destination Type", { required: false, editable: false }),
    f("frequency", "Frequency", { required: false }),
    f("logpullOptions", "Logpull Options", { required: false }),
    f("lastComplete", "Last Complete", { required: false, editable: false }),
    f("lastError", "Last Error", { required: false, editable: false }),
    f("zoneName", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneName", targetTypeId: "zone", targetKey: "name", label: "in zone" }],
  parentTypeId: "zone",
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "logs",
});
