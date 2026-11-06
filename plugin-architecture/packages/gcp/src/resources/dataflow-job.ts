import { f, rt } from "@infrawrench/plugin-base";

export const DataflowJobResourceType = rt({
  name: "Dataflow Job",
  pinnable: false,
  id: "dataflow-job",
  iconKey: "pipeline",
  description: "A Google Cloud Dataflow streaming or batch job",
  fields: [
    f("name", "Name"),
    f("region", "Region", { showcase: true }),
    f("type", "Job Type", { showcase: true, required: false }),
    f("state", "State", { showcase: true, required: false }),
    f("sdkVersion", "SDK Version", { required: false }),
  ],
  outputs: [],
  supportsMetrics: true,
});
