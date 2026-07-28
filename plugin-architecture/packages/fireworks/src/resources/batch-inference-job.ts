import { f, o, rt } from "@infrawrench/plugin-base";

export const BatchInferenceJobResourceType = rt({
  name: "Batch Inference Job",
  id: "batch-inference-job",
  description: "An offline batch inference run over an input dataset",
  fields: [
    f("displayName", "Display Name"),
    f("jobId", "Job ID"),
    f("state", "State", { required: false }),
    f("statusMessage", "Status Message", { required: false }),
    f("model", "Model", { required: false }),
    f("inputDatasetId", "Input Dataset", { required: false }),
    f("outputDatasetId", "Output Dataset", { required: false }),
    f("progressPercent", "Progress (%)", { kind: "number", required: false }),
    f("totalInputRequests", "Input Requests", { kind: "number", required: false }),
    f("successfullyProcessedRequests", "Succeeded", { kind: "number", required: false }),
    f("failedRequests", "Failed", { kind: "number", required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createTime", "Created", { required: false }),
    f("runStartTime", "Started", { required: false }),
    f("endTime", "Ended", { required: false }),
    f("expireTime", "Deadline", { required: false }),
  ],
  outputs: [o("jobName", "Job Resource Name"), o("outputDatasetId", "Output Dataset ID")],
  iconKey: "queue",
});
