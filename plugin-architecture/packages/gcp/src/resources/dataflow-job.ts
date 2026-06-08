import { f, o, rt } from "@infrawrench/plugin-base";

export const DataflowJobResourceType = rt({
  name: "Dataflow Job",
  pinnable: false,
  id: "dataflow-job",
  description: "A Google Cloud Dataflow streaming or batch job",
  fields: [
    f("name", "Name"),
    f("region", "Region"),
    f("type", "Job Type", { required: false }),
    f("state", "State", { required: false }),
    f("sdkVersion", "SDK Version", { required: false }),
  ],
  outputs: [],
});
