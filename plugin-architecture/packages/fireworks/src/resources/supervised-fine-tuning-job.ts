import { f, o, rt } from "@infrawrench/plugin-base";

export const SupervisedFineTuningJobResourceType = rt({
  name: "Fine-Tuning Job",
  id: "supervised-fine-tuning-job",
  description: "A supervised fine-tuning run that produces a LoRA add-on or a full model",
  fields: [
    f("displayName", "Display Name"),
    f("jobId", "Job ID"),
    f("state", "State", { required: false }),
    f("statusMessage", "Status Message", { required: false }),
    f("baseModel", "Base Model", { required: false }),
    f("dataset", "Dataset", { required: false }),
    f("evaluationDataset", "Evaluation Dataset", { required: false }),
    f("outputModel", "Output Model", { required: false }),
    f("epochs", "Epochs", { kind: "number", required: false }),
    f("learningRate", "Learning Rate", { kind: "number", required: false }),
    f("loraRank", "LoRA Rank", { kind: "number", required: false }),
    f("batchSizeSamples", "Batch Size", { kind: "number", required: false }),
    f("progressPercent", "Progress (%)", { kind: "number", required: false }),
    f("estimatedCost", "Estimated Cost (USD)", { kind: "number", required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createTime", "Created", { required: false }),
    f("completedTime", "Completed", { required: false }),
  ],
  outputs: [o("jobName", "Job Resource Name"), o("outputModel", "Output Model Name")],
  iconKey: "pipeline",
});
