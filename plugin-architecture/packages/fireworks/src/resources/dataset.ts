import { f, o, rt } from "@infrawrench/plugin-base";

export const DatasetResourceType = rt({
  name: "Dataset",
  id: "dataset",
  description: "A JSONL dataset uploaded for fine-tuning, evaluation or batch inference",
  fields: [
    f("displayName", "Display Name"),
    f("datasetId", "Dataset ID"),
    f("state", "State", { required: false }),
    f("statusMessage", "Status Message", { required: false }),
    f("exampleCount", "Examples", { kind: "number", required: false }),
    f("estimatedTokenCount", "Estimated Tokens", { kind: "number", required: false }),
    f("averageTurnCount", "Average Turns", { kind: "number", required: false }),
    f("format", "Format", { required: false }),
    f("source", "Source", { required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createTime", "Created", { required: false }),
  ],
  outputs: [o("datasetName", "Dataset Resource Name"), o("datasetId", "Dataset ID")],
  iconKey: "storage",
});
